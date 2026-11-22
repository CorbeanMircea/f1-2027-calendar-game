-- 039: late Race and Sprint predictions.
--
-- THE RULE
--   * Qualifying and Sprint Qualifying predictions close when that session starts (unchanged).
--   * Race and Sprint predictions now stay open until THEIR OWN start (they used to close at Qualifying / Sprint Qualifying).
--   * A Race or Sprint prediction that is saved or changed after Qualifying (Race) or Sprint Qualifying (Sprint) has started is a
--     LATE ENTRY and counts at 70% of its points, rounded down. One that was saved before and not changed keeps full value.
--     Saving identical picks again is not a change.
--   * Everyone's picks for a session become visible when THAT session starts (Qualifying at Qualifying, Race at the Race, ...).
--
-- WHAT CHANGES
--   lo_late_factor()      the factor (0.7): change it here, in one place
--   lo_is_late()          is this prediction a late entry?
--   lo_score()            calc_points with the late factor applied (breakdown gets late, late_factor, raw_total)
--   is_prediction_locked  every session locks at its own start (this also moves the reveal)
--   prediction_windows    lock_at is now the session's own start; new columns full_value_until and is_late
--   submit_prediction     closes at the session's own start; saving identical picks is a no-op
--   recalculate_scores, rescore_prediction, admin_overview   use lo_score
-- Existing scores are not touched (no prediction has ever been changed after those moments, so none would be late).
-- Corrections by an admin keep the player's own created_at / updated_at, so they never turn an entry late.
-- Rollback: supabase/maintenance/rollback_039_late_entries.sql  (it restores the previous functions and view).

begin;

create or replace function public.lo_late_factor()
returns numeric
language sql
immutable
as $$ select 0.7::numeric $$;

-- The moment after which a Race / Sprint prediction counts as late: the start of Qualifying / Sprint Qualifying of the same weekend.
create or replace function public.lo_late_from(p_session_id text)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select l.start_utc
  from public.sessions s
  join public.sessions l
    on l.event_id = s.event_id
   and l.session_type = case s.session_type when 'race' then 'qualifying' when 'sprint' then 'sprint_qualifying' end
  where s.id = p_session_id
$$;

create or replace function public.lo_is_late(p_session_id text, p_updated_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(p_updated_at >= public.lo_late_from(p_session_id), false)
$$;

create or replace function public.lo_score(p_session_id text, p_picks jsonb, p_actual jsonb, p_updated_at timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_type text;
  v_j    jsonb;
  v_raw  integer;
begin
  select s.session_type into v_type from public.sessions s where s.id = p_session_id;
  v_j := public.calc_points(v_type, p_picks, p_actual);

  if public.lo_is_late(p_session_id, p_updated_at) then
    v_raw := (v_j ->> 'total')::integer;
    v_j := v_j || jsonb_build_object(
      'total', floor(v_raw * public.lo_late_factor())::integer,
      'raw_total', v_raw,
      'late', true,
      'late_factor', public.lo_late_factor());
  end if;
  return v_j;
end;
$$;

revoke all on function public.lo_late_factor()                              from public, anon, authenticated;
revoke all on function public.lo_late_from(text)                            from public, anon, authenticated;
revoke all on function public.lo_is_late(text, timestamptz)                 from public, anon, authenticated;
revoke all on function public.lo_score(text, jsonb, jsonb, timestamptz)     from public, anon, authenticated;
grant execute on function public.lo_late_factor()                           to service_role;
grant execute on function public.lo_late_from(text)                         to service_role;
grant execute on function public.lo_is_late(text, timestamptz)              to service_role;
grant execute on function public.lo_score(text, jsonb, jsonb, timestamptz)  to service_role;

-- Every session closes (and reveals) at its own start.
create or replace function public.is_prediction_locked(p_session_id text)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select coalesce((
    select s.start_utc is not null and now() >= s.start_utc
    from public.sessions s
    where s.id = p_session_id
  ), false);
$$;

-- The windows view keeps its first six columns and adds two: until when a Race / Sprint prediction has full value, and whether the
-- session is currently in its late period. (lock_session_id / lock_at now describe the session itself.)
create or replace view public.prediction_windows
with (security_invoker = true) as
select
  s.id           as session_id,
  s.event_id     as event_id,
  s.session_type as target_type,
  s.id           as lock_session_id,
  s.start_utc    as lock_at,
  (s.start_utc is not null and now() < s.start_utc and e.status = 'scheduled') as is_open,
  l.start_utc    as full_value_until,
  (s.start_utc is not null and now() < s.start_utc and e.status = 'scheduled'
     and l.start_utc is not null and now() >= l.start_utc) as is_late
from public.sessions s
join public.events e on e.id = s.event_id
left join public.sessions l
  on l.event_id = s.event_id
 and l.session_type = case s.session_type when 'race' then 'qualifying' when 'sprint' then 'sprint_qualifying' end;

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

  -- Every session closes at its own start. (Race and Sprint predictions used to close earlier, at Qualifying and Sprint
  -- Qualifying; they now stay open, and a prediction saved or changed after that earlier moment counts at a reduced value.)
  select s.session_type, e.season, e.status, s.start_utc
    into v_type, v_season, v_status, v_lock
  from public.sessions s
  join public.events e on e.id = s.event_id
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

  -- Saving the same picks again changes nothing (in particular it does not move updated_at, which decides whether a Race or
  -- Sprint prediction counts as a late entry).
  insert into public.predictions (user_id, session_id, picks)
  values (v_user, p_session_id, p_picks)
  on conflict (user_id, session_id) do update
    set picks = excluded.picks, updated_at = now()
    where public.predictions.picks is distinct from excluded.picks
  returning id into v_id;

  if v_id is null then
    select pr.id into v_id from public.predictions pr where pr.user_id = v_user and pr.session_id = p_session_id;
  end if;

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
    select public.lo_score(p.session_id, p.picks, r.data, p.updated_at) as j
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
    select public.lo_score(p.session_id, p.picks, r.data, p.updated_at) as j
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
                          'points', (public.lo_score(pr2.session_id, pr2.picks, r.data, pr2.updated_at) ->> 'total')::integer)
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

-- Permissions: the new helpers are internal; the changed player/admin functions keep theirs.
do $$
declare
  v_bad text := '';
  r record;
begin
  for r in
    select p.oid::regprocedure::text as fn
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('lo_late_factor', 'lo_late_from', 'lo_is_late', 'lo_score')
      and (has_function_privilege('anon', p.oid, 'EXECUTE')
           or has_function_privilege('authenticated', p.oid, 'EXECUTE')
           or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                      where a.grantee = 0 and a.privilege_type = 'EXECUTE'))
  loop
    v_bad := v_bad || r.fn || '; ';
  end loop;
  if v_bad <> '' then
    raise exception 'Unexpected EXECUTE rights (anon, authenticated or PUBLIC) on: %', v_bad;
  end if;

  for r in
    select p.oid::regprocedure::text as fn
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('submit_prediction', 'admin_overview')
      and (not has_function_privilege('authenticated', p.oid, 'EXECUTE')
           or has_function_privilege('anon', p.oid, 'EXECUTE')
           or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                      where a.grantee = 0 and a.privilege_type = 'EXECUTE'))
  loop
    v_bad := v_bad || r.fn || '; ';
  end loop;
  if v_bad <> '' then
    raise exception 'Unexpected function permissions on: %', v_bad;
  end if;
end;
$$;

commit;
