-- Self-cleaning test: everything is undone by the final deliberate error.
do $$
declare
  v_admin   uuid;
  v_other   uuid := gen_random_uuid();
  v_res     text := '';
  v_top8    jsonb;
  v_ov      jsonb;
  v_r1      uuid;
  v_r2      uuid;
  v_r3      uuid;
  v_status  text;
  v_by      uuid;
  v_flag    boolean;
begin
  select user_id into v_admin from public.group_members where role = 'admin' order by joined_at limit 1;
  if v_admin is null then
    raise exception 'No admin found: make yourself admin first (see the milestone instructions)';
  end if;

  insert into public.drivers (id, season, code, full_name, team_name)
  select 'zz-' || lpad(g::text, 2, '0'), 2027, 'ZZ' || chr(64 + g), 'Test Driver ' || g, 'Test Team'
  from generate_series(1, 22) as g;

  select jsonb_agg('zz-' || lpad(g::text, 2, '0') order by g) into v_top8
  from generate_series(1, 8) as g;

  -- Bahrain sprint predictions are locked (sprint qualifying "started an hour ago").
  -- The Australia sprint has no time set, so its predictions count as still open.
  update public.sessions set start_utc = now() - interval '1 hour'
    where id = 'bahrain-2027-sprint_qualifying';

  v_r1 := public.enter_result('bahrain-2027-sprint', jsonb_build_object('top8', v_top8));
  v_r2 := public.enter_result('bahrain-2027-sprint', jsonb_build_object('top8', v_top8));
  v_r3 := public.enter_result('australia-2027-sprint', jsonb_build_object('top8', v_top8));

  -- ===== As the admin =====
  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;

  v_flag := public.is_admin();
  v_res := v_res || E'\nT1  is_admin is true for the admin: ' ||
    case when v_flag is true then 'PASS' else 'FAIL' end;

  v_ov := public.admin_overview();
  select (e ->> 'locked')::boolean into v_flag
  from jsonb_array_elements(v_ov -> 'pending') as e
  where e ->> 'id' = v_r1::text;
  v_res := v_res || E'\nT2  overview lists the pending result and flags it as locked: ' ||
    case when v_flag is true then 'PASS' else 'FAIL' end;

  v_res := v_res || E'\nT3  overview also returns the recent and log sections: ' ||
    case when jsonb_typeof(v_ov -> 'recent') = 'array' and jsonb_typeof(v_ov -> 'log') = 'array'
         then 'PASS' else 'FAIL' end;

  begin
    perform public.admin_approve_result(v_r1);
    select status, approved_by into v_status, v_by from public.results where id = v_r1;
    v_res := v_res || E'\nT4  admin approve works and records the approver: ' ||
      case when v_status = 'approved' and v_by = v_admin then 'PASS'
           else 'FAIL (status=' || coalesce(v_status, 'none') || ')' end;
  exception when others then
    v_res := v_res || E'\nT4  admin approve works and records the approver: FAIL (' || sqlerrm || ')';
  end;

  begin
    perform public.admin_reject_result(v_r2);
    v_res := v_res || E'\nT5  admin reject runs: PASS';
  exception when others then
    v_res := v_res || E'\nT5  admin reject runs: FAIL (' || sqlerrm || ')';
  end;

  reset role;
  select status into v_status from public.results where id = v_r2;
  v_res := v_res || E'\nT5b the rejected result has status rejected: ' ||
    case when v_status = 'rejected' then 'PASS' else 'FAIL (status=' || coalesce(v_status, 'none') || ')' end;
  set local role authenticated;

  begin
    perform public.admin_approve_result(v_r2);
    v_res := v_res || E'\nT6  a rejected result cannot be approved: FAIL (was accepted)';
  exception when others then
    v_res := v_res || E'\nT6  a rejected result cannot be approved: ' ||
      case when sqlerrm like '%not pending%' then 'PASS' else 'FAIL (' || sqlerrm || ')' end;
  end;

  begin
    perform public.admin_approve_result(v_r3);
    v_res := v_res || E'\nT7  approving while predictions are open is refused: FAIL (was accepted)';
  exception when others then
    v_res := v_res || E'\nT7  approving while predictions are open is refused: ' ||
      case when sqlerrm like '%still open%' then 'PASS' else 'FAIL (' || sqlerrm || ')' end;
  end;

  -- ===== As a signed-in person who is not an admin =====
  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_other, 'role', 'authenticated')::text, true);

  v_flag := public.is_admin();
  v_res := v_res || E'\nN1  is_admin is false for everyone else: ' ||
    case when v_flag is false then 'PASS' else 'FAIL' end;

  begin
    perform public.admin_overview();
    v_res := v_res || E'\nN2  non-admin cannot read the overview: FAIL (was accepted)';
  exception when others then
    v_res := v_res || E'\nN2  non-admin cannot read the overview: ' ||
      case when sqlerrm like '%Admins only%' then 'PASS' else 'FAIL (' || sqlerrm || ')' end;
  end;

  begin
    perform public.admin_approve_result(v_r3);
    v_res := v_res || E'\nN3  non-admin cannot approve: FAIL (was accepted)';
  exception when others then
    v_res := v_res || E'\nN3  non-admin cannot approve: ' ||
      case when sqlerrm like '%Admins only%' then 'PASS' else 'FAIL (' || sqlerrm || ')' end;
  end;

  begin
    perform public.admin_reject_result(v_r3);
    v_res := v_res || E'\nN4  non-admin cannot reject: FAIL (was accepted)';
  exception when others then
    v_res := v_res || E'\nN4  non-admin cannot reject: ' ||
      case when sqlerrm like '%Admins only%' then 'PASS' else 'FAIL (' || sqlerrm || ')' end;
  end;

  reset role;

  raise exception 'TEST RESULTS (everything was rolled back, nothing was saved):%', v_res;
end;
$$;
