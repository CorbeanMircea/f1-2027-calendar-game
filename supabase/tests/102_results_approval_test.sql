-- Behaviour test for results and approval (enter_result, admin_approve_result, admin_reject_result, admin_save_result_edit,
-- admin_enter_manual_result, recalculate_scores). Replaces the retired test 007.
-- Run it in the Supabase SQL Editor or with npm run test:sql. It ends with an ERROR ON PURPOSE that rolls everything back.
-- It builds its own throw-away race weekend (sqltest-results), so it needs only an admin and two other group members.

do $$
declare
  r         text := '';
  v_admin   uuid;
  v_m1      uuid;
  v_m2      uuid;
  v_ev      text := 'sqltest-results';
  v_q       text := 'sqltest-results-qualifying';
  v_race    text := 'sqltest-results-race';
  v_sprint  text := 'sqltest-results-sprint';
  v_top8    jsonb := '["2026-nor","2026-pia","2026-ver","2026-ham","2026-lec","2026-rus","2026-ant","2026-alo"]';
  v_swapped jsonb := '["2026-pia","2026-nor","2026-ver","2026-ham","2026-lec","2026-rus","2026-ant","2026-alo"]';
  v_quali   jsonb;
  v_race_ok jsonb;
  v_race_sw jsonb;
  v_res1    jsonb;
  v_res2    jsonb;
  v_r1 uuid; v_r2 uuid; v_r3 uuid; v_s1 uuid; v_s2 uuid; v_q1 uuid;
  v_msg     text;
  v_code    text;
  v_n       integer;
  v_p1 integer; v_p2 integer;
  v_before  integer;
  v_after   integer;
  v_sprint_pts integer;
