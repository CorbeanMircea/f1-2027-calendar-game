-- Self-cleaning test: everything is undone by the final deliberate error.
do $$
declare
  v_user    uuid;
  v_other   uuid := gen_random_uuid();
  v_res     text := '';
  v_j       jsonb;
  v_cnt     integer;
  v_pts     integer;
  v_status  text;
  v_first   text;
  v_q1 jsonb; v_q2 jsonb; v_q3 jsonb; v_top8 jsonb;
  v_q3_swap jsonb; v_q1_mis jsonb; v_q2_mis jsonb; v_top8_swap jsonb;
  v_quali jsonb; v_race_pred jsonb; v_race_act jsonb;
  v_r1 uuid; v_r2 uuid; v_r3 uuid; v_r4 uuid; v_r5 uuid; v_r6 uuid;
begin
  select user_id into v_user from public.group_members order by joined_at limit 1;
  if v_user is null then
    raise exception 'No group member found: complete Milestone 7 first';
  end if;

  -- 22 temporary test drivers for season 2027
  insert into public.drivers (id, season, code, full_name, team_name)
  select 'zz-' || lpad(g::text, 2, '0'), 2027, 'ZZ' || chr(64 + g), 'Test Driver ' || g, 'Test Team'
  from generate_series(1, 22) as g;

  -- Building blocks
  select jsonb_agg('zz-' || lpad(g::text, 2, '0') order by g) into v_q1  from generate_series(17, 22) as g;
  select jsonb_agg('zz-' || lpad(g::text, 2, '0') order by g) into v_q2  from generate_series(11, 16) as g;
  select jsonb_agg('zz-' || lpad(g::text, 2, '0') order by g) into v_q3  from generate_series(1, 10) as g;
  select jsonb_agg('zz-' || lpad(g::text, 2, '0') order by g) into v_top8 from generate_series(1, 8) as g;

  v_q3_swap   := jsonb_build_array('zz-02', 'zz-01') ||
                 (select jsonb_agg('zz-' || lpad(g::text, 2, '0') order by g) from generate_series(3, 10) as g);
  v_top8_swap := jsonb_build_array('zz-02', 'zz-01') ||
                 (select jsonb_agg('zz-' || lpad(g::text, 2, '0') order by g) from generate_series(3, 8) as g);
  v_q1_mis    := (select jsonb_agg('zz-' || lpad(g::text, 2, '0') order by g) from generate_series(17, 21) as g)
                 || '["zz-11"]'::jsonb;
  v_q2_mis    := '["zz-22"]'::jsonb ||
                 (select jsonb_agg('zz-' || lpad(g::text, 2, '0') order by g) from generate_series(12, 16) as g);

  v_quali     := jsonb_build_object('q1_out', v_q1, 'q2_out', v_q2, 'q3_order', v_q3);
  v_race_pred := jsonb_build_object('top8', v_top8, 'fastest_lap', 'zz-05',
                                    'any_dnf', true, 'dnf_count', 1, 'dnf_driver', 'zz-03');
  v_race_act  := jsonb_build_object('top8', v_top8, 'fastest_lap', 'zz-05',
                                    'dnf_drivers', jsonb_build_array('zz-03'), 'grid_top8', v_top8);

  -- ===== Pure scoring =====
  v_j := public.calc_points('qualifying', v_quali, v_quali);
  v_res := v_res || E'\nS1  perfect qualifying = 62: ' ||
    case when (v_j ->> 'total')::int = 62 then 'PASS' else 'FAIL (' || v_j::text || ')' end;

  v_j := public.calc_points('qualifying',
           jsonb_build_object('q1_out', v_q1, 'q2_out', v_q2, 'q3_order', v_q3_swap), v_quali);
  v_res := v_res || E'\nS2  qualifying with P1/P2 swapped = 46: ' ||
    case when (v_j ->> 'total')::int = 46 then 'PASS' else 'FAIL (' || v_j::text || ')' end;

  v_j := public.calc_points('sprint_qualifying',
           jsonb_build_object('q1_out', v_q1_mis, 'q2_out', v_q2_mis, 'q3_order', v_q3), v_quali);
  v_res := v_res || E'\nS3  qualifying with two drivers in the wrong group = 60: ' ||
    case when (v_j ->> 'total')::int = 60 then 'PASS' else 'FAIL (' || v_j::text || ')' end;

  v_j := public.calc_points('race', v_race_pred, v_race_act);
  v_res := v_res || E'\nS4  perfect race = 73: ' ||
    case when (v_j ->> 'total')::int = 73 then 'PASS' else 'FAIL (' || v_j::text || ')' end;

  v_j := public.calc_points('race',
           jsonb_build_object('top8', v_top8, 'fastest_lap', 'zz-05', 'any_dnf', true,
                              'dnf_count', 1, 'dnf_driver', 'zz-20'),
           jsonb_build_object('top8', v_top8, 'fastest_lap', 'zz-05',
                              'dnf_drivers', jsonb_build_array('zz-20'), 'grid_top8', v_top8));
  v_res := v_res || E'\nS5  DNF from outside the top-8 grid scores 4, not 8 (total 69): ' ||
    case when (v_j ->> 'total')::int = 69 and (v_j ->> 'dnf_driver')::int = 4
         then 'PASS' else 'FAIL (' || v_j::text || ')' end;

  v_j := public.calc_points('race',
           jsonb_build_object('top8', v_top8_swap, 'fastest_lap', 'zz-09', 'any_dnf', true,
                              'dnf_count', 2, 'dnf_driver', 'zz-19'),
           jsonb_build_object('top8', v_top8, 'fastest_lap', 'zz-05',
                              'dnf_drivers', jsonb_build_array('zz-20'), 'grid_top8', v_top8));
  v_res := v_res || E'\nS6  partly right race = 38: ' ||
    case when (v_j ->> 'total')::int = 38 then 'PASS' else 'FAIL (' || v_j::text || ')' end;

  v_j := public.calc_points('race',
           jsonb_build_object('top8', v_top8, 'fastest_lap', 'zz-05', 'any_dnf', false,
                              'dnf_count', 0, 'dnf_driver', null),
           jsonb_build_object('top8', v_top8, 'fastest_lap', 'zz-05',
                              'dnf_drivers', '[]'::jsonb, 'grid_top8', v_top8));
  v_res := v_res || E'\nS7  race with no DNFs predicted correctly = 65: ' ||
    case when (v_j ->> 'total')::int = 65 then 'PASS' else 'FAIL (' || v_j::text || ')' end;

  v_j := public.calc_points('sprint', jsonb_build_object('top8', v_top8), jsonb_build_object('top8', v_top8));
  v_res := v_res || E'\nS8  perfect sprint = 32: ' ||
    case when (v_j ->> 'total')::int = 32 then 'PASS' else 'FAIL (' || v_j::text || ')' end;

  v_j := public.calc_points('sprint', jsonb_build_object('top8', v_top8_swap), jsonb_build_object('top8', v_top8));
  v_res := v_res || E'\nS9  sprint with P1/P2 swapped = 20: ' ||
    case when (v_j ->> 'total')::int = 20 then 'PASS' else 'FAIL (' || v_j::text || ')' end;

  -- ===== Setup for the predictions flow =====
  update public.sessions set start_utc = now() + interval '1 day'
    where id = 'bahrain-2027-qualifying';
  update public.sessions set start_utc = now() + interval '12 hours'
    where id = 'bahrain-2027-sprint_qualifying';

  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- V1-V4: valid predictions for all four session types
  begin
    perform public.submit_prediction('bahrain-2027-qualifying', v_quali);
    v_res := v_res || E'\nV1  qualifying prediction accepted: PASS';
  exception when others then
    v_res := v_res || E'\nV1  qualifying prediction accepted: FAIL (' || sqlerrm || ')';
  end;

  begin
    perform public.submit_prediction('bahrain-2027-sprint_qualifying', v_quali);
    v_res := v_res || E'\nV2  sprint qualifying prediction accepted: PASS';
  exception when others then
    v_res := v_res || E'\nV2  sprint qualifying prediction accepted: FAIL (' || sqlerrm || ')';
  end;

  begin
    perform public.submit_prediction('bahrain-2027-race', v_race_pred);
    v_res := v_res || E'\nV3  race prediction accepted: PASS';
  exception when others then
    v_res := v_res || E'\nV3  race prediction accepted: FAIL (' || sqlerrm || ')';
  end;

  begin
    perform public.submit_prediction('bahrain-2027-sprint', jsonb_build_object('top8', v_top8));
    v_res := v_res || E'\nV4  sprint prediction accepted: PASS';
  exception when others then
    v_res := v_res || E'\nV4  sprint prediction accepted: FAIL (' || sqlerrm || ')';
  end;

  -- V5: wrong list size
  begin
    perform public.submit_prediction('bahrain-2027-qualifying',
      jsonb_build_object('q1_out',
        (select jsonb_agg('zz-' || lpad(g::text, 2, '0') order by g) from generate_series(18, 22) as g),
        'q2_out', v_q2, 'q3_order', v_q3));
    v_res := v_res || E'\nV5  wrong list size rejected: FAIL (was accepted)';
  exception when others then
    v_res := v_res || E'\nV5  wrong list size rejected: ' ||
      case when sqlerrm like '%must contain%' then 'PASS' else 'FAIL (' || sqlerrm || ')' end;
  end;

  -- V6: a driver in two groups
  begin
    perform public.submit_prediction('bahrain-2027-qualifying',
      jsonb_build_object('q1_out',
        (select jsonb_agg('zz-' || lpad(g::text, 2, '0') order by g) from generate_series(17, 21) as g)
        || '["zz-01"]'::jsonb,
        'q2_out', v_q2, 'q3_order', v_q3));
    v_res := v_res || E'\nV6  driver in two groups rejected: FAIL (was accepted)';
  exception when others then
    v_res := v_res || E'\nV6  driver in two groups rejected: ' ||
      case when sqlerrm like '%only once%' then 'PASS' else 'FAIL (' || sqlerrm || ')' end;
  end;

  -- V7: contradictory DNF answers
  begin
    perform public.submit_prediction('bahrain-2027-race',
      jsonb_build_object('top8', v_top8, 'fastest_lap', 'zz-05',
                         'any_dnf', false, 'dnf_count', 3));
    v_res := v_res || E'\nV7  contradictory DNF answers rejected: FAIL (was accepted)';
  exception when others then
    v_res := v_res || E'\nV7  contradictory DNF answers rejected: ' ||
      case when sqlerrm like '%consistent%' then 'PASS' else 'FAIL (' || sqlerrm || ')' end;
  end;

  -- V8: unexpected field
  begin
    perform public.submit_prediction('bahrain-2027-sprint',
      jsonb_build_object('top8', v_top8, 'bonus_points', 100));
    v_res := v_res || E'\nV8  unexpected field rejected: FAIL (was accepted)';
  exception when others then
    v_res := v_res || E'\nV8  unexpected field rejected: ' ||
      case when sqlerrm like '%Unexpected%' then 'PASS' else 'FAIL (' || sqlerrm || ')' end;
  end;

  -- V9: unknown session time stays closed
  begin
    perform public.submit_prediction('saudi-arabia-2027-qualifying', v_quali);
    v_res := v_res || E'\nV9  unknown session time rejected: FAIL (was accepted)';
  exception when others then
    v_res := v_res || E'\nV9  unknown session time rejected: ' ||
      case when sqlerrm like '%closed%' then 'PASS' else 'FAIL (' || sqlerrm || ')' end;
  end;

  -- V10: resubmitting replaces the same row
  begin
    perform public.submit_prediction('bahrain-2027-qualifying',
      jsonb_build_object('q1_out', v_q1, 'q2_out', v_q2, 'q3_order', v_q3_swap));
    select count(*), max(picks -> 'q3_order' ->> 0) into v_cnt, v_first
      from public.predictions
      where user_id = v_user and session_id = 'bahrain-2027-qualifying';
    v_res := v_res || E'\nV10 resubmit updates one row: ' ||
      case when v_cnt = 1 and v_first = 'zz-02' then 'PASS'
           else 'FAIL (rows=' || v_cnt || ', first=' || coalesce(v_first, 'null') || ')' end;
  exception when others then
    v_res := v_res || E'\nV10 resubmit updates one row: FAIL (' || sqlerrm || ')';
  end;

  -- V11: direct writes are blocked
  begin
    insert into public.predictions (user_id, session_id, picks)
    values (v_user, 'bahrain-2027-sprint', '{}'::jsonb);
    v_res := v_res || E'\nV11 direct insert blocked: FAIL (was accepted)';
  exception when others then
    v_res := v_res || E'\nV11 direct insert blocked: ' ||
      case when sqlerrm like '%permission denied%' then 'PASS' else 'FAIL (' || sqlerrm || ')' end;
  end;

  reset role;

  -- ===== Admin phase: lock the sessions, enter and approve results =====
  update public.sessions set start_utc = now() - interval '1 hour'
    where id in ('bahrain-2027-qualifying', 'bahrain-2027-sprint_qualifying');

  -- E1: a malformed result is rejected
  begin
    perform public.enter_result('bahrain-2027-race',
      jsonb_build_object('top8',
        (select jsonb_agg('zz-' || lpad(g::text, 2, '0') order by g) from generate_series(1, 7) as g),
        'fastest_lap', 'zz-05', 'dnf_drivers', '[]'::jsonb, 'grid_top8', v_top8));
    v_res := v_res || E'\nE1  malformed result rejected: FAIL (was accepted)';
  exception when others then
    v_res := v_res || E'\nE1  malformed result rejected: ' ||
      case when sqlerrm like '%must contain%' then 'PASS' else 'FAIL (' || sqlerrm || ')' end;
  end;

  -- R1: pending result gives no scores
  v_r1 := public.enter_result('bahrain-2027-race', v_race_act);
  select count(*) into v_cnt from public.scores where session_id = 'bahrain-2027-race';
  v_res := v_res || E'\nR1  pending result gives no scores: ' ||
    case when v_cnt = 0 then 'PASS' else 'FAIL (scores=' || v_cnt || ')' end;

  -- R2: approving scores the perfect race prediction (73)
  perform public.approve_result(v_r1);
  select points into v_pts from public.scores
    where user_id = v_user and session_id = 'bahrain-2027-race';
  v_res := v_res || E'\nR2  approved race result scores 73: ' ||
    case when v_pts = 73 then 'PASS' else 'FAIL (points=' || coalesce(v_pts::text, 'none') || ')' end;

  -- R3: a correction (the DNF was a different driver) rescores to 65
  v_r2 := public.enter_result('bahrain-2027-race',
    jsonb_build_object('top8', v_top8, 'fastest_lap', 'zz-05',
                       'dnf_drivers', jsonb_build_array('zz-20'), 'grid_top8', v_top8));
  perform public.approve_result(v_r2);
  select points into v_pts from public.scores
    where user_id = v_user and session_id = 'bahrain-2027-race';
  select status into v_status from public.results where id = v_r1;
  select count(*) into v_cnt from public.scores where session_id = 'bahrain-2027-race';
  v_res := v_res || E'\nR3  correction rescores to 65, old version superseded, one row: ' ||
    case when v_pts = 65 and v_status = 'superseded' and v_cnt = 1 then 'PASS'
         else 'FAIL (points=' || coalesce(v_pts::text, 'none') || ', old=' || coalesce(v_status, 'none') ||
              ', rows=' || v_cnt || ')' end;

  -- R4: qualifying result scores the latest (swapped) prediction: 46
  v_r3 := public.enter_result('bahrain-2027-qualifying', v_quali);
  perform public.approve_result(v_r3);
  select points into v_pts from public.scores
    where user_id = v_user and session_id = 'bahrain-2027-qualifying';
  v_res := v_res || E'\nR4  qualifying result scores the latest prediction (46): ' ||
    case when v_pts = 46 then 'PASS' else 'FAIL (points=' || coalesce(v_pts::text, 'none') || ')' end;

  -- R5: approving while predictions are open is refused (Australia has no time set)
  v_r4 := public.enter_result('australia-2027-race', v_race_act);
  begin
    perform public.approve_result(v_r4);
    v_res := v_res || E'\nR5  approve while open refused: FAIL (was accepted)';
  exception when others then
    v_res := v_res || E'\nR5  approve while open refused: ' ||
      case when sqlerrm like '%still open%' then 'PASS' else 'FAIL (' || sqlerrm || ')' end;
  end;

  -- A pending third version for Bahrain, to check it stays invisible
  v_r5 := public.enter_result('bahrain-2027-race', v_race_act);

  -- ===== Website view =====
  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into v_cnt from public.results;
  v_res := v_res || E'\nC1  only approved results are visible (2): ' ||
    case when v_cnt = 2 then 'PASS' else 'FAIL (visible=' || v_cnt || ')' end;

  begin
    perform public.approve_result(v_r5);
    v_res := v_res || E'\nC2  website cannot approve results: FAIL (was accepted)';
  exception when others then
    v_res := v_res || E'\nC2  website cannot approve results: ' ||
      case when sqlerrm like '%permission denied%' then 'PASS' else 'FAIL (' || sqlerrm || ')' end;
  end;

  select total_points into v_pts from public.leaderboard
    where season = 2027 and user_id = v_user;
  v_res := v_res || E'\nC3  leaderboard shows 65 + 46 = 111: ' ||
    case when v_pts = 111 then 'PASS' else 'FAIL (points=' || coalesce(v_pts::text, 'none') || ')' end;

  -- A stranger (not in the group) cannot see anyone's predictions
  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  select count(*) into v_cnt from public.predictions where user_id = v_user;
  v_res := v_res || E'\nC4  stranger cannot read predictions: ' ||
    case when v_cnt = 0 then 'PASS' else 'FAIL (saw ' || v_cnt || ' rows)' end;

  reset role;

  -- Deliberate error: undoes ALL test data above.
  raise exception 'TEST RESULTS (everything was rolled back, nothing was saved):%', v_res;
end;
$$;
