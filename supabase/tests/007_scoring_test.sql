-- Self-cleaning test: everything is undone by the final deliberate error.
do $$
declare
  v_user   uuid;
  v_res    text := '';
  v_j      jsonb;
  v_r1     uuid;
  v_r2     uuid;
  v_r3     uuid;
  v_r4     uuid;
  v_cnt    integer;
  v_pts    integer;
  v_status text;
begin
  select user_id into v_user from public.group_members order by joined_at limit 1;
  if v_user is null then
    raise exception 'No group member found: complete Milestone 7 first';
  end if;

  -- Temporary test data
  insert into public.drivers (id, season, code, full_name, team_name) values
    ('zz-a', 2027, 'ZZA', 'Test Driver A', 'Test Team'),
    ('zz-b', 2027, 'ZZB', 'Test Driver B', 'Test Team'),
    ('zz-c', 2027, 'ZZC', 'Test Driver C', 'Test Team'),
    ('zz-d', 2027, 'ZZD', 'Test Driver D', 'Test Team'),
    ('zz-e', 2027, 'ZZE', 'Test Driver E', 'Test Team'),
    ('zz-f', 2027, 'ZZF', 'Test Driver F', 'Test Team');

  -- Bahrain qualifying "started an hour ago": predictions are locked, results can be approved.
  update public.sessions set start_utc = now() - interval '1 hour'
    where id = 'bahrain-2027-qualifying';

  -- The worked example from the plan: A B C D E, pole A, fastest lap B
  insert into public.predictions (user_id, session_id, p1, p2, p3, p4, p5, pole, fastest_lap)
  values (v_user, 'bahrain-2027-race', 'zz-a', 'zz-b', 'zz-c', 'zz-d', 'zz-e', 'zz-a', 'zz-b');

  -- T1: worked example scores 14 (exact 5, in-top 6, pole 0, fastest lap 3, bonus 0)
  v_j := public.calc_points('race',
           array['zz-a','zz-b','zz-c','zz-d','zz-e'], 'zz-a', 'zz-b',
           array['zz-a','zz-c','zz-b','zz-f','zz-d'], 'zz-b', 'zz-b');
  v_res := v_res || E'\nT1  worked example = 14 points: ' ||
    case when (v_j ->> 'total')::int = 14 and (v_j ->> 'exact')::int = 5
          and (v_j ->> 'in_top')::int = 6 and (v_j ->> 'pole')::int = 0
          and (v_j ->> 'fastest_lap')::int = 3 and (v_j ->> 'bonus')::int = 0
         then 'PASS' else 'FAIL (' || v_j::text || ')' end;

  -- T2: perfect race prediction = 25 + 3 + 3 + 10 = 41
  v_j := public.calc_points('race',
           array['zz-a','zz-b','zz-c','zz-d','zz-e'], 'zz-a', 'zz-b',
           array['zz-a','zz-b','zz-c','zz-d','zz-e'], 'zz-a', 'zz-b');
  v_res := v_res || E'\nT2  perfect race = 41 points: ' ||
    case when (v_j ->> 'total')::int = 41 then 'PASS' else 'FAIL (' || v_j::text || ')' end;

  -- T3: sprint A B C vs actual A C B = 3 + 1 + 1 = 5
  v_j := public.calc_points('sprint',
           array['zz-a','zz-b','zz-c'], null, null,
           array['zz-a','zz-c','zz-b'], null, null);
  v_res := v_res || E'\nT3  sprint partly right = 5 points: ' ||
    case when (v_j ->> 'total')::int = 5 then 'PASS' else 'FAIL (' || v_j::text || ')' end;

  -- T4: perfect sprint = 9 + 3 = 12
  v_j := public.calc_points('sprint',
           array['zz-a','zz-b','zz-c'], null, null,
           array['zz-a','zz-b','zz-c'], null, null);
  v_res := v_res || E'\nT4  perfect sprint = 12 points: ' ||
    case when (v_j ->> 'total')::int = 12 then 'PASS' else 'FAIL (' || v_j::text || ')' end;

  -- Enter the worked-example result (pending). It must NOT score yet.
  v_r1 := public.enter_result('bahrain-2027-race',
            'zz-a', 'zz-c', 'zz-b', 'zz-f', 'zz-d', 'zz-b', 'zz-b');
  select count(*) into v_cnt from public.scores where session_id = 'bahrain-2027-race';
  v_res := v_res || E'\nT5  pending result gives no scores: ' ||
    case when v_cnt = 0 then 'PASS' else 'FAIL (scores=' || v_cnt || ')' end;

  -- T6: approving it creates the 14-point score
  perform public.approve_result(v_r1);
  select points into v_pts from public.scores
    where user_id = v_user and session_id = 'bahrain-2027-race';
  v_res := v_res || E'\nT6  approved result scores 14: ' ||
    case when v_pts = 14 then 'PASS' else 'FAIL (points=' || coalesce(v_pts::text, 'none') || ')' end;

  -- T7: a correction replaces the old result and rescores to 41
  v_r2 := public.enter_result('bahrain-2027-race',
            'zz-a', 'zz-b', 'zz-c', 'zz-d', 'zz-e', 'zz-a', 'zz-b');
  perform public.approve_result(v_r2);
  select points into v_pts from public.scores
    where user_id = v_user and session_id = 'bahrain-2027-race';
  select status into v_status from public.results where id = v_r1;
  select count(*) into v_cnt from public.scores where session_id = 'bahrain-2027-race';
  v_res := v_res || E'\nT7  correction rescored to 41, old version superseded, one score row: ' ||
    case when v_pts = 41 and v_status = 'superseded' and v_cnt = 1
         then 'PASS' else 'FAIL (points=' || coalesce(v_pts::text, 'none') ||
              ', old=' || coalesce(v_status, 'none') || ', rows=' || v_cnt || ')' end;

  -- T8: approving while predictions are still open is refused (Australia has no time set)
  v_r3 := public.enter_result('australia-2027-race',
            'zz-a', 'zz-b', 'zz-c', 'zz-d', 'zz-e', 'zz-a', 'zz-b');
  begin
    perform public.approve_result(v_r3);
    v_res := v_res || E'\nT8  approve while open refused: FAIL (was accepted)';
  exception when others then
    v_res := v_res || E'\nT8  approve while open refused: ' ||
      case when sqlerrm like '%still open%' then 'PASS' else 'FAIL (' || sqlerrm || ')' end;
  end;

  -- A new pending version for Bahrain, to check that it stays invisible
  v_r4 := public.enter_result('bahrain-2027-race',
            'zz-f', 'zz-e', 'zz-d', 'zz-c', 'zz-b', 'zz-a', 'zz-a');

  -- Act as the signed-in group member
  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- T9: only the approved result is visible to the website
  select count(*) into v_cnt from public.results;
  v_res := v_res || E'\nT9  only the approved result is visible: ' ||
    case when v_cnt = 1 then 'PASS' else 'FAIL (visible=' || v_cnt || ')' end;

  -- T10: the website cannot call the approval function
  begin
    perform public.approve_result(v_r4);
    v_res := v_res || E'\nT10 website cannot approve results: FAIL (was accepted)';
  exception when others then
    v_res := v_res || E'\nT10 website cannot approve results: ' ||
      case when sqlerrm like '%permission denied%' then 'PASS' else 'FAIL (' || sqlerrm || ')' end;
  end;

  -- T11: the leaderboard shows the player with 41 points
  select total_points into v_pts from public.leaderboard
    where season = 2027 and user_id = v_user;
  v_res := v_res || E'\nT11 leaderboard shows 41 points: ' ||
    case when v_pts = 41 then 'PASS' else 'FAIL (points=' || coalesce(v_pts::text, 'none') || ')' end;

  reset role;

  -- Deliberate error: undoes ALL test data above.
  raise exception 'TEST RESULTS (everything was rolled back, nothing was saved):%', v_res;
end;
$$;
