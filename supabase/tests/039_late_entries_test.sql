-- Behaviour test for migration 039 (late Race and Sprint predictions). Run it in the Supabase SQL Editor.
-- It builds a temporary 2027 setup (Qualifying and Sprint Qualifying already started, Race and Sprint still to come), tries the rules,
-- and ends with an ERROR ON PURPOSE that rolls back EVERYTHING it did. The error message is the report.
--
-- Needs: one admin and two other group members, the 2026 drivers (the active ones are copied into 2027) and migrations 030 to 039.

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
  v_sq     text := 'bahrain-2027-sprint_qualifying';
  v_sp     text := 'bahrain-2027-sprint';
  v_ids    text[];
  v_cut_r  timestamptz;
  v_cut_s  timestamptz;
  v_picks  jsonb;
  v_picks2 jsonb;
  v_sprint jsonb;
  v_id1    uuid;
  v_id2    uuid;
  v_upd1   timestamptz;
  v_upd2   timestamptz;
  v_win    record;
  v_res_id uuid;
  v_s1     record;
  v_s2     record;
  v_raw    integer;
  v_res    jsonb;
  v_ov     jsonb;
  v_p1     integer;
  v_p2     integer;
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
  if cardinality(v_ids) < 12 then raise exception 'The test needs at least 12 active 2026 drivers to copy into 2027 (found %)', cardinality(v_ids); end if;

  -- Sprint Qualifying and Qualifying have started; the Sprint and the Race have not
  update public.sessions set start_utc = now() - interval '4 hours' where id = v_sq;
  update public.sessions set start_utc = now() + interval '1 hour'  where id = v_sp;
  update public.sessions set start_utc = now() - interval '2 hours' where id = v_q;
  update public.sessions set start_utc = now() + interval '3 hours' where id = v_rc;
  v_cut_r := now() - interval '2 hours';
  v_cut_s := now() - interval '4 hours';

  v_picks  := jsonb_build_object('top8', to_jsonb(v_ids[1:8]), 'fastest_lap', v_ids[1], 'any_dnf', false, 'dnf_count', 0);
  v_picks2 := jsonb_build_object('top8', to_jsonb(v_ids[3:10]), 'fastest_lap', v_ids[2], 'any_dnf', false, 'dnf_count', 0);
  v_sprint := jsonb_build_object('top8', to_jsonb(v_ids[1:8]));

  -- player 1 predicted EARLY (before Qualifying / Sprint Qualifying) and has not touched it since
  insert into public.predictions (user_id, session_id, picks, created_at, updated_at) values
    (v_m1, v_rc, v_picks,  now() - interval '6 hours', now() - interval '6 hours'),
    (v_m1, v_sp, v_sprint, now() - interval '8 hours', now() - interval '8 hours');

  -- ---------- the factor and the helpers ----------
  r := r || case when public.lo_late_factor() = 0.7 then 'ok    ' else 'FAIL  ' end || E'039 the late factor is 0.7\n';
  r := r || case when public.lo_late_from(v_rc) = v_cut_r and public.lo_late_from(v_sp) = v_cut_s then 'ok    ' else 'FAIL  ' end
         || E'039 a Race is late after Qualifying starts and a Sprint after Sprint Qualifying starts\n';
  r := r || case when public.lo_late_from(v_q) is null and not public.lo_is_late(v_q, now()) and not public.lo_is_late(v_sq, now()) then 'ok    ' else 'FAIL  ' end
         || E'039 Qualifying and Sprint Qualifying have no late period\n';
  r := r || case when public.lo_is_late(v_rc, now() - interval '6 hours') = false and public.lo_is_late(v_rc, now() - interval '1 hour') = true then 'ok    ' else 'FAIL  ' end
         || E'039 6 hours ago was early, 1 hour ago is late (Race)\n';

  -- ---------- who locks when ----------
  r := r || case when public.is_prediction_locked(v_q) and public.is_prediction_locked(v_sq)
                      and not public.is_prediction_locked(v_rc) and not public.is_prediction_locked(v_sp) then 'ok    ' else 'FAIL  ' end
         || E'039 Qualifying and Sprint Qualifying are locked, the Race and the Sprint are still open\n';

  select * into v_win from public.prediction_windows where session_id = v_rc;
  r := r || case when v_win.is_open and v_win.is_late and v_win.lock_at = now() + interval '3 hours' and v_win.full_value_until = v_cut_r
                 then 'ok    ' else 'FAIL  ' end || E'039 the Race window: open, late, closes at the Race start, full value until Qualifying started\n';
  select * into v_win from public.prediction_windows where session_id = v_q;
  r := r || case when not v_win.is_open and not v_win.is_late and v_win.full_value_until is null then 'ok    ' else 'FAIL  ' end
         || E'039 the Qualifying window: closed, no late period\n';

  -- ---------- saving ----------
  perform set_config('request.jwt.claims', json_build_object('sub', v_m2, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m2::text, true);
  set local role authenticated;

  begin perform public.submit_prediction(v_q, jsonb_build_object('q1_out', '[]', 'q2_out', '[]', 'q3_order', '[]')); ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '55000'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '039 Qualifying is closed (' || msg || E')\n';

  begin v_id2 := public.submit_prediction(v_rc, v_picks); ok := true; msg := 'saved';
  exception when others then ok := false; msg := sqlstate || ' ' || sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '039 player 2 can still save the Race after Qualifying started (' || msg || E')\n';
  begin perform public.submit_prediction(v_sp, v_sprint); ok := true; msg := 'saved';
  exception when others then ok := false; msg := sqlstate || ' ' || sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '039 and the Sprint after Sprint Qualifying started (' || msg || E')\n';
  reset role;

  select updated_at into v_upd2 from public.predictions where user_id = v_m2 and session_id = v_rc;
  r := r || case when v_upd2 >= v_cut_r and public.lo_is_late(v_rc, v_upd2) then 'ok    ' else 'FAIL  ' end || E'039 that late save is recorded as a late entry\n';

  -- identical picks: nothing changes; real change: updated_at moves
  update public.predictions set updated_at = now() - interval '30 minutes' where user_id = v_m2 and session_id = v_rc;
  select updated_at into v_upd2 from public.predictions where user_id = v_m2 and session_id = v_rc;
  perform set_config('request.jwt.claims', json_build_object('sub', v_m2, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m2::text, true);
  set local role authenticated;
  v_id1 := public.submit_prediction(v_rc, v_picks);
  reset role;
  r := r || case when v_id1 = v_id2 and (select updated_at from public.predictions where id = v_id2) = v_upd2 then 'ok    ' else 'FAIL  ' end
         || E'039 saving identical picks again changes nothing and returns the same prediction\n';

  -- player 1's early prediction: a re-save of the same picks must NOT turn it into a late entry
  perform set_config('request.jwt.claims', json_build_object('sub', v_m1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m1::text, true);
  set local role authenticated;
  perform public.submit_prediction(v_rc, v_picks);
  reset role;
  r := r || case when not public.lo_is_late(v_rc, (select updated_at from public.predictions where user_id = v_m1 and session_id = v_rc)) then 'ok    ' else 'FAIL  ' end
         || E'039 re-saving an early prediction unchanged keeps it early\n';

  -- reveal: nobody sees the Race picks of others before the Race starts
  perform set_config('request.jwt.claims', json_build_object('sub', v_m1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m1::text, true);
  set local role authenticated;
  select count(*) into n from public.predictions where session_id = v_rc and user_id = v_m2;
  r := r || case when n = 0 then 'ok    ' else 'FAIL  ' end || '039 before the Race starts, group-mates cannot see each other''s Race picks (' || n || E')\n';
  select count(*) into n from public.predictions where session_id = v_rc and user_id = v_m1;
  r := r || case when n = 1 then 'ok    ' else 'FAIL  ' end || '039 a player always sees his own (' || n || E')\n';
  reset role;
  insert into public.predictions (user_id, session_id, picks) values
    (v_m2, v_q, jsonb_build_object('q1_out', '[]', 'q2_out', '[]', 'q3_order', '[]'));
  perform set_config('request.jwt.claims', json_build_object('sub', v_m1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m1::text, true);
  set local role authenticated;
  select count(*) into n from public.predictions where session_id = v_q and user_id = v_m2;
  r := r || case when n = 1 then 'ok    ' else 'FAIL  ' end || '039 Qualifying picks are visible once Qualifying has started (' || n || E')\n';
  reset role;

  -- a real change moves updated_at
  perform set_config('request.jwt.claims', json_build_object('sub', v_m2, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m2::text, true);
  set local role authenticated;
  perform public.submit_prediction(v_rc, v_picks2);
  reset role;
  r := r || case when (select updated_at from public.predictions where id = v_id2) > v_upd2 then 'ok    ' else 'FAIL  ' end
         || E'039 changing the picks does move updated_at\n';
  update public.predictions set picks = v_picks where id = v_id2;    -- back to the exact picks, to compare scores below

  -- ---------- the preview an admin sees before approving (Sprint) ----------
  insert into public.predictions (user_id, session_id, picks, created_at, updated_at)
  values (v_m2, v_sp, v_sprint, now() - interval '1 hour', now() - interval '1 hour')
  on conflict (user_id, session_id) do update set picks = excluded.picks, updated_at = excluded.updated_at;
  v_res_id := public.enter_result(v_sp, v_sprint);
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  v_ov := public.admin_overview();
  reset role;
  select (p ->> 'points')::integer into v_p1
    from jsonb_array_elements(v_ov -> 'pending') e, jsonb_array_elements(e -> 'preview') p
   where e ->> 'session_id' = v_sp and p ->> 'name' = (select display_name from public.profiles where id = v_m1);
  select (p ->> 'points')::integer into v_p2
    from jsonb_array_elements(v_ov -> 'pending') e, jsonb_array_elements(e -> 'preview') p
   where e ->> 'session_id' = v_sp and p ->> 'name' = (select display_name from public.profiles where id = v_m2);
  r := r || case when v_p1 = 32 and v_p2 = floor(32 * 0.7)::integer then 'ok    ' else 'FAIL  ' end
         || '039 the admin preview shows the late factor (early ' || coalesce(v_p1::text, '-') || ', late ' || coalesce(v_p2::text, '-') || E')\n';

  -- ---------- after the Race starts ----------
  update public.sessions set start_utc = now() - interval '1 hour' where id = v_rc;
  perform set_config('request.jwt.claims', json_build_object('sub', v_m2, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m2::text, true);
  set local role authenticated;
  begin perform public.submit_prediction(v_rc, v_picks2); ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '55000'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '039 once the Race has started, saving is refused (' || msg || E')\n';
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_m1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m1::text, true);
  set local role authenticated;
  select count(*) into n from public.predictions where session_id = v_rc and user_id = v_m2;
  r := r || case when n = 1 then 'ok    ' else 'FAIL  ' end || '039 and the Race picks become visible (' || n || E')\n';
  reset role;

  -- ---------- scoring ----------
  v_res_id := public.enter_result(v_rc, jsonb_build_object('top8', to_jsonb(v_ids[1:8]), 'fastest_lap', v_ids[1], 'dnf_drivers', '[]'::jsonb, 'grid_top8', to_jsonb(v_ids[1:8])));
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  perform public.admin_approve_result(v_res_id);
  reset role;

  select * into v_s1 from public.scores where user_id = v_m1 and session_id = v_rc;
  select * into v_s2 from public.scores where user_id = v_m2 and session_id = v_rc;
  r := r || case when v_s1.points > 0 and v_s2.points = floor(v_s1.points * 0.7)::integer then 'ok    ' else 'FAIL  ' end
         || '039 the same picks score full value early and 70% (rounded down) late (' || coalesce(v_s1.points::text, '-') || ' and ' || coalesce(v_s2.points::text, '-') || E')\n';
  r := r || case when (v_s2.breakdown ->> 'late')::boolean and (v_s2.breakdown ->> 'raw_total')::integer = v_s1.points
                      and (v_s2.breakdown ->> 'late_factor')::numeric = 0.7 and not (v_s1.breakdown ? 'late') then 'ok    ' else 'FAIL  ' end
         || E'039 the late score records late, the late factor and the full-value total; the early score has no such mark\n';

  -- ---------- an admin correction keeps the entry late (the player's own times are not touched) ----------
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  v_res := public.admin_correct_predictions(v_rc, jsonb_build_array(jsonb_build_object('user_id', v_m2, 'picks', v_picks2)), 'Corrected for the late-entry test');
  reset role;
  select * into v_s2 from public.scores where user_id = v_m2 and session_id = v_rc;
  v_raw := (v_s2.breakdown ->> 'raw_total')::integer;
  r := r || case when (v_s2.breakdown ->> 'late')::boolean and v_s2.points = floor(v_raw * 0.7)::integer and v_raw < v_s1.points then 'ok    ' else 'FAIL  ' end
         || '039 after an admin correction the score is recalculated and still late (full ' || coalesce(v_raw::text, '-') || ', counted ' || coalesce(v_s2.points::text, '-') || E')\n';

  -- ---------- a weekend whose Qualifying time is unknown is never late ----------
  update public.sessions set start_utc = null where id = v_q;
  r := r || case when not public.lo_is_late(v_rc, now()) then 'ok    ' else 'FAIL  ' end || E'039 with no known Qualifying time nothing is late\n';

  -- ---------- permissions ----------
  perform set_config('request.jwt.claims', json_build_object('sub', v_m1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m1::text, true);
  set local role authenticated;
  begin perform public.lo_score(v_rc, v_picks, '{}'::jsonb, now()); ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '42501'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '039 players cannot call lo_score (' || msg || E')\n';
  begin perform public.lo_is_late(v_rc, now()); ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '42501'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '039 players cannot call lo_is_late (' || msg || E')\n';
  reset role;

  raise exception E'039 LATE ENTRIES DATABASE TEST REPORT (this error is expected; everything was rolled back)\nRESULT: %\n%',
    case when r like '%FAIL%' then 'FAILURES' else 'ALL OK' end, r;
end;
$$;
