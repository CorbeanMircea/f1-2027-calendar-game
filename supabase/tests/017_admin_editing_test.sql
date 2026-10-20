-- Self-cleaning test: everything is undone by the final deliberate error.
do $$
declare
  v_admin  uuid;
  v_other  uuid := gen_random_uuid();
  v_res    text := '';
  v_top8   jsonb;
  v_swap   jsonb;
  v_quali  jsonb;
  v_ov     jsonb;
  v_r1     uuid;
  v_r2     uuid;
  v_r3     uuid;
  v_m1     uuid;
  v_n      integer;
  v_pts    integer;
  v_status text;
  v_source text;
  v_snap   jsonb;
  v_data   jsonb;
  v_flag   boolean;
begin
  select user_id into v_admin from public.group_members where role = 'admin' order by joined_at limit 1;
  if v_admin is null then
    raise exception 'No admin found: make yourself admin first';
  end if;

  insert into public.drivers (id, season, code, full_name, team_name)
  select 'zz-' || lpad(g::text, 2, '0'), 2027, 'ZZ' || chr(64 + g), 'Test Driver ' || g, 'Test Team'
  from generate_series(1, 22) as g;

  select jsonb_agg('zz-' || lpad(g::text, 2, '0') order by g) into v_top8 from generate_series(1, 8) as g;
  v_swap := jsonb_build_array('zz-02', 'zz-01') ||
            (select jsonb_agg('zz-' || lpad(g::text, 2, '0') order by g) from generate_series(3, 8) as g);
  v_quali := jsonb_build_object(
    'q1_out',   (select jsonb_agg('zz-' || lpad(g::text, 2, '0') order by g) from generate_series(17, 22) as g),
    'q2_out',   (select jsonb_agg('zz-' || lpad(g::text, 2, '0') order by g) from generate_series(11, 16) as g),
    'q3_order', (select jsonb_agg('zz-' || lpad(g::text, 2, '0') order by g) from generate_series(1, 10) as g));

  -- Bahrain sprint predictions are locked; the admin predicted the top 8 exactly.
  update public.sessions set start_utc = now() - interval '1 hour'
    where id = 'bahrain-2027-sprint_qualifying';
  insert into public.predictions (user_id, session_id, picks)
  values (v_admin, 'bahrain-2027-sprint', jsonb_build_object('top8', v_top8));

  v_r1 := public.enter_result('bahrain-2027-sprint', jsonb_build_object('top8', v_top8), 'jolpica');

  -- S1: the importer's result remembers the source data; a manual one does not
  select api_snapshot, data into v_snap, v_data from public.results where id = v_r1;
  v_res := v_res || E'\nS1  importer result remembers its source data: ' ||
    case when v_snap is not null and v_snap = v_data then 'PASS' else 'FAIL' end;

  -- ===== As the admin =====
  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;

  v_ov := public.admin_overview();
  select (e -> 'preview' -> 0 ->> 'points')::integer into v_pts
  from jsonb_array_elements(v_ov -> 'pending') as e where e ->> 'id' = v_r1::text;
  v_res := v_res || E'\nA1  score preview shows the 32 points a player would get: ' ||
    case when v_pts = 32 then 'PASS' else 'FAIL (points=' || coalesce(v_pts::text, 'none') || ')' end;

  select count(*) into v_n
  from jsonb_array_elements(v_ov -> 'missing') as e where e ->> 'session_id' = 'bahrain-2027-sprint_qualifying';
  v_res := v_res || E'\nA2  locked session without a result is listed as missing: ' ||
    case when v_n = 1 then 'PASS' else 'FAIL (found=' || v_n || ')' end;

  v_res := v_res || E'\nA3  pending count is available to the admin: ' ||
    case when public.admin_pending_count() >= 1 then 'PASS' else 'FAIL' end;

  -- Edit the pending result (swap P1 and P2)
  v_r2 := public.admin_save_result_edit(v_r1, jsonb_build_object('top8', v_swap));

  reset role;
  select status into v_status from public.results where id = v_r1;
  select status, source, api_snapshot into v_status, v_source, v_snap from public.results where id = v_r2;
  select data into v_data from public.results where id = v_r1;
  v_res := v_res || E'\nA4  editing a pending result saves a new pending version and keeps the source data: ' ||
    case when v_status = 'pending' and v_source = 'manual-edit' and v_snap = v_data
         and (select status from public.results where id = v_r1) = 'superseded'
         then 'PASS' else 'FAIL (status=' || coalesce(v_status, 'none') || ', source=' || coalesce(v_source, 'none') || ')' end;
  set local role authenticated;

  -- Approving the edit scores 20
  perform public.admin_approve_result(v_r2);
  select points into v_pts from public.scores where user_id = v_admin and session_id = 'bahrain-2027-sprint';
  v_res := v_res || E'\nA5  approving the edited result scores 20: ' ||
    case when v_pts = 20 then 'PASS' else 'FAIL (points=' || coalesce(v_pts::text, 'none') || ')' end;

  -- Correct the approved result back to the original order
  v_r3 := public.admin_save_result_edit(v_r2, jsonb_build_object('top8', v_top8));
  select status into v_status from public.results where id = v_r2;
  v_res := v_res || E'\nA6  correcting an approved result leaves it approved until the correction is approved: ' ||
    case when v_status = 'approved' then 'PASS' else 'FAIL (status=' || coalesce(v_status, 'none') || ')' end;

  perform public.admin_approve_result(v_r3);
  select points into v_pts from public.scores where user_id = v_admin and session_id = 'bahrain-2027-sprint';
  v_res := v_res || E'\nA7  approving the correction rescores to 32: ' ||
    case when v_pts = 32 then 'PASS' else 'FAIL (points=' || coalesce(v_pts::text, 'none') || ')' end;

  begin
    perform public.admin_save_result_edit(v_r3,
      jsonb_build_object('top8', (select jsonb_agg('zz-' || lpad(g::text, 2, '0') order by g) from generate_series(1, 7) as g)));
    v_res := v_res || E'\nA8  an invalid edit is rejected: FAIL (was accepted)';
  exception when others then
    v_res := v_res || E'\nA8  an invalid edit is rejected: ' ||
      case when sqlerrm like '%must contain%' then 'PASS' else 'FAIL (' || sqlerrm || ')' end;
  end;

  -- Manual entry for a session without a result
  begin
    v_m1 := public.admin_enter_manual_result('bahrain-2027-sprint_qualifying', v_quali);
    v_res := v_res || E'\nA9  manual entry creates a pending result: PASS';
  exception when others then
    v_res := v_res || E'\nA9  manual entry creates a pending result: FAIL (' || sqlerrm || ')';
  end;

  begin
    perform public.admin_enter_manual_result('bahrain-2027-sprint_qualifying', v_quali);
    v_res := v_res || E'\nA10 a second manual entry for the same session is refused: FAIL (was accepted)';
  exception when others then
    v_res := v_res || E'\nA10 a second manual entry for the same session is refused: ' ||
      case when sqlerrm like '%already exists%' then 'PASS' else 'FAIL (' || sqlerrm || ')' end;
  end;

  -- ===== Someone who is not an admin =====
  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_other, 'role', 'authenticated')::text, true);

  begin
    perform public.admin_save_result_edit(v_r3, jsonb_build_object('top8', v_swap));
    v_res := v_res || E'\nN1  non-admin cannot edit: FAIL (was accepted)';
  exception when others then
    v_res := v_res || E'\nN1  non-admin cannot edit: ' ||
      case when sqlerrm like '%Admins only%' then 'PASS' else 'FAIL (' || sqlerrm || ')' end;
  end;

  begin
    perform public.admin_enter_manual_result('australia-2027-sprint', v_quali);
    v_res := v_res || E'\nN2  non-admin cannot enter results: FAIL (was accepted)';
  exception when others then
    v_res := v_res || E'\nN2  non-admin cannot enter results: ' ||
      case when sqlerrm like '%Admins only%' then 'PASS' else 'FAIL (' || sqlerrm || ')' end;
  end;

  begin
    perform public.admin_pending_count();
    v_res := v_res || E'\nN3  non-admin cannot read the pending count: FAIL (was accepted)';
  exception when others then
    v_res := v_res || E'\nN3  non-admin cannot read the pending count: ' ||
      case when sqlerrm like '%Admins only%' then 'PASS' else 'FAIL (' || sqlerrm || ')' end;
  end;

  reset role;

  raise exception 'TEST RESULTS (everything was rolled back, nothing was saved):%', v_res;
end;
$$;
