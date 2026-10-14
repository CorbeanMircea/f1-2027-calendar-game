-- Self-cleaning test: everything is undone by the final deliberate error.
do $$
declare
  v_user  uuid;
  v_res   text := '';
  v_top8  jsonb;
begin
  select user_id into v_user from public.group_members order by joined_at limit 1;
  if v_user is null then
    raise exception 'No group member found: complete Milestone 7 first';
  end if;

  insert into public.drivers (id, season, code, full_name, team_name)
  select 'zz-' || lpad(g::text, 2, '0'), 2027, 'ZZ' || chr(64 + g), 'Test Driver ' || g, 'Test Team'
  from generate_series(1, 22) as g;

  select jsonb_agg('zz-' || lpad(g::text, 2, '0') order by g) into v_top8
  from generate_series(1, 8) as g;

  update public.sessions set start_utc = now() + interval '1 day'
    where id = 'bahrain-2027-qualifying';

  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- D1: DNF driver outside the top 8 is accepted
  begin
    perform public.submit_prediction('bahrain-2027-race',
      jsonb_build_object('top8', v_top8, 'fastest_lap', 'zz-05',
                         'any_dnf', true, 'dnf_count', 2, 'dnf_driver', 'zz-20'));
    v_res := v_res || E'\nD1  DNF driver outside the top 8 accepted: PASS';
  exception when others then
    v_res := v_res || E'\nD1  DNF driver outside the top 8 accepted: FAIL (' || sqlerrm || ')';
  end;

  -- D2: DNF driver who is also in the top 8 is rejected
  begin
    perform public.submit_prediction('bahrain-2027-race',
      jsonb_build_object('top8', v_top8, 'fastest_lap', 'zz-05',
                         'any_dnf', true, 'dnf_count', 1, 'dnf_driver', 'zz-03'));
    v_res := v_res || E'\nD2  DNF driver inside the top 8 rejected: FAIL (was accepted)';
  exception when others then
    v_res := v_res || E'\nD2  DNF driver inside the top 8 rejected: ' ||
      case when sqlerrm like '%predictions_dnf_not_in_top8%' then 'PASS' else 'FAIL (' || sqlerrm || ')' end;
  end;

  -- D3: skipping the DNF driver question is still allowed
  begin
    perform public.submit_prediction('bahrain-2027-race',
      jsonb_build_object('top8', v_top8, 'fastest_lap', 'zz-05',
                         'any_dnf', true, 'dnf_count', 1, 'dnf_driver', null));
    v_res := v_res || E'\nD3  skipping the DNF driver accepted: PASS';
  exception when others then
    v_res := v_res || E'\nD3  skipping the DNF driver accepted: FAIL (' || sqlerrm || ')';
  end;

  reset role;

  -- D4: a real result with DNFs outside the top 8 is accepted
  begin
    perform public.enter_result('bahrain-2027-race',
      jsonb_build_object('top8', v_top8, 'fastest_lap', 'zz-05',
                         'dnf_drivers', jsonb_build_array('zz-20', 'zz-21'), 'grid_top8', v_top8));
    v_res := v_res || E'\nD4  result with DNFs outside the top 8 accepted: PASS';
  exception when others then
    v_res := v_res || E'\nD4  result with DNFs outside the top 8 accepted: FAIL (' || sqlerrm || ')';
  end;

  -- D5: a real result where a top-8 driver is also a DNF is rejected
  begin
    perform public.enter_result('bahrain-2027-race',
      jsonb_build_object('top8', v_top8, 'fastest_lap', 'zz-05',
                         'dnf_drivers', jsonb_build_array('zz-03'), 'grid_top8', v_top8));
    v_res := v_res || E'\nD5  result with a top-8 DNF rejected: FAIL (was accepted)';
  exception when others then
    v_res := v_res || E'\nD5  result with a top-8 DNF rejected: ' ||
      case when sqlerrm like '%results_dnf_not_in_top8%' then 'PASS' else 'FAIL (' || sqlerrm || ')' end;
  end;

  raise exception 'TEST RESULTS (everything was rolled back, nothing was saved):%', v_res;
end;
$$;
