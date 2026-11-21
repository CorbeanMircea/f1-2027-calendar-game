-- Behaviour test for migration 038 (facts for the Admin "Weekend check" tab). Run it in the Supabase SQL Editor.
-- It builds a temporary 2027 setup, calls admin_weekend_check and compares what it reports, and ends with an ERROR ON PURPOSE
-- that rolls back EVERYTHING it did. The error message is the report: every line starts with "ok" or "FAIL".
--
-- Needs: one admin and two other group members, the 2026 drivers (the active ones are copied into 2027) and migrations 030 to 038.

do $$
declare
  r        text := '';
  ok       boolean;
  msg      text;
  n        integer;
  v_admin  uuid;
  v_m1     uuid;
  v_m2     uuid;
  v_ev     text := 'bahrain-2027';
  v_q      text := 'bahrain-2027-qualifying';
  v_rc     text := 'bahrain-2027-race';
  v_sp     text := 'bahrain-2027-sprint';
  v_ids    text[];
  v_n      integer;
  v_ver    text;
  v_code   text;
  v_oth    text[];
  v_res    jsonb;
  v_chk    jsonb;
  v_sub    uuid;
  v_pen    uuid;
  v_before integer;
begin
  -- ---------- setup (all rolled back at the end) ----------
  select user_id into v_admin from public.group_members where role = 'admin' order by joined_at limit 1;
  select user_id into v_m1 from public.group_members where user_id <> v_admin order by joined_at limit 1;
  select user_id into v_m2 from public.group_members where user_id <> v_admin and user_id <> v_m1 order by joined_at limit 1;
  if v_admin is null or v_m1 is null or v_m2 is null then
    raise exception 'The test needs one admin and two other group members';
  end if;

  insert into public.drivers (id, season, code, full_name, team_name, car_number, external_id, is_active)
  select replace(d.id, '2026-', '2027-'), 2027, d.code, d.full_name, d.team_name, d.car_number, null, true
  from public.drivers d where d.season = 2026 and d.is_active
  on conflict do nothing;
  v_ids := array(select d.id from public.drivers d where d.season = 2027 and d.is_active order by d.code);
  v_n := cardinality(v_ids);
  if v_n < 17 then raise exception 'The test needs at least 17 active 2026 drivers to copy into 2027 (found %)', v_n; end if;
  v_ver := v_ids[1];
  v_oth := array_remove(v_ids, v_ver);
  select d.code into v_code from public.drivers d where d.id = v_ver;

  update public.sessions set start_utc = now() + interval '30 days' where event_id = v_ev;
  update public.sessions set start_utc = null where id = v_sp;                    -- one session without a time

  select count(*) into v_before from public.import_log where event_id = v_ev;

  -- ---------- who may use it ----------
  perform set_config('request.jwt.claims', json_build_object('sub', v_m1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m1::text, true);
  set local role authenticated;
  begin perform public.admin_weekend_check(v_ev); ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '42501'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '038 a player cannot run the weekend check (' || msg || E')\n';
  reset role;
  begin
    set local role anon;
    perform public.admin_weekend_check(v_ev); ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '42501'; msg := sqlstate; end;
  reset role;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '038 a signed-out visitor cannot call it (' || msg || E')\n';

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  begin perform public.admin_weekend_check('no-such-event'); ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '22023'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '038 an unknown event is refused (' || msg || E')\n';

  -- ---------- the report for a plain weekend ----------
  v_chk := public.admin_weekend_check(v_ev);
  r := r || case when v_chk -> 'event' ->> 'id' = v_ev and (v_chk -> 'event' ->> 'has_sprint')::boolean then 'ok    ' else 'FAIL  ' end
         || E'038 reports the event and that it is a sprint weekend\n';
  r := r || case when jsonb_array_length(v_chk -> 'sessions') = 4 then 'ok    ' else 'FAIL  ' end
         || '038 lists all four sessions (' || jsonb_array_length(v_chk -> 'sessions') || E')\n';
  select count(*) into n from jsonb_array_elements(v_chk -> 'sessions') s where s ->> 'start_utc' is null;
  r := r || case when n = 1 then 'ok    ' else 'FAIL  ' end || '038 shows the one session without a start time (' || n || E')\n';
  select count(*) into n from jsonb_array_elements(v_chk -> 'sessions') s where (s ->> 'lineup')::integer = v_n;
  r := r || case when n = 4 then 'ok    ' else 'FAIL  ' end || '038 every session has the full lineup (' || n || ' of 4 with ' || v_n || E' drivers)\n';
  r := r || case when (v_chk -> 'drivers' ->> 'active')::integer >= v_n
                      and jsonb_array_length(v_chk -> 'drivers' -> 'missing_api_id') >= v_n then 'ok    ' else 'FAIL  ' end
         || E'038 counts the active drivers and lists those without a results-API id (the copies have none)\n';
  r := r || case when v_chk -> 'substitutions' = '[]'::jsonb and v_chk -> 'penalties' = '[]'::jsonb then 'ok    ' else 'FAIL  ' end
         || E'038 reports no substitutions and no penalties\n';
  r := r || case when (v_chk -> 'players' ->> 'members')::integer = (select count(*) from public.group_members) then 'ok    ' else 'FAIL  ' end
         || E'038 counts the league members\n';
  r := r || case when v_chk -> 'jobs' is not null or not exists (select 1 from pg_namespace where nspname = 'cron') then 'ok    ' else 'FAIL  ' end
         || E'038 includes the scheduled jobs (or says they are unavailable when pg_cron is not installed)\n';
  reset role;

  -- ---------- predictions, devices, importer rows ----------
  insert into public.predictions (user_id, session_id, picks) values
    (v_m1, v_q, '{}'::jsonb), (v_m1, v_rc, '{}'::jsonb), (v_m2, v_rc, '{}'::jsonb);
  insert into public.push_subscriptions (endpoint, user_id, p256dh, auth) values
    ('https://push.test/chk-1', v_m1, 'k', 'a'), ('https://push.test/chk-2', v_m1, 'k', 'a');
  insert into public.import_log (event_id, session_type, action, detail) values
    (v_ev, 'all', 'error', 'Expected exactly one API race between X and Y, found 0'),
    (v_ev, 'race', 'skipped', 'No results available yet');

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  v_chk := public.admin_weekend_check(v_ev);
  reset role;
  select (s ->> 'predictions')::integer into n from jsonb_array_elements(v_chk -> 'sessions') s where s ->> 'id' = v_rc;
  r := r || case when n = 2 then 'ok    ' else 'FAIL  ' end || '038 counts the predictions per session (race: ' || n || E')\n';
  r := r || case when (v_chk -> 'players' ->> 'predicted_this_weekend')::integer = 2 then 'ok    ' else 'FAIL  ' end
         || E'038 counts the players who predicted anything this weekend (2)\n';
  r := r || case when (v_chk -> 'players' ->> 'devices')::integer >= 2 and (v_chk -> 'players' ->> 'players_with_devices')::integer >= 1
                 then 'ok    ' else 'FAIL  ' end || E'038 counts reminder devices and the players who have one\n';
  r := r || case when (v_chk -> 'importer' ->> 'errors_24h')::integer = 1
                      and jsonb_array_length(v_chk -> 'importer' -> 'recent') = least(6, v_before + 2)
                      and v_chk -> 'importer' ->> 'last_log_at' is not null then 'ok    ' else 'FAIL  ' end
         || E'038 reports the importer''s recent rows and one error in the last 24 hours\n';

  -- ---------- substitutions and penalties in force ----------
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  perform public.admin_register_substitution(v_ev, v_ver, null,
    jsonb_build_object('code', 'tst', 'full_name', 'Test Driver', 'team_name', 'Red Bull', 'external_id', 'chk_driver'), array[v_q, v_rc]);
  reset role;
  select ds.id into v_sub from public.driver_substitutions ds where ds.event_id = v_ev;

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  perform public.admin_register_grid_penalty(v_rc, v_oth[1], 'places', 3, 1, 4, 'Official: 3 place penalty');
  v_chk := public.admin_weekend_check(v_ev);
  reset role;

  r := r || case when jsonb_array_length(v_chk -> 'substitutions') = 1
                      and v_chk -> 'substitutions' -> 0 ->> 'out' = v_code and v_chk -> 'substitutions' -> 0 ->> 'in' = 'TST'
                      and jsonb_array_length(v_chk -> 'substitutions' -> 0 -> 'sessions') = 2 then 'ok    ' else 'FAIL  ' end
         || E'038 lists the substitution in force (the replaced driver out, the new one in, two sessions)\n';
  select (s ->> 'stand_ins')::integer into n from jsonb_array_elements(v_chk -> 'sessions') s where s ->> 'id' = v_rc;
  r := r || case when n = 1 then 'ok    ' else 'FAIL  ' end || '038 shows the stand-in on the race (' || n || E')\n';
  r := r || case when jsonb_array_length(v_chk -> 'penalties') = 1 and v_chk -> 'penalties' -> 0 ->> 'session' = 'race' then 'ok    ' else 'FAIL  ' end
         || E'038 lists the grid penalty in force\n';

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  perform public.admin_revert_substitution(v_sub, 'test: undo');
  select id into v_pen from public.grid_penalties where session_id = v_rc and entry_type = 'penalty';
  perform public.admin_revoke_grid_penalty(v_pen, 'test: withdrawn');
  v_chk := public.admin_weekend_check(v_ev);
  reset role;
  r := r || case when v_chk -> 'substitutions' = '[]'::jsonb then 'ok    ' else 'FAIL  ' end || E'038 a reverted substitution is no longer listed\n';
  r := r || case when v_chk -> 'penalties' = '[]'::jsonb then 'ok    ' else 'FAIL  ' end || E'038 a revoked penalty is no longer listed\n';

  -- ---------- past sessions without an approved result ----------
  update public.sessions set start_utc = now() - interval '1 day' where id = v_q;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  v_chk := public.admin_weekend_check(v_ev);
  reset role;
  select count(*) into n from jsonb_array_elements(v_chk -> 'past_without_result') s where s ->> 'session' = v_q;
  r := r || case when n = 1 then 'ok    ' else 'FAIL  ' end || '038 lists a session that took place and has no approved result (' || n || E')\n';
  select count(*) into n from jsonb_array_elements(v_chk -> 'past_without_result') s where s ->> 'session' = v_rc;
  r := r || case when n = 0 then 'ok    ' else 'FAIL  ' end || '038 and does not list sessions still to come (' || n || E')\n';

  -- ---------- without an event: the current or next weekend ----------
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  v_chk := public.admin_weekend_check(null);
  reset role;
  r := r || case when v_chk -> 'event' ->> 'id' is not null and (v_chk -> 'event' ->> 'end_date')::date >= current_date - 1 then 'ok    ' else 'FAIL  ' end
         || E'038 with no event given it picks a current or upcoming weekend\n';

  raise exception E'038 ADMIN WEEKEND CHECK DATABASE TEST REPORT (this error is expected; everything was rolled back)\nRESULT: %\n%',
    case when r like '%FAIL%' then 'FAILURES' else 'ALL OK' end, r;
end;
$$;
