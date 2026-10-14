-- Self-cleaning test: everything is undone by the final deliberate error.
do $$
declare
  v_user   uuid;
  v_other  uuid := gen_random_uuid();
  v_res    text := '';
  v_count  integer;
  v_p1     text;
begin
  select user_id into v_user from public.group_members order by joined_at limit 1;
  if v_user is null then
    raise exception 'No group member found: complete Milestone 7 first';
  end if;

  -- Temporary test data (removed by the rollback at the end)
  insert into public.drivers (id, season, code, full_name, team_name) values
    ('zz-a', 2027, 'ZZA', 'Test Driver A', 'Test Team'),
    ('zz-b', 2027, 'ZZB', 'Test Driver B', 'Test Team'),
    ('zz-c', 2027, 'ZZC', 'Test Driver C', 'Test Team'),
    ('zz-d', 2027, 'ZZD', 'Test Driver D', 'Test Team'),
    ('zz-e', 2027, 'ZZE', 'Test Driver E', 'Test Team'),
    ('zz-f', 2027, 'ZZF', 'Test Driver F', 'Test Team');

  update public.sessions set start_utc = now() + interval '1 day'
    where id in ('bahrain-2027-qualifying', 'australia-2027-sprint_qualifying');
  update public.sessions set start_utc = now() - interval '1 hour'
    where id = 'japan-2027-sprint_qualifying';

  -- Act as the signed-in group member
  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- T1: valid race prediction is accepted
  begin
    perform public.submit_prediction('bahrain-2027-race', 'zz-a', 'zz-b', 'zz-c', 'zz-d', 'zz-e', 'zz-a', 'zz-b');
    v_res := v_res || E'\nT1  valid race prediction accepted: PASS';
  exception when others then
    v_res := v_res || E'\nT1  valid race prediction accepted: FAIL (' || sqlerrm || ')';
  end;

  -- T2: sprint whose lock time has passed is rejected
  begin
    perform public.submit_prediction('japan-2027-sprint', 'zz-a', 'zz-b', 'zz-c');
    v_res := v_res || E'\nT2  sprint after lock rejected: FAIL (was accepted)';
  exception when others then
    v_res := v_res || E'\nT2  sprint after lock rejected: ' ||
      case when sqlerrm like '%closed%' then 'PASS' else 'FAIL (' || sqlerrm || ')' end;
  end;

  -- T3: session with no confirmed time is rejected
  begin
    perform public.submit_prediction('saudi-arabia-2027-race', 'zz-a', 'zz-b', 'zz-c', 'zz-d', 'zz-e', 'zz-a', 'zz-b');
    v_res := v_res || E'\nT3  unknown session time rejected: FAIL (was accepted)';
  exception when others then
    v_res := v_res || E'\nT3  unknown session time rejected: ' ||
      case when sqlerrm like '%closed%' then 'PASS' else 'FAIL (' || sqlerrm || ')' end;
  end;

  -- T4: the same driver in two positions is rejected
  begin
    perform public.submit_prediction('bahrain-2027-race', 'zz-a', 'zz-a', 'zz-c', 'zz-d', 'zz-e', 'zz-a', 'zz-b');
    v_res := v_res || E'\nT4  duplicate positions rejected: FAIL (was accepted)';
  exception when others then
    v_res := v_res || E'\nT4  duplicate positions rejected: ' ||
      case when sqlerrm like '%different driver%' then 'PASS' else 'FAIL (' || sqlerrm || ')' end;
  end;

  -- T5: unknown driver is rejected
  begin
    perform public.submit_prediction('bahrain-2027-race', 'zz-a', 'zz-b', 'zz-c', 'zz-d', 'zz-nope', 'zz-a', 'zz-b');
    v_res := v_res || E'\nT5  unknown driver rejected: FAIL (was accepted)';
  exception when others then
    v_res := v_res || E'\nT5  unknown driver rejected: ' ||
      case when sqlerrm like '%Unknown or inactive%' then 'PASS' else 'FAIL (' || sqlerrm || ')' end;
  end;

  -- T6: resubmitting updates the same row (still exactly one row)
  begin
    perform public.submit_prediction('bahrain-2027-race', 'zz-c', 'zz-b', 'zz-a', 'zz-d', 'zz-e', 'zz-c', 'zz-b');
    select count(*), max(p1) into v_count, v_p1
      from public.predictions
      where user_id = v_user and session_id = 'bahrain-2027-race';
    v_res := v_res || E'\nT6  resubmit updates one row: ' ||
      case when v_count = 1 and v_p1 = 'zz-c' then 'PASS' else 'FAIL (rows=' || v_count || ', p1=' || coalesce(v_p1, 'null') || ')' end;
  exception when others then
    v_res := v_res || E'\nT6  resubmit updates one row: FAIL (' || sqlerrm || ')';
  end;

  -- T7: valid sprint prediction (three picks) is accepted
  begin
    perform public.submit_prediction('australia-2027-sprint', 'zz-a', 'zz-b', 'zz-c');
    v_res := v_res || E'\nT7  valid sprint prediction accepted: PASS';
  exception when others then
    v_res := v_res || E'\nT7  valid sprint prediction accepted: FAIL (' || sqlerrm || ')';
  end;

  -- T8: sprint with extra picks is rejected
  begin
    perform public.submit_prediction('australia-2027-sprint', 'zz-a', 'zz-b', 'zz-c', 'zz-d');
    v_res := v_res || E'\nT8  sprint with extra picks rejected: FAIL (was accepted)';
  exception when others then
    v_res := v_res || E'\nT8  sprint with extra picks rejected: ' ||
      case when sqlerrm like '%only three%' then 'PASS' else 'FAIL (' || sqlerrm || ')' end;
  end;

  -- T9: race with missing picks is rejected
  begin
    perform public.submit_prediction('bahrain-2027-race', 'zz-a', 'zz-b', 'zz-c');
    v_res := v_res || E'\nT9  race with missing picks rejected: FAIL (was accepted)';
  exception when others then
    v_res := v_res || E'\nT9  race with missing picks rejected: ' ||
      case when sqlerrm like '%All seven%' then 'PASS' else 'FAIL (' || sqlerrm || ')' end;
  end;

  -- T10: writing directly to the table is blocked
  begin
    insert into public.predictions (user_id, session_id, p1, p2, p3)
    values (v_user, 'bahrain-2027-race', 'zz-a', 'zz-b', 'zz-c');
    v_res := v_res || E'\nT10 direct insert blocked: FAIL (was accepted)';
  exception when others then
    v_res := v_res || E'\nT10 direct insert blocked: ' ||
      case when sqlerrm like '%permission denied%' then 'PASS' else 'FAIL (' || sqlerrm || ')' end;
  end;

  -- Now act as a signed-in stranger who is not in the group
  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_other, 'role', 'authenticated')::text, true);

  -- T11: a non-member cannot submit
  begin
    perform public.submit_prediction('bahrain-2027-race', 'zz-a', 'zz-b', 'zz-c', 'zz-d', 'zz-e', 'zz-a', 'zz-b');
    v_res := v_res || E'\nT11 non-member rejected: FAIL (was accepted)';
  exception when others then
    v_res := v_res || E'\nT11 non-member rejected: ' ||
      case when sqlerrm like '%Join the friends group%' then 'PASS' else 'FAIL (' || sqlerrm || ')' end;
  end;

  -- T12: a stranger cannot read other people's predictions
  select count(*) into v_count from public.predictions where user_id = v_user;
  v_res := v_res || E'\nT12 stranger cannot read predictions: ' ||
    case when v_count = 0 then 'PASS' else 'FAIL (saw ' || v_count || ' rows)' end;

  reset role;

  -- Deliberate error: undoes ALL test data above.
  raise exception 'TEST RESULTS (everything was rolled back, nothing was saved):%', v_res;
end;
$$;