begin
  select user_id into v_admin from public.group_members where role = 'admin' order by joined_at limit 1;
  select user_id into v_m1 from public.group_members where user_id <> v_admin order by joined_at limit 1;
  select user_id into v_m2 from public.group_members where user_id <> v_admin and user_id <> v_m1 order by joined_at limit 1;
  if v_admin is null or v_m1 is null or v_m2 is null then
    raise exception 'The test needs one admin and two other group members';
  end if;

  insert into public.events (id, season, round, name, circuit, locality, country, start_date, end_date, has_sprint, status)
  values (v_ev, 2026, 7702, 'SQL results GP', 'Test Circuit', 'Testville', 'Testland', current_date, current_date + 2, true, 'scheduled');
  insert into public.sessions (id, event_id, session_type, start_utc) values
    (v_q, v_ev, 'qualifying', now() + interval '2 days'),
    (v_race, v_ev, 'race', now() + interval '3 days'),
    (v_sprint, v_ev, 'sprint', now() + interval '2 days 12 hours');

  v_quali   := '{"q1_out":["2026-per","2026-pia","2026-rus","2026-sai","2026-str","2026-ver"],
                 "q2_out":["2026-hul","2026-law","2026-lec","2026-lin","2026-nor","2026-oco"],
                 "q3_order":["2026-alb","2026-alo","2026-ant","2026-bea","2026-bor","2026-bot","2026-col","2026-gas","2026-had","2026-ham"]}'::jsonb;
  v_race_ok := jsonb_build_object('top8', v_top8, 'fastest_lap', '2026-nor', 'any_dnf', false, 'dnf_count', 0, 'dnf_drivers', '[]'::jsonb);
  v_race_sw := jsonb_build_object('top8', v_swapped, 'fastest_lap', '2026-nor', 'any_dnf', false, 'dnf_count', 0, 'dnf_drivers', '[]'::jsonb);
  v_res1 := jsonb_build_object('top8', v_top8, 'fastest_lap', '2026-nor', 'dnf_drivers', '[]'::jsonb, 'grid_top8', v_top8);
  v_res2 := jsonb_build_object('top8', v_top8, 'fastest_lap', '2026-pia', 'dnf_drivers', '[]'::jsonb, 'grid_top8', v_top8);

  -- Predictions: player 1 predicts everything perfectly, player 2 swaps the first two in the Race ---------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_m1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m1::text, true);
  set local role authenticated;
  perform public.submit_prediction(v_race, v_race_ok);
  perform public.submit_prediction(v_q, v_quali);
  perform public.submit_prediction(v_sprint, jsonb_build_object('top8', v_top8));
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_m2, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m2::text, true);
  set local role authenticated;
  perform public.submit_prediction(v_race, v_race_sw);
  reset role;

  -- Time passes: these saves now date from two hours ago, so moving the start times below cannot turn them into late entries.
  update public.predictions set created_at = created_at - interval '2 hours', updated_at = updated_at - interval '2 hours'
   where session_id in (v_q, v_race, v_sprint);

  select coalesce(sum(session_points), 0) into v_before from public.leaderboard where user_id = v_m1 and season = 2026;

  -- 1. A result is entered: it waits for approval and scores nothing --------------------------------------------------------------
  v_r1 := public.enter_result(v_race, v_res1, 'sqltest');
  r := r || case when (select status from public.results where id = v_r1) = 'pending' and (select version from public.results where id = v_r1) = 1
                 then 'ok    ' else 'FAIL  ' end || E'an entered result is pending, version 1\n';
  select count(*) into v_n from public.scores where session_id = v_race;
  r := r || case when v_n = 0 then 'ok    ' else 'FAIL  ' end || E'a pending result scores nothing\n';

  -- 2. Approval rules -----------------------------------------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  v_msg := null;
  begin perform public.admin_approve_result(v_r1); exception when others then v_msg := sqlerrm; end;
  reset role;
  r := r || case when v_msg = 'Cannot approve: predictions are still open for this session' then 'ok    ' else 'FAIL  ' end
         || E'a result cannot be approved while predictions are still open\n';

  update public.sessions set start_utc = now() - interval '1 minute' where event_id = v_ev;

  perform set_config('request.jwt.claims', json_build_object('sub', v_m1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m1::text, true);
  set local role authenticated;
  v_msg := null; v_code := null;
  begin perform public.admin_approve_result(v_r1); exception when others then v_msg := sqlerrm; v_code := sqlstate; end;
  reset role;
  r := r || case when v_msg = 'Admins only' and v_code = '42501' then 'ok    ' else 'FAIL  ' end || E'a player who is not an admin cannot approve\n';

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  perform public.admin_approve_result(v_r1);
  reset role;
  r := r || case when (select status from public.results where id = v_r1) = 'approved'
                  and (select approved_by from public.results where id = v_r1) = v_admin
                  and (select approved_at from public.results where id = v_r1) is not null
                 then 'ok    ' else 'FAIL  ' end || E'approving marks the result approved, with who and when\n';

  -- 3. Approval scores everyone who predicted ----------------------------------------------------------------------------------------
  select points into v_p1 from public.scores where session_id = v_race and user_id = v_m1;
  select points into v_p2 from public.scores where session_id = v_race and user_id = v_m2;
  r := r || case when v_p1 = 65 then 'ok    ' else 'FAIL  ' end || E'a perfect Race prediction scores 65\n';
  r := r || case when v_p2 = 44 then 'ok    ' else 'FAIL  ' end || E'two swapped positions score 44 (6 x 5 + 2 x 2 + 3 + 2 + 5)\n';
  r := r || case when (select result_id from public.scores where session_id = v_race and user_id = v_m1) = v_r1 then 'ok    ' else 'FAIL  ' end
         || E'each score points at the result it was calculated from\n';
  r := r || case when (select (breakdown ->> 'total')::int from public.scores where session_id = v_race and user_id = v_m2) = 44 then 'ok    ' else 'FAIL  ' end
         || E'the breakdown total equals the points\n';

  perform public.recalculate_scores(v_race);
  select count(*) into v_n from public.scores where session_id = v_race;
  select points into v_p1 from public.scores where session_id = v_race and user_id = v_m1;
  r := r || case when v_n = 2 and v_p1 = 65 then 'ok    ' else 'FAIL  ' end || E'recalculating twice gives the same scores (no duplicates)\n';

  -- 4. Editing an approved result: a new pending version; the old one keeps scoring until the new one is approved -----------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  v_r2 := public.admin_save_result_edit(v_r1, v_res2);
  reset role;
  r := r || case when (select status from public.results where id = v_r2) = 'pending'
                  and (select version from public.results where id = v_r2) = 2
                  and (select source from public.results where id = v_r2) = 'manual-edit'
                  and (select api_snapshot from public.results where id = v_r2) = v_res1
                 then 'ok    ' else 'FAIL  ' end || E'an edit of an approved result is a new pending version that remembers the original\n';
  r := r || case when (select status from public.results where id = v_r1) = 'approved' then 'ok    ' else 'FAIL  ' end
         || E'the approved result stays approved while the edit is pending\n';
  select points into v_p1 from public.scores where session_id = v_race and user_id = v_m1;
  r := r || case when v_p1 = 65 then 'ok    ' else 'FAIL  ' end || E'scores do not change until the edit is approved\n';

  set local role authenticated;
  v_msg := null;
  begin perform public.admin_enter_manual_result(v_race, v_res1); exception when others then v_msg := sqlerrm; end;
  reset role;
  r := r || case when v_msg = 'A result already exists for this session; edit it instead' then 'ok    ' else 'FAIL  ' end
         || E'a manual result cannot be entered when one already exists\n';

  set local role authenticated;
  perform public.admin_approve_result(v_r2);
  reset role;
  r := r || case when (select status from public.results where id = v_r1) = 'superseded' and (select status from public.results where id = v_r2) = 'approved'
                 then 'ok    ' else 'FAIL  ' end || E'approving the edit retires the earlier approved result\n';
  select points into v_p1 from public.scores where session_id = v_race and user_id = v_m1;
  select points into v_p2 from public.scores where session_id = v_race and user_id = v_m2;
  r := r || case when v_p1 = 62 and v_p2 = 41 then 'ok    ' else 'FAIL  ' end || E'everyone is re-scored against the edited result (65 to 62, 44 to 41)\n';
  r := r || case when (select result_id from public.scores where session_id = v_race and user_id = v_m1) = v_r2 then 'ok    ' else 'FAIL  ' end
         || E'the scores now point at the new result\n';

  -- 5. A re-import after approval, then a rejection --------------------------------------------------------------------------------------
  v_r3 := public.enter_result(v_race, v_res1, 'sqltest-reimport');
  r := r || case when (select version from public.results where id = v_r3) = 3 and (select status from public.results where id = v_r3) = 'pending'
                 then 'ok    ' else 'FAIL  ' end || E'a re-import becomes the next version, pending\n';
  select points into v_p1 from public.scores where session_id = v_race and user_id = v_m1;
  r := r || case when v_p1 = 62 then 'ok    ' else 'FAIL  ' end || E'a pending re-import does not touch the approved scores\n';

  set local role authenticated;
  perform public.admin_reject_result(v_r3);
  reset role;
  r := r || case when (select status from public.results where id = v_r3) = 'rejected' then 'ok    ' else 'FAIL  ' end || E'a pending result can be rejected\n';
  select points into v_p1 from public.scores where session_id = v_race and user_id = v_m1;
  r := r || case when v_p1 = 62 then 'ok    ' else 'FAIL  ' end || E'rejecting changes no scores\n';

  set local role authenticated;
  v_msg := null; begin perform public.admin_reject_result(v_r3); exception when others then v_msg := sqlerrm; end;
  r := r || case when v_msg = 'Result not found or not pending' then 'ok    ' else 'FAIL  ' end || E'a rejected result cannot be rejected again\n';
  v_msg := null; begin perform public.admin_approve_result(v_r3); exception when others then v_msg := sqlerrm; end;
  r := r || case when v_msg = 'Result not found or not pending' then 'ok    ' else 'FAIL  ' end || E'a rejected result cannot be approved\n';
  v_msg := null; begin perform public.admin_save_result_edit(v_r3, v_res1); exception when others then v_msg := sqlerrm; end;
  r := r || case when v_msg = 'Only pending or approved results can be edited' then 'ok    ' else 'FAIL  ' end || E'a rejected result cannot be edited\n';
  v_msg := null; begin perform public.admin_reject_result(v_r2); exception when others then v_msg := sqlerrm; end;
  r := r || case when v_msg = 'Result not found or not pending' then 'ok    ' else 'FAIL  ' end || E'an approved result cannot be rejected\n';
  reset role;

  -- 6. Editing a PENDING result replaces it --------------------------------------------------------------------------------------------
  v_s1 := public.enter_result(v_sprint, jsonb_build_object('top8', v_top8), 'sqltest');
  set local role authenticated;
  v_s2 := public.admin_save_result_edit(v_s1, jsonb_build_object('top8', v_swapped));
  reset role;
  r := r || case when (select status from public.results where id = v_s1) = 'superseded' and (select status from public.results where id = v_s2) = 'pending'
                 then 'ok    ' else 'FAIL  ' end || E'editing a pending result supersedes it with a new pending version\n';
  set local role authenticated;
  v_msg := null; begin perform public.admin_approve_result(v_s1); exception when others then v_msg := sqlerrm; end;
  r := r || case when v_msg = 'Result not found or not pending' then 'ok    ' else 'FAIL  ' end || E'a superseded result cannot be approved\n';
  perform public.admin_approve_result(v_s2);
  reset role;
  select points into v_sprint_pts from public.scores where session_id = v_sprint and user_id = v_m1;
  r := r || case when v_sprint_pts = 20 then 'ok    ' else 'FAIL  ' end
         || E'the sprint is scored against the approved edit (6 exact x 3 + 2 in the wrong place x 1 = 20)\n';

  -- 7. Rejecting a Qualifying result scores nothing --------------------------------------------------------------------------------------
  v_q1 := public.enter_result(v_q, v_quali, 'sqltest');
  set local role authenticated;
  perform public.admin_reject_result(v_q1);
  reset role;
  select count(*) into v_n from public.scores where session_id = v_q;
  r := r || case when v_n = 0 and (select status from public.results where id = v_q1) = 'rejected' then 'ok    ' else 'FAIL  ' end
         || E'a rejected Qualifying result leaves no scores\n';

  -- 8. The leaderboard follows the approved results -------------------------------------------------------------------------------------------
  select coalesce(sum(session_points), 0) into v_after from public.leaderboard where user_id = v_m1 and season = 2026;
  r := r || case when v_after - v_before = 62 + v_sprint_pts then 'ok    ' else 'FAIL  ' end
         || E'the season leaderboard gained exactly the approved Race and Sprint points\n';

  raise exception E'RESULTS AND APPROVAL TEST REPORT (this error is expected; everything was rolled back)\nRESULT: %\n%',
    case when r like '%FAIL%' then 'FAILURES' else 'ALL OK' end, r;
end;
$$;
