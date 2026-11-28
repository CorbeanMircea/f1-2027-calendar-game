-- Behaviour test for saving predictions (submit_prediction, migrations 009 / 030 / 039). Replaces the retired test 005.
-- Run it in the Supabase SQL Editor or with npm run test:sql. It ends with an ERROR ON PURPOSE that rolls everything back.
-- It builds its own throw-away race weekend (sqltest-submit), so it needs only an admin and two other group members.

do $$
declare
  r        text := '';
  v_admin  uuid;
  v_m1     uuid;
  v_m2     uuid;
  v_ev     text := 'sqltest-submit';
  v_q      text := 'sqltest-submit-qualifying';
  v_stranger uuid := '99999999-0000-4000-8000-000000000001';
  v_picks  jsonb;
  v_swap   jsonb;
  v_id1    uuid;
  v_id2    uuid;
  v_id3    uuid;
  v_created timestamptz;
  v_updated timestamptz;
  v_msg    text;
  v_code   text;
  v_n      integer;
begin
  select user_id into v_admin from public.group_members where role = 'admin' order by joined_at limit 1;
  select user_id into v_m1 from public.group_members where user_id <> v_admin order by joined_at limit 1;
  select user_id into v_m2 from public.group_members where user_id <> v_admin and user_id <> v_m1 order by joined_at limit 1;
  if v_admin is null or v_m1 is null or v_m2 is null then
    raise exception 'The test needs one admin and two other group members';
  end if;

  insert into public.events (id, season, round, name, circuit, locality, country, start_date, end_date, has_sprint, status)
  values (v_ev, 2026, 7701, 'SQL test GP', 'Test Circuit', 'Testville', 'Testland', current_date, current_date + 2, false, 'scheduled');
  insert into public.sessions (id, event_id, session_type, start_utc) values (v_q, v_ev, 'qualifying', now() + interval '2 days');

  v_picks := '{"q1_out":["2026-per","2026-pia","2026-rus","2026-sai","2026-str","2026-ver"],
               "q2_out":["2026-hul","2026-law","2026-lec","2026-lin","2026-nor","2026-oco"],
               "q3_order":["2026-alb","2026-alo","2026-ant","2026-bea","2026-bor","2026-bot","2026-col","2026-gas","2026-had","2026-ham"]}'::jsonb;
  v_swap := jsonb_set(jsonb_set(v_picks, '{q3_order,0}', '"2026-alo"'), '{q3_order,1}', '"2026-alb"');

  -- 1. A first save --------------------------------------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_m1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m1::text, true);
  set local role authenticated;
  v_id1 := public.submit_prediction(v_q, v_picks);
  reset role;
  select count(*) into v_n from public.predictions where user_id = v_m1 and session_id = v_q;
  r := r || case when v_id1 is not null and v_n = 1 then 'ok    ' else 'FAIL  ' end || E'a valid prediction saves and creates exactly one row\n';
  select created_at, updated_at into v_created, v_updated from public.predictions where id = v_id1;
  r := r || case when v_created = v_updated then 'ok    ' else 'FAIL  ' end || E'a new prediction has created_at = updated_at\n';

  -- Make it look as if it had been saved two hours ago (now() cannot move inside one transaction).
  update public.predictions set created_at = created_at - interval '2 hours', updated_at = updated_at - interval '2 hours' where id = v_id1;
  select created_at into v_created from public.predictions where id = v_id1;

  -- 2. Saving the same picks again changes nothing -----------------------------------------------------------------------------
  set local role authenticated;
  v_id2 := public.submit_prediction(v_q, v_picks);
  reset role;
  select updated_at into v_updated from public.predictions where id = v_id1;
  r := r || case when v_id2 = v_id1 then 'ok    ' else 'FAIL  ' end || E'saving identical picks returns the same prediction\n';
  r := r || case when v_updated = v_created then 'ok    ' else 'FAIL  ' end || E'saving identical picks does not move updated_at\n';

  -- 3. A real change moves updated_at, keeps created_at and the same row ---------------------------------------------------------
  set local role authenticated;
  v_id3 := public.submit_prediction(v_q, v_swap);
  reset role;
  select count(*) into v_n from public.predictions where user_id = v_m1 and session_id = v_q;
  r := r || case when v_id3 = v_id1 and v_n = 1 then 'ok    ' else 'FAIL  ' end || E'a changed prediction replaces the old one (same row, still one row)\n';
  select created_at, updated_at into v_created, v_updated from public.predictions where id = v_id1;
  r := r || case when v_updated > v_created then 'ok    ' else 'FAIL  ' end || E'a real change moves updated_at past created_at\n';
  r := r || case when v_created < now() - interval '90 minutes' then 'ok    ' else 'FAIL  ' end || E'a real change keeps the original created_at\n';
  r := r || case when (select picks from public.predictions where id = v_id1) = v_swap then 'ok    ' else 'FAIL  ' end || E'the new picks are what is stored\n';

  -- 4. Invalid picks are refused and leave the saved picks alone -----------------------------------------------------------------
  set local role authenticated;
  v_msg := null;
  begin
    perform public.submit_prediction(v_q, jsonb_set(v_picks, '{q1_out}', '["2026-per","2026-pia","2026-rus","2026-sai","2026-str"]'));
  exception when others then v_msg := sqlerrm; end;
  r := r || case when v_msg is not null then 'ok    ' else 'FAIL  ' end || E'five drivers where six are needed is refused\n';

  v_msg := null;
  begin
    perform public.submit_prediction(v_q, jsonb_set(v_picks, '{q1_out,0}', '"2026-alb"'));
  exception when others then v_msg := sqlerrm; end;
  r := r || case when v_msg is not null then 'ok    ' else 'FAIL  ' end || E'the same driver in two groups is refused\n';

  v_msg := null;
  begin
    perform public.submit_prediction(v_q, jsonb_set(v_picks, '{q1_out,0}', '"2026-zzz"'));
  exception when others then v_msg := sqlerrm; end;
  r := r || case when v_msg is not null then 'ok    ' else 'FAIL  ' end || E'an unknown driver is refused\n';

  v_msg := null;
  begin
    perform public.submit_prediction(v_q, '{}'::jsonb);
  exception when others then v_msg := sqlerrm; end;
  r := r || case when v_msg is not null then 'ok    ' else 'FAIL  ' end || E'an empty prediction is refused\n';
  reset role;
  r := r || case when (select picks from public.predictions where id = v_id1) = v_swap then 'ok    ' else 'FAIL  ' end || E'refused saves leave the stored picks unchanged\n';

  -- 5. Who may save --------------------------------------------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_stranger, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_stranger::text, true);
  set local role authenticated;
  v_msg := null; v_code := null;
  begin
    perform public.submit_prediction(v_q, v_picks);
  exception when others then v_msg := sqlerrm; v_code := sqlstate; end;
  reset role;
  r := r || case when v_msg = 'Join the friends group before predicting' and v_code = '42501' then 'ok    ' else 'FAIL  ' end || E'someone who has not joined the group cannot predict\n';

  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  set local role authenticated;
  v_msg := null; v_code := null;
  begin
    perform public.submit_prediction(v_q, v_picks);
  exception when others then v_msg := sqlerrm; v_code := sqlstate; end;
  reset role;
  r := r || case when v_msg = 'You must be signed in' and v_code = '28000' then 'ok    ' else 'FAIL  ' end || E'nobody signed in cannot predict\n';

  perform set_config('request.jwt.claims', json_build_object('sub', v_m1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m1::text, true);
  set local role authenticated;
  v_msg := null;
  begin
    perform public.submit_prediction('sqltest-submit-no-such-session', v_picks);
  exception when others then v_msg := sqlerrm; end;
  reset role;
  r := r || case when v_msg = 'Unknown session' then 'ok    ' else 'FAIL  ' end || E'an unknown session is refused\n';

  -- 6. Closed sessions -------------------------------------------------------------------------------------------------------------
  update public.sessions set start_utc = now() - interval '1 minute' where id = v_q;
  set local role authenticated;
  v_msg := null; v_code := null;
  begin perform public.submit_prediction(v_q, v_picks); exception when others then v_msg := sqlerrm; v_code := sqlstate; end;
  reset role;
  r := r || case when v_msg = 'Predictions are closed for this session' and v_code = '55000' then 'ok    ' else 'FAIL  ' end || E'a session that has started is closed\n';

  update public.sessions set start_utc = null where id = v_q;
  set local role authenticated;
  v_msg := null;
  begin perform public.submit_prediction(v_q, v_picks); exception when others then v_msg := sqlerrm; end;
  reset role;
  r := r || case when v_msg = 'Predictions are closed for this session' then 'ok    ' else 'FAIL  ' end || E'a session with no start time is closed\n';

  update public.sessions set start_utc = now() + interval '2 days' where id = v_q;
  update public.events set status = 'postponed' where id = v_ev;
  set local role authenticated;
  v_msg := null;
  begin perform public.submit_prediction(v_q, v_picks); exception when others then v_msg := sqlerrm; end;
  reset role;
  r := r || case when v_msg = 'Predictions are closed for this session' then 'ok    ' else 'FAIL  ' end || E'a postponed event is closed\n';
  update public.events set status = 'cancelled' where id = v_ev;
  set local role authenticated;
  v_msg := null;
  begin perform public.submit_prediction(v_q, v_picks); exception when others then v_msg := sqlerrm; end;
  reset role;
  r := r || case when v_msg = 'Predictions are closed for this session' then 'ok    ' else 'FAIL  ' end || E'a cancelled event is closed\n';
  update public.events set status = 'scheduled' where id = v_ev;

  -- 7. Privacy: other players see a prediction only once its session has started -----------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_m2, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m2::text, true);
  set local role authenticated;
  select count(*) into v_n from public.predictions where session_id = v_q and user_id = v_m1;
  reset role;
  r := r || case when v_n = 0 then 'ok    ' else 'FAIL  ' end || E'a group-mate cannot see the prediction before the session starts\n';

  update public.sessions set start_utc = now() - interval '1 minute' where id = v_q;
  set local role authenticated;
  select count(*) into v_n from public.predictions where session_id = v_q and user_id = v_m1;
  reset role;
  r := r || case when v_n = 1 then 'ok    ' else 'FAIL  ' end || E'a group-mate can see it once the session has started\n';

  -- 8. No direct writes ---------------------------------------------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_m1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m1::text, true);
  set local role authenticated;
  v_code := null;
  begin
    insert into public.predictions (user_id, session_id, picks) values (v_m1, v_q, v_picks);
  exception when others then v_code := sqlstate; end;
  reset role;
  r := r || case when v_code = '42501' then 'ok    ' else 'FAIL  ' end || E'writing to the predictions table directly is refused\n';

  raise exception E'SUBMIT PREDICTION TEST REPORT (this error is expected; everything was rolled back)\nRESULT: %\n%',
    case when r like '%FAIL%' then 'FAILURES' else 'ALL OK' end, r;
end;
$$;
