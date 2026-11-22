-- Rolls back migration 039 (late Race and Sprint predictions): restores the previous lock, windows view, submit, scoring and admin
-- preview functions, then removes the helpers. Run it only when no Race or Sprint prediction has been saved in the late period you
-- want to keep: such an entry would simply stop being treated as late (and counts at full value again).
-- The view is re-created with its original six columns, so it is dropped first (nothing else depends on the two new columns).

begin;

create or replace function public.is_prediction_locked(p_session_id text)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select coalesce((
    select l.start_utc is not null and now() >= l.start_utc
    from public.sessions s
    join public.sessions l
      on l.event_id = s.event_id
     and l.session_type = case s.session_type
                            when 'race'   then 'qualifying'
                            when 'sprint' then 'sprint_qualifying'
                            else s.session_type
                          end
    where s.id = p_session_id
  ), false);
$$;

drop view if exists public.prediction_windows;
create or replace view public.prediction_windows
with (security_invoker = true) as
select
  s.id           as session_id,
  s.event_id     as event_id,
  s.session_type as target_type,
  l.id           as lock_session_id,
  l.start_utc    as lock_at,
  (l.start_utc is not null and now() < l.start_utc and e.status = 'scheduled') as is_open
from public.sessions s
join public.events e on e.id = s.event_id
join public.sessions l
  on l.event_id = s.event_id
 and l.session_type = case s.session_type
                        when 'race'   then 'qualifying'
                        when 'sprint' then 'sprint_qualifying'
                        else s.session_type
                      end;
revoke all on public.prediction_windows from anon, authenticated;
grant select on public.prediction_windows to anon, authenticated;

create or replace function public.submit_prediction(p_session_id text, p_picks jsonb)
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_user    uuid := auth.uid();
  v_type    text;
  v_season  integer;
  v_status  text;
  v_lock    timestamptz;
  v_id      uuid;
  v_use     boolean;
  v_line    text[];
  v_stand   jsonb;
  v_old     jsonb;
  v_own     jsonb;
begin
  if v_user is null then
    raise exception 'You must be signed in' using errcode = '28000';
  end if;

  if not exists (select 1 from public.group_members where user_id = v_user) then
    raise exception 'Join the friends group before predicting' using errcode = '42501';
  end if;

  select s.session_type, e.season, e.status, l.start_utc
    into v_type, v_season, v_status, v_lock
  from public.sessions s
  join public.events e on e.id = s.event_id
  left join public.sessions l
    on l.event_id = s.event_id
   and l.session_type = case s.session_type
                          when 'race'   then 'qualifying'
                          when 'sprint' then 'sprint_qualifying'
                          else s.session_type
                        end
  where s.id = p_session_id;

  if v_type is null then
    raise exception 'Unknown session' using errcode = '22023';
  end if;

  if v_status <> 'scheduled' or v_lock is null or now() >= v_lock then
    raise exception 'Predictions are closed for this session' using errcode = '55000';
  end if;

  -- Effective lineup, and the withdrawn drivers THIS player already saved for this session (read here, never from the client).
  select ls.o_use, ls.o_lineup, ls.o_stand_ins into v_use, v_line, v_stand
  from public.session_lineup_state(p_session_id) as ls;

  select pr.picks into v_old
  from public.predictions pr
  where pr.user_id = v_user and pr.session_id = p_session_id;

  v_own := coalesce((
    select jsonb_object_agg(k.key, k.value)
    from jsonb_each_text(v_stand) as k
    where k.key = any (public.picks_driver_ids(v_old))), '{}'::jsonb);

  perform public.validate_session_data(
    v_type, p_picks, v_season, false,
    case when v_use then v_line end,
    case when v_use then v_own end);

  insert into public.predictions (user_id, session_id, picks)
  values (v_user, p_session_id, p_picks)
  on conflict (user_id, session_id) do update
    set picks = excluded.picks, updated_at = now()
  returning id into v_id;

  return v_id;
end;
$function$;

create or replace function public.recalculate_scores(p_session_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.scores where session_id = p_session_id;

  insert into public.scores (user_id, session_id, result_id, points, breakdown)
  select p.user_id, p.session_id, r.id, (c.j ->> 'total')::integer, c.j
  from public.predictions p
  join public.sessions s on s.id = p.session_id
  join public.results r on r.session_id = p.session_id and r.status = 'approved'
  cross join lateral (
    select public.calc_points(s.session_type, p.picks, r.data) as j
  ) c
  where p.session_id = p_session_id;
end;
$$;

create or replace function public.rescore_prediction(p_user uuid, p_session text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_points integer;
begin
  insert into public.scores (user_id, session_id, result_id, points, breakdown)
  select p.user_id, p.session_id, r.id, (c.j ->> 'total')::integer, c.j
  from public.predictions p
  join public.sessions s on s.id = p.session_id
  join public.results r on r.session_id = p.session_id and r.status = 'approved'
  cross join lateral (
    select public.calc_points(s.session_type, p.picks, r.data) as j
  ) c
  where p.user_id = p_user and p.session_id = p_session
  on conflict (user_id, session_id) do update
    set result_id = excluded.result_id,
        points = excluded.points,
        breakdown = excluded.breakdown,
        computed_at = now()
  returning points into v_points;

  return v_points;
end;
$$;

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

drop function if exists public.lo_score(text, jsonb, jsonb, timestamptz);
drop function if exists public.lo_is_late(text, timestamptz);
drop function if exists public.lo_late_from(text);
drop function if exists public.lo_late_factor();

commit;
