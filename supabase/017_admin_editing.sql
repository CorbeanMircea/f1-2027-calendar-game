  -- 017: Admin editing of results, manual entry, score preview, pending count.

-- 1) Remember which source data each result was based on (so edits are not overwritten).
alter table public.results add column if not exists api_snapshot jsonb;
update public.results set api_snapshot = data where source like 'jolpica%' and api_snapshot is null;

create function public.results_set_snapshot()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.api_snapshot is null and new.source like 'jolpica%' then
    new.api_snapshot := new.data;
  end if;
  return new;
end;
$$;

create trigger results_set_snapshot
  before insert on public.results
  for each row execute function public.results_set_snapshot();

-- 2) The overview, now with seasons, score previews, approver names and missing results.
create or replace function public.admin_overview()
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'pending', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.entered_at)
      from (
        select r.id, r.session_id, r.version, r.source, r.entered_at, r.data,
               e.name as event_name, e.season, s.session_type,
               public.is_prediction_locked(r.session_id) as locked,
               (select count(*) from public.predictions pr where pr.session_id = r.session_id) as predictions,
               (select jsonb_build_object('version', a.version, 'data', a.data)
                  from public.results a
                 where a.session_id = r.session_id and a.status = 'approved') as approved,
               (select coalesce(jsonb_agg(jsonb_build_object(
                          'name', pf.display_name,
                          'points', (public.calc_points(s.session_type, pr2.picks, r.data) ->> 'total')::integer)
                        order by pf.display_name), '[]'::jsonb)
                  from public.predictions pr2
                  join public.profiles pf on pf.id = pr2.user_id
                 where pr2.session_id = r.session_id) as preview
        from public.results r
        join public.sessions s on s.id = r.session_id
        join public.events e on e.id = s.event_id
        where r.status = 'pending'
      ) p
    ), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(to_jsonb(q) order by q.approved_at desc)
      from (
        select r.id, r.session_id, r.version, r.source, r.approved_at, r.data,
               e.name as event_name, e.season, s.session_type,
               (select pf.display_name from public.profiles pf where pf.id = r.approved_by) as approved_by_name
        from public.results r
        join public.sessions s on s.id = r.session_id
        join public.events e on e.id = s.event_id
        where r.status = 'approved'
        order by r.approved_at desc nulls last
        limit 10
      ) q
    ), '[]'::jsonb),
    'missing', coalesce((
      select jsonb_agg(to_jsonb(m) order by m.start_date desc, m.session_type)
      from (
        select s.id as session_id, e.name as event_name, e.season, e.start_date, s.session_type
        from public.sessions s
        join public.events e on e.id = s.event_id
        where public.is_prediction_locked(s.id)
          and e.end_date >= current_date - 30
          and not exists (
            select 1 from public.results r
            where r.session_id = s.id and r.status in ('pending', 'approved')
          )
        order by e.start_date desc, s.session_type
        limit 20
      ) m
    ), '[]'::jsonb),
    'log', coalesce((
      select jsonb_agg(to_jsonb(l) order by l.created_at desc)
      from (
        select created_at, event_id, session_type, action, detail
        from public.import_log
        order by created_at desc
        limit 30
      ) l
    ), '[]'::jsonb)
  );
end;
$$;

-- 3) Edit a pending or approved result: saves a NEW pending version (nothing is lost).
create function public.admin_save_result_edit(p_result_id uuid, p_data jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session   text;
  v_status    text;
  v_snapshot  jsonb;
  v_type      text;
  v_season    integer;
  v_version   integer;
  v_id        uuid;
begin
  if not public.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;

  select r.session_id, r.status, coalesce(r.api_snapshot, r.data)
    into v_session, v_status, v_snapshot
  from public.results r
  where r.id = p_result_id;

  if v_session is null then
    raise exception 'Result not found';
  end if;
  if v_status not in ('pending', 'approved') then
    raise exception 'Only pending or approved results can be edited';
  end if;

  select s.session_type, e.season into v_type, v_season
  from public.sessions s
  join public.events e on e.id = s.event_id
  where s.id = v_session;

  perform public.validate_session_data(v_type, p_data, v_season, true);

  select coalesce(max(version), 0) + 1 into v_version
  from public.results where session_id = v_session;

  insert into public.results (session_id, version, status, data, source, api_snapshot)
  values (v_session, v_version, 'pending', p_data, 'manual-edit', v_snapshot)
  returning id into v_id;

  -- A pending result that was edited is replaced by the edited version.
  if v_status = 'pending' then
    update public.results set status = 'superseded' where id = p_result_id;
  end if;

  return v_id;
end;
$$;

-- 4) Enter a result by hand for a session that has none yet.
create function public.admin_enter_manual_result(p_session_id text, p_data jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type     text;
  v_season   integer;
  v_version  integer;
  v_id       uuid;
begin
  if not public.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;

  select s.session_type, e.season into v_type, v_season
  from public.sessions s
  join public.events e on e.id = s.event_id
  where s.id = p_session_id;

  if v_type is null then
    raise exception 'Unknown session';
  end if;
  if exists (
    select 1 from public.results
    where session_id = p_session_id and status in ('pending', 'approved')
  ) then
    raise exception 'A result already exists for this session; edit it instead';
  end if;

  perform public.validate_session_data(v_type, p_data, v_season, true);

  select coalesce(max(version), 0) + 1 into v_version
  from public.results where session_id = p_session_id;

  insert into public.results (session_id, version, status, data, source)
  values (p_session_id, v_version, 'pending', p_data, 'manual')
  returning id into v_id;

  return v_id;
end;
$$;

-- 5) How many results are waiting (for the badge on the home page).
create function public.admin_pending_count()
returns integer
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  return (select count(*)::integer from public.results where status = 'pending');
end;
$$;

-- 6) Privileges
revoke all on function public.admin_save_result_edit(uuid, jsonb)        from public, anon;
revoke all on function public.admin_enter_manual_result(text, jsonb)     from public, anon;
revoke all on function public.admin_pending_count()                      from public, anon;
grant execute on function public.admin_save_result_edit(uuid, jsonb)     to authenticated;
grant execute on function public.admin_enter_manual_result(text, jsonb)  to authenticated;
grant execute on function public.admin_pending_count()                   to authenticated;
