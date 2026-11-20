-- Behaviour test for migrations 030, 031 and 032 (lineup foundation and driver substitutions). Run it in the Supabase SQL Editor.
-- It builds a temporary 2027 setup, tries the rules, and ends with an ERROR ON PURPOSE that rolls back EVERYTHING it did.
-- The error message is the report: every line starts with "ok" or "FAIL"; the RESULT line says "ALL OK" or "FAILURES".
--
-- Needs: one admin and two other group members, and the 2026 drivers (the active ones are copied into 2027 for the test).

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
  v_sq     text := 'bahrain-2027-sprint_qualifying';
  v_ver    text;
  v_n      integer;
  v_inact  boolean;
  v_alt    text;
  v_ids    text[];
  v_oth    text[];
  v_q1     jsonb;
  v_race1  jsonb;
  v_race2  jsonb;
  v_res    jsonb;
  v_sub1   uuid;
  v_sub2   uuid;
  v_line   text[];
  v_state  record;
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

  update public.sessions set start_utc = now() + interval '30 days' where event_id = v_ev;

  -- the old rules apply only while 2027 has no inactive driver row (a replacement who is not racing everywhere)
  select exists (select 1 from public.drivers d where d.season = 2027 and not d.is_active) into v_inact;
  v_ids := array(select d.id from public.drivers d where d.season = 2027 and d.is_active order by d.code);
  v_n := cardinality(v_ids);
  if v_n < 17 then
    raise exception 'The test needs at least 17 active 2026 drivers to copy into 2027 (found %)', v_n;
  end if;
  v_ver := v_ids[1];                       -- the driver who will be replaced
  v_alt := v_ids[2];                       -- a driver who is already in the lineup
  v_oth := array_remove(v_ids, v_ver);

  -- player 1 predicts qualifying and race WITH the driver who will be replaced; player 2 predicts the race WITHOUT him
  v_q1 := jsonb_build_object('q1_out', to_jsonb(v_oth[1:v_n - 16]), 'q2_out', to_jsonb(v_oth[v_n - 15:v_n - 10]),
                             'q3_order', to_jsonb(array[v_ver] || v_oth[v_n - 9:v_n - 1]));
  v_race1 := jsonb_build_object('top8', to_jsonb(array[v_ver] || v_oth[1:7]), 'fastest_lap', v_ver, 'any_dnf', false, 'dnf_count', 0);
  v_race2 := jsonb_build_object('top8', to_jsonb(v_oth[1:8]), 'fastest_lap', v_oth[1], 'any_dnf', false, 'dnf_count', 0);

  -- ---------- 030: the lineup without any substitution ----------
  select o_lineup, o_use into v_state from public.session_lineup_state(v_rc);
  r := r || case when v_state.o_lineup = v_ids and v_state.o_use = v_inact then 'ok    ' else 'FAIL  ' end
         || E'030 without substitutions the lineup is every active driver (and the old rules apply unless 2027 already has an inactive driver row)\n';

  perform set_config('request.jwt.claims', json_build_object('sub', v_m1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m1::text, true);
  set local role authenticated;

  begin perform public.submit_prediction(v_q, v_q1); ok := true; msg := 'saved';
  exception when others then ok := false; msg := sqlstate || ' ' || sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '030 player 1 saves a valid qualifying prediction (' || msg || E')\n';

  begin perform public.submit_prediction(v_rc, v_race1); ok := true; msg := 'saved';
  exception when others then ok := false; msg := sqlstate || ' ' || sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '030 player 1 saves a valid race prediction (' || msg || E')\n';

  begin
    perform public.submit_prediction(v_rc, jsonb_set(v_race1, '{top8}', to_jsonb(array[v_ver, v_ver] || v_oth[1:6])));
    ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '22023'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '030 the same driver twice is refused (' || msg || E')\n';

  begin
    perform public.submit_prediction(v_rc, jsonb_set(v_race1, '{fastest_lap}', to_jsonb('2027-nobody'::text)));
    ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '22023'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '030 an unknown driver is refused (' || msg || E')\n';

  begin
    perform public.submit_prediction(v_q, jsonb_set(v_q1, '{q3_order}', to_jsonb(v_oth[v_n - 9:v_n - 1] || v_oth[1])));
    ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '22023'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '030 a ranking that repeats a driver (and misses another) is refused (' || msg || E')\n';

  perform set_config('request.jwt.claims', json_build_object('sub', v_m2, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m2::text, true);
  begin perform public.submit_prediction(v_rc, v_race2); ok := true; msg := 'saved';
  exception when others then ok := false; msg := sqlstate || ' ' || sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '030 player 2 saves a race prediction without the driver (' || msg || E')\n';

  -- permissions of the internal lineup functions
  begin perform * from public.session_lineup_state(v_rc); ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '42501'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '030 players cannot call session_lineup_state (' || msg || E')\n';
  begin select cardinality(public.session_lineup(v_rc)) into n; ok := n = v_n; msg := coalesce(n::text, 'null');
  exception when others then ok := false; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '030 players can read the lineup of a session (' || msg || E' drivers)\n';
  begin perform public.session_lineup_external(v_rc); ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '42501'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '030 players cannot call session_lineup_external (' || msg || E')\n';

  -- ---------- 031: who may register ----------
  begin
    perform public.admin_register_substitution(v_ev, v_ver, v_alt, null, array[v_rc]);
    ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '42501'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '031 a player cannot register a substitution (' || msg || E')\n';
  begin perform public.admin_preview_substitution(v_ev, v_ver, null); ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '42501'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '031 a player cannot preview a substitution (' || msg || E')\n';

  -- ---------- 031: the admin registers a substitution ----------
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);

  begin perform public.admin_preview_substitution(v_ev, v_ver, null); ok := true; msg := 'ok';
  exception when others then ok := false; msg := sqlstate || ' ' || sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '031 the admin can preview a substitution (' || msg || E')\n';

  begin
    perform public.admin_register_substitution(v_ev, v_ver, v_alt, null, array[v_rc]);
    ok := false; msg := 'no error';
  exception when others then ok := sqlerrm like '%already in the lineup%'; msg := sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '031 a replacement who is already in the lineup is refused (' || msg || E')\n';

  begin
    perform public.admin_register_substitution(v_ev, v_ver, null,
      jsonb_build_object('code', 'AB', 'full_name', 'Test Driver', 'team_name', 'Red Bull', 'external_id', 'test_driver'), array[v_rc]);
    ok := false; msg := 'no error';
  exception when others then ok := sqlerrm like '%three letters%'; msg := sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '031 a driver code that is not three letters is refused (' || msg || E')\n';

  begin
    perform public.admin_register_substitution(v_ev, v_ver, null,
      jsonb_build_object('code', 'TST', 'full_name', 'Test Driver', 'team_name', 'Red Bull'), array[v_rc]);
    ok := false; msg := 'no error';
  exception when others then ok := sqlerrm like '%results-API driver id%'; msg := sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '031 a new driver without the results-API id is refused (' || msg || E')\n';

  begin perform public.admin_register_substitution(v_ev, v_ver, v_alt, null, '{}'::text[]); ok := false; msg := 'no error';
  exception when others then ok := sqlerrm like '%at least one session%'; msg := sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '031 at least one session must be selected (' || msg || E')\n';

  -- a session that has taken place cannot be changed
  reset role;
  update public.sessions set start_utc = now() - interval '1 day' where id = v_sq;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  begin
    perform public.admin_register_substitution(v_ev, v_ver, null,
      jsonb_build_object('code', 'TST', 'full_name', 'Test Driver', 'team_name', 'Red Bull', 'external_id', 'test_driver'), array[v_sq]);
    ok := false; msg := 'no error';
  exception when others then ok := sqlerrm like '%already taken place%'; msg := sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '031 a session that has already taken place is refused (' || msg || E')\n';

  -- a session with no start time needs an explicit confirmation
  reset role;
  update public.sessions set start_utc = null where id = v_sp;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  begin
    perform public.admin_register_substitution(v_ev, v_ver, null,
      jsonb_build_object('code', 'TST', 'full_name', 'Test Driver', 'team_name', 'Red Bull', 'external_id', 'test_driver'), array[v_sp]);
    ok := false; msg := 'no error';
  exception when others then ok := sqlerrm like '%confirm it explicitly%'; msg := sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '031 a session with no start time needs explicit confirmation (' || msg || E')\n';

  -- nothing was written by the refused attempts
  reset role;
  select count(*) into n from public.driver_substitutions where event_id = v_ev;
  r := r || case when n = 0 then 'ok    ' else 'FAIL  ' end || '031 refused attempts wrote nothing for this weekend (' || n || E' substitutions)\n';
  select count(*) into n from public.drivers where season = 2027 and code = 'TST';
  r := r || case when n = 0 then 'ok    ' else 'FAIL  ' end || '031 refused attempts created no driver (' || n || E')\n';

  -- the real registration: VER is replaced by a new driver in qualifying and race
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  v_res := public.admin_register_substitution(v_ev, v_ver, null,
    jsonb_build_object('code', 'tst', 'full_name', 'Test Driver', 'team_name', 'Red Bull', 'external_id', 'test_driver', 'car_number', '99'),
    array[v_q, v_rc], '{}'::text[], 'test note');
  reset role;

  select ds.id into v_sub1 from public.driver_substitutions ds where ds.event_id = v_ev order by ds.registered_at desc limit 1;
  r := r || case when v_sub1 is not null then 'ok    ' else 'FAIL  ' end || E'031 the substitution is recorded\n';

  select d.is_active into ok from public.drivers d where d.id = '2027-tst';
  r := r || case when ok is false then 'ok    ' else 'FAIL  ' end || E'031 the new driver is created inactive (he races only where the lineup says so)\n';

  select o_lineup into v_line from public.session_lineup_state(v_rc);
  r := r || case when not (v_ver = any (v_line)) and '2027-tst' = any (v_line) and cardinality(v_line) = v_n then 'ok    ' else 'FAIL  ' end
         || E'031 race lineup: the replaced driver out, the new driver in, same number of drivers\n';
  select o_lineup into v_line from public.session_lineup_state(v_sp);
  r := r || case when v_ver = any (v_line) and not ('2027-tst' = any (v_line)) then 'ok    ' else 'FAIL  ' end
         || E'031 sessions that were not selected keep the original lineup (sprint)\n';

  select o_stand_ins into v_state from public.session_lineup_state(v_rc);
  r := r || case when v_state.o_stand_ins ->> v_ver = '2027-tst' then 'ok    ' else 'FAIL  ' end
         || E'031 the withdrawn driver maps to his replacement (stand-in)\n';

  -- notifications: players with a saved prediction in an affected session, one each, listing only their own sessions
  select count(*) into n from public.player_notifications where user_id = v_m1 and kind = 'substitution' and event_id = v_ev;
  r := r || case when n = 1 then 'ok    ' else 'FAIL  ' end || '031 player 1 (qualifying and race saved) gets one notification (' || n || E')\n';
  select count(*) into n from public.player_notifications where user_id = v_m2 and kind = 'substitution' and event_id = v_ev;
  r := r || case when n = 1 then 'ok    ' else 'FAIL  ' end || '031 player 2 (race saved) gets one notification (' || n || E')\n';
  select count(*) into n from public.player_notifications where user_id = v_admin and kind = 'substitution' and event_id = v_ev;
  r := r || case when n = 0 then 'ok    ' else 'FAIL  ' end || '031 a group member with no prediction (the admin) gets none (' || n || E')\n';
  select jsonb_array_length(payload -> 'your_sessions') into n from public.player_notifications where user_id = v_m2 and kind = 'substitution' and event_id = v_ev;
  r := r || case when n = 1 then 'ok    ' else 'FAIL  ' end || '031 the notice to player 2 lists only his own session, the race (' || coalesce(n::text, 'none') || E' session)\n';
  select jsonb_array_length(payload -> 'your_sessions') into n from public.player_notifications where user_id = v_m1 and kind = 'substitution' and event_id = v_ev;
  r := r || case when n = 2 then 'ok    ' else 'FAIL  ' end || '031 the notice to player 1 lists qualifying and race (' || coalesce(n::text, 'none') || E' sessions)\n';

  -- predictions after the substitution
  perform set_config('request.jwt.claims', json_build_object('sub', v_m1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m1::text, true);
  set local role authenticated;
  begin perform public.submit_prediction(v_rc, v_race1); ok := true; msg := 'saved';
  exception when others then ok := false; msg := sqlstate || ' ' || sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '031 player 1 can re-save the pick that still names the withdrawn driver (' || msg || E')\n';

  perform set_config('request.jwt.claims', json_build_object('sub', v_m2, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m2::text, true);
  begin
    perform public.submit_prediction(v_rc, jsonb_set(v_race2, '{top8}', to_jsonb(array[v_ver] || v_oth[1:7])));
    ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '22023'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '031 player 2 cannot newly pick the withdrawn driver (' || msg || E')\n';
  begin
    perform public.submit_prediction(v_rc, jsonb_set(v_race2, '{top8}', to_jsonb(array['2027-tst'] || v_oth[1:7])));
    ok := true; msg := 'saved';
  exception when others then ok := false; msg := sqlstate || ' ' || sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '031 player 2 can pick the new driver (' || msg || E')\n';

  -- append-only history
  reset role;
  begin update public.driver_substitutions set note = 'changed' where id = v_sub1; ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '55000'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '031 the substitution history cannot be edited (' || msg || E')\n';
  begin delete from public.driver_substitutions where id = v_sub1; ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '55000'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '031 the substitution history cannot be deleted (' || msg || E')\n';

  -- Everything in this test runs in ONE transaction, so every row would get the same timestamp and "which substitution came
  -- later" would be decided by a random id. In real use each registration is its own transaction. Make the first one older
  -- (the history is append-only, so its guard is lifted for this one statement; this is rolled back with everything else).
  alter table public.driver_substitutions disable trigger user;
  update public.driver_substitutions set registered_at = registered_at - interval '1 minute' where id = v_sub1;
  alter table public.driver_substitutions enable trigger user;

  -- a second substitution on the same chain: the new driver is replaced by another new driver
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  perform public.admin_register_substitution(v_ev, '2027-tst', null,
    jsonb_build_object('code', 'TSB', 'full_name', 'Second Driver', 'team_name', 'Red Bull', 'external_id', 'test_driver_b'), array[v_rc]);
  reset role;
  select ds.id into v_sub2 from public.driver_substitutions ds where ds.event_id = v_ev and ds.out_driver_id = '2027-tst';
  select o_stand_ins into v_state from public.session_lineup_state(v_rc);
  r := r || case when v_state.o_stand_ins ->> v_ver = '2027-tsb' and v_state.o_stand_ins ->> '2027-tst' = '2027-tsb' then 'ok    ' else 'FAIL  ' end
         || E'031 chains resolve: VER and the first replacement both map to the second replacement\n';

  -- last in, first out
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  begin perform public.admin_revert_substitution(v_sub1, 'test'); ok := false; msg := 'no error';
  exception when others then ok := sqlerrm like '%revert that one first%'; msg := sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '031 the earlier substitution cannot be reverted while a later one applies (' || msg || E')\n';
  begin perform public.admin_revert_substitution(v_sub2, ''); ok := false; msg := 'no error';
  exception when others then ok := sqlerrm like '%reason is required%'; msg := sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '031 a revert needs a reason (' || msg || E')\n';

  perform public.admin_revert_substitution(v_sub2, 'test: undo the second');
  reset role;
  select o_lineup into v_line from public.session_lineup_state(v_rc);
  r := r || case when '2027-tst' = any (v_line) and not ('2027-tsb' = any (v_line)) then 'ok    ' else 'FAIL  ' end
         || E'031 reverting the second substitution brings the first replacement back\n';

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  perform public.admin_revert_substitution(v_sub1, 'test: undo the first');
  reset role;
  select o_lineup, o_stand_ins into v_state from public.session_lineup_state(v_rc);
  r := r || case when v_ver = any (v_state.o_lineup) and not ('2027-tst' = any (v_state.o_lineup)) and cardinality(v_state.o_lineup) = v_n
                 then 'ok    ' else 'FAIL  ' end || E'031 after both reverts the original lineup is back\n';
  r := r || case when v_state.o_stand_ins ->> '2027-tst' = v_ver then 'ok    ' else 'FAIL  ' end
         || E'031 the withdrawn replacement maps back to the original driver (so a saved pick can still be re-saved)\n';

  select count(*) into n from public.player_notifications where user_id = v_m1 and kind = 'substitution_reverted' and event_id = v_ev;
  r := r || case when n >= 1 then 'ok    ' else 'FAIL  ' end || '031 reverting notifies the players with a saved prediction (' || n || E')\n';

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  begin perform public.admin_revert_substitution(v_sub1, 'again'); ok := false; msg := 'no error';
  exception when others then ok := sqlerrm like '%Nothing to revert%'; msg := sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '031 reverting twice is refused (' || msg || E')\n';
  reset role;

  select count(*) into n from public.driver_substitution_sessions where substitution_id = v_sub1;
  r := r || case when n = 4 then 'ok    ' else 'FAIL  ' end
         || '031 history keeps every step: 2 sessions applied and 2 reverted (' || n || E' rows)\n';

  raise exception E'M2 SUBSTITUTIONS DATABASE TEST REPORT (this error is expected; everything was rolled back)\nRESULT: %\n%',
    case when r like '%FAIL%' then 'FAILURES' else 'ALL OK' end, r;
end;
$$;
