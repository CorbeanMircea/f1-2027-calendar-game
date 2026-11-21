-- 038: facts for the Admin "Weekend check" tab (read-only).
--
-- admin_weekend_check(p_event_id) gathers, in one call, everything the checklist needs about one race weekend: its sessions and
-- start times, predictions per session, drivers and their results-API ids, the lineup (substitutions in force), grid penalties in
-- force, players and reminder devices, the importer's latest log rows and the scheduled jobs, the season picks window, and past
-- sessions that still have no approved result. The page turns these facts into ok / warning / problem lines.
--
-- Writes nothing. Admins only (is_admin()). With no event given it takes the current weekend, or else the next one.
-- Rollback: supabase/maintenance/rollback_038_admin_weekend_check.sql

begin;

create or replace function public.admin_weekend_check(p_event_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ev        public.events%rowtype;
  v_sessions  jsonb;
  v_drivers   jsonb;
  v_subs      jsonb;
  v_pens      jsonb;
  v_players   jsonb;
  v_import    jsonb;
  v_cron      jsonb;
  v_season    jsonb;
  v_pending   jsonb;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can run the weekend check' using errcode = '42501';
  end if;

  if p_event_id is null then
    select * into v_ev from public.events e
    where e.season < 9000 and e.end_date >= current_date - 1
    order by e.start_date limit 1;
    if v_ev.id is null then
      select * into v_ev from public.events e where e.season < 9000 order by e.start_date desc limit 1;
    end if;
  else
    select * into v_ev from public.events e where e.id = p_event_id;
  end if;
  if v_ev.id is null then
    raise exception 'Unknown event' using errcode = '22023';
  end if;

  -- sessions of the weekend
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id,
           'type', s.session_type,
           'start_utc', s.start_utc,
           'predictions', (select count(*) from public.predictions p where p.session_id = s.id),
           'approved', exists (select 1 from public.results r where r.session_id = s.id and r.status = 'approved'),
           'pending', exists (select 1 from public.results r where r.session_id = s.id and r.status = 'pending'),
           'lineup', (select cardinality(l.o_lineup) from public.session_lineup_state(s.id) l),
           'stand_ins', (select count(*) from public.session_lineup_state(s.id) l, jsonb_object_keys(l.o_stand_ins) k)
         ) order by s.start_utc nulls last, s.id), '[]'::jsonb)
  into v_sessions
  from public.sessions s where s.event_id = v_ev.id;

  -- the season's drivers
  select jsonb_build_object(
           'total', count(*),
           'active', count(*) filter (where d.is_active),
           'missing_api_id', coalesce(jsonb_agg(d.code order by d.code) filter (where d.is_active and d.external_id is null), '[]'::jsonb))
  into v_drivers
  from public.drivers d where d.season = v_ev.season;

  -- substitutions still in force for this weekend (at least one session where the latest action is "apply")
  select coalesce(jsonb_agg(x.item order by x.at), '[]'::jsonb)
  into v_subs
  from (
    select ds.registered_at as at,
           jsonb_build_object(
             'id', ds.id,
             'out', od.code, 'in', ind.code,
             'registered_at', ds.registered_at,
             'sessions', (
               select jsonb_agg(l.session_type order by l.session_type)
               from (
                 select distinct on (dss.session_id) dss.session_id, dss.action, se.session_type
                 from public.driver_substitution_sessions dss
                 join public.sessions se on se.id = dss.session_id
                 where dss.substitution_id = ds.id
                 order by dss.session_id, dss.seq desc
               ) l where l.action = 'apply')) as item
    from public.driver_substitutions ds
    join public.drivers od on od.id = ds.out_driver_id
    join public.drivers ind on ind.id = ds.in_driver_id
    where ds.event_id = v_ev.id
  ) x
  where x.item -> 'sessions' is not null and x.item ->> 'sessions' <> 'null';

  -- grid penalties in force (not revoked)
  select coalesce(jsonb_agg(jsonb_build_object(
           'session', se.session_type, 'driver', d.code, 'penalty_type', p.penalty_type, 'places', p.places,
           'reason', p.reason, 'registered_at', p.registered_at) order by p.registered_at), '[]'::jsonb)
  into v_pens
  from public.grid_penalties p
  join public.sessions se on se.id = p.session_id
  join public.drivers d on d.id = p.driver_id
  where se.event_id = v_ev.id and p.entry_type = 'penalty'
    and not exists (select 1 from public.grid_penalties x where x.revokes_id = p.id);

  -- players and reminder devices
  select jsonb_build_object(
           'members', (select count(*) from public.group_members),
           'devices', (select count(*) from public.push_subscriptions),
           'players_with_devices', (select count(distinct ps.user_id) from public.push_subscriptions ps),
           'predicted_this_weekend', (select count(distinct p.user_id) from public.predictions p
                                       join public.sessions se on se.id = p.session_id where se.event_id = v_ev.id))
  into v_players;

  -- the importer's latest log rows for this weekend
  select jsonb_build_object(
           'last_log_at', (select max(l.created_at) from public.import_log l),
           'errors_24h', (select count(*) from public.import_log l
                           where l.event_id = v_ev.id and l.action = 'error' and l.created_at > now() - interval '24 hours'),
           'recent', coalesce((select jsonb_agg(jsonb_build_object('at', r.created_at, 'session', r.session_type, 'action', r.action, 'detail', r.detail)
                                              order by r.created_at desc)
                                 from (select * from public.import_log l where l.event_id = v_ev.id order by l.created_at desc limit 6) r), '[]'::jsonb))
  into v_import;

  -- scheduled jobs (not available on every setup: then the page says so)
  begin
    select coalesce(jsonb_agg(jsonb_build_object(
             'name', j.jobname, 'schedule', j.schedule, 'active', j.active,
             'last_run', (select max(d.start_time) from cron.job_run_details d where d.jobid = j.jobid),
             'last_status', (select d.status from cron.job_run_details d where d.jobid = j.jobid order by d.start_time desc limit 1)
           ) order by j.jobname), '[]'::jsonb)
    into v_cron from cron.job j;
  exception when others then
    v_cron := null;
  end;

  -- the season picks window
  select jsonb_build_object(
           'season', v_ev.season,
           'lock_at', w.lock_at, 'late_lock_at', w.late_lock_at,
           'drivers_loaded', w.drivers_loaded, 'is_open', w.is_open, 'late_open', w.late_open,
           'picked', (select count(*) from public.season_predictions sp where sp.season = v_ev.season))
  into v_season
  from public.season_prediction_windows w where w.season = v_ev.season;

  -- sessions that took place in the last two weeks and still have no approved result
  select coalesce(jsonb_agg(jsonb_build_object(
           'session', s.id, 'event', e.name, 'type', s.session_type, 'start_utc', s.start_utc,
           'pending', exists (select 1 from public.results r where r.session_id = s.id and r.status = 'pending')
         ) order by s.start_utc), '[]'::jsonb)
  into v_pending
  from public.sessions s join public.events e on e.id = s.event_id
  where e.season < 9000
    and s.session_type in ('qualifying', 'race', 'sprint', 'sprint_qualifying')
    and s.start_utc is not null
    and s.start_utc < now() - interval '3 hours'
    and s.start_utc > now() - interval '14 days'
    and not exists (select 1 from public.results r where r.session_id = s.id and r.status = 'approved');

  return jsonb_build_object(
    'generated_at', now(),
    'event', jsonb_build_object('id', v_ev.id, 'name', v_ev.name, 'season', v_ev.season, 'round', v_ev.round,
                                'start_date', v_ev.start_date, 'end_date', v_ev.end_date, 'has_sprint', v_ev.has_sprint),
    'sessions', v_sessions,
    'drivers', v_drivers,
    'substitutions', v_subs,
    'penalties', v_pens,
    'players', v_players,
    'importer', v_import,
    'jobs', v_cron,
    'season_picks', v_season,
    'past_without_result', v_pending
  );
end;
$$;

revoke all on function public.admin_weekend_check(text) from public, anon;
grant execute on function public.admin_weekend_check(text) to authenticated;

do $$
declare
  v_bad text := '';
  r record;
begin
  for r in
    select p.oid::regprocedure::text as fn
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname = 'admin_weekend_check'
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
