-- Behaviour test for migration 026. Run it in the Supabase SQL Editor.
-- Like the 025 test, it builds temporary 2027 data, tries every rule, and ends with an ERROR ON PURPOSE.
-- The error rolls back EVERYTHING (nothing is kept) and its message is the report: every line starts with
-- "ok" or "FAIL", and the first line says "ALL OK" or "FAILURES".

do $$
declare
  r          text := '';
  ok         boolean;
  msg        text;
  n          integer;
  j          jsonb;
  v_over     jsonb;
  v_admin    uuid;
  v_nonadmin uuid;
  v_m1       uuid;
  v_m2       uuid;
  v_ds       text[];
  v_d1 text; v_d2 text; v_d3 text;
  v_t1 text; v_t2 text; v_t3 text;
  v_id1 uuid; v_id2 uuid; v_id3 uuid; v_id4 uuid;
  v_s1       integer;
  v_s2       integer;
  v_cnt0     bigint;
  v_sum0     bigint;
  v_cnt1     bigint;
  v_sum1     bigint;
  v_row      jsonb;
begin
  -- ---------- setup (all rolled back at the end) ----------
  select user_id into v_admin from public.group_members where role = 'admin' order by joined_at limit 1;
  select user_id into v_nonadmin from public.group_members where role <> 'admin' order by joined_at limit 1;
  select user_id into v_m1 from public.group_members where user_id <> v_admin order by joined_at limit 1;
  select user_id into v_m2 from public.group_members where user_id <> v_admin and user_id <> v_m1 order by joined_at limit 1;
  if v_admin is null or v_m1 is null or v_m2 is null then
    raise exception 'The test needs one admin and two other group members';
  end if;

  insert into public.drivers (id, season, code, full_name, team_name, car_number, external_id, is_active)
  select replace(d.id, '2026-', '2027-'), 2027, d.code, d.full_name, d.team_name, d.car_number, null, true
  from public.drivers d where d.season = 2026
  on conflict do nothing;

  select array_agg(x.id order by x.team_name) into v_ds
  from (select distinct on (d.team_name) d.id, d.team_name from public.drivers d
        where d.season = 2027 order by d.team_name, d.id limit 3) x;
  if v_ds is null or cardinality(v_ds) < 3 then
    raise exception 'The test needs 2026 drivers from at least three teams to copy into 2027';
  end if;
  v_d1 := v_ds[1]; v_d2 := v_ds[2]; v_d3 := v_ds[3];
  select team_name into v_t1 from public.drivers where id = v_d1;
  select team_name into v_t2 from public.drivers where id = v_d2;
  select team_name into v_t3 from public.drivers where id = v_d3;

  update public.sessions set start_utc = now() + interval '30 days'
   where event_id in (select id from public.events where season = 2027 and round = 1);
  update public.sessions set start_utc = now() + interval '60 days'
   where event_id in (select id from public.events where season = 2027 and round = 5);

  select count(*), coalesce(sum(points), 0) into v_cnt0, v_sum0 from public.scores;

  -- ---------- the scoring rule ----------
  j := public.calc_season_points(v_d1, v_t1, false, array[v_d1, v_d2, v_d3], array[v_t1, v_t2, v_t3]);
  r := r || case when (j ->> 'total')::int = 110 and (j ->> 'double')::int = 10 then 'ok    ' else 'FAIL  ' end || E'both champions right: 60 + 40 + 10 double = 110\n';
  j := public.calc_season_points(v_d2, v_t3, false, array[v_d1, v_d2, v_d3], array[v_t1, v_t2, v_t3]);
  r := r || case when (j ->> 'total')::int = 28 and (j ->> 'double')::int = 0 then 'ok    ' else 'FAIL  ' end || E'driver 2nd (20) + team 3rd (8) = 28, no double\n';
  j := public.calc_season_points(v_d1, v_t2, false, array[v_d1, v_d2, v_d3], array[v_t1, v_t2, v_t3]);
  r := r || case when (j ->> 'total')::int = 75 then 'ok    ' else 'FAIL  ' end || E'driver 1st (60) + team 2nd (15) = 75, no double\n';
  j := public.calc_season_points(v_d3, v_t3, false, array[v_d1, v_d2, v_d3], array[v_t1, v_t2, v_t3]);
  r := r || case when (j ->> 'total')::int = 18 then 'ok    ' else 'FAIL  ' end || E'both 3rd: 10 + 8 = 18\n';
  j := public.calc_season_points(v_d1, v_t1, true, array[v_d1, v_d2, v_d3], array[v_t1, v_t2, v_t3]);
  r := r || case when (j ->> 'total')::int = 55 and (j ->> 'subtotal')::int = 110 then 'ok    ' else 'FAIL  ' end || E'half value halves 110 to 55\n';
  j := public.calc_season_points(v_d1, v_t2, true, array[v_d1, v_d2, v_d3], array[v_t1, v_t2, v_t3]);
  r := r || case when (j ->> 'total')::int = 37 then 'ok    ' else 'FAIL  ' end || E'half value rounds down (75 becomes 37)\n';
  select d.id into v_d3 from public.drivers d where d.season = 2027 and d.id not in (v_ds[1], v_ds[2], v_ds[3]) limit 1;
  j := public.calc_season_points(v_d3, 'Some Other Team', false, v_ds[1:3], array[v_t1, v_t2, v_t3]);
  r := r || case when (j ->> 'total')::int = 0 then 'ok    ' else 'FAIL  ' end || E'picks outside the top 3 score nothing\n';
  v_d3 := v_ds[3];

  r := r || case when not has_function_privilege('authenticated', 'public.calc_season_points(text,text,boolean,text[],text[])', 'execute')
                  and not has_function_privilege('authenticated', 'public.recalculate_season_scores(integer)', 'execute')
                  and not has_table_privilege('anon', 'public.season_results', 'select')
                  and not has_table_privilege('anon', 'public.season_scores', 'select')
                 then 'ok    ' else 'FAIL  ' end || E'scoring functions and the new tables are closed to players and anon\n';

  -- ---------- admin input checks ----------
  if v_nonadmin is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', v_nonadmin, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_nonadmin::text, true);
    set local role authenticated;
    begin
      perform public.admin_save_season_result(2027, array[v_d1, v_d2, v_d3], array[v_t1, v_t2, v_t3]);
      ok := false; msg := 'no error';
    exception when others then ok := sqlstate = '42501'; msg := sqlstate; end;
    r := r || case when ok then 'ok    ' else 'FAIL  ' end || 'a non-admin cannot save a season result (' || msg || E')\n';
    begin
      perform public.admin_season_overview();
      ok := false; msg := 'no error';
    exception when others then ok := sqlstate = '42501'; msg := sqlstate; end;
    r := r || case when ok then 'ok    ' else 'FAIL  ' end || 'a non-admin cannot read the season overview (' || msg || E')\n';
    reset role;
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;

  begin
    perform public.admin_save_season_result(2027, array[v_d1, v_d1, v_d3], array[v_t1, v_t2, v_t3]);
    ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '22023'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || 'the same driver twice is refused (' || msg || E')\n';

  begin
    perform public.admin_save_season_result(2027, array[v_d1, v_d2, v_d3], array[v_t1, v_t1, v_t3]);
    ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '22023'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || 'the same team twice is refused (' || msg || E')\n';

  begin
    perform public.admin_save_season_result(2027, array['2026-nor', v_d2, v_d3], array[v_t1, v_t2, v_t3]);
    ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '22023'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || 'a driver from another season is refused (' || msg || E')\n';

  begin
    perform public.admin_save_season_result(2027, array[v_d1, v_d2, v_d3], array[v_t1, v_t2, 'No Such Team']);
    ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '22023'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || 'an unknown team is refused (' || msg || E')\n';

  begin
    perform public.admin_save_season_result(2027, array[v_d1, v_d2], array[v_t1, v_t2, v_t3]);
    ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '22023'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || 'fewer than three drivers is refused (' || msg || E')\n';

  begin
    perform public.admin_save_season_result(1999, array[v_d1, v_d2, v_d3], array[v_t1, v_t2, v_t3]);
    ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '22023'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || 'an unknown season is refused (' || msg || E')\n';

  -- ---------- versions ----------
  v_id1 := public.admin_save_season_result(2027, array[v_d1, v_d2, v_d3], array[v_t1, v_t2, v_t3]);
  v_id2 := public.admin_save_season_result(2027, array[v_d1, v_d2, v_d3], array[v_t1, v_t2, v_t3]);
  reset role;
  r := r || case when (select status from public.season_results where id = v_id1) = 'superseded'
                  and (select status from public.season_results where id = v_id2) = 'pending'
                  and (select version from public.season_results where id = v_id2) = 2
                 then 'ok    ' else 'FAIL  ' end || E'a new save supersedes the older pending version\n';

  -- picks written directly (the save function is tested in 025)
  insert into public.season_predictions (user_id, season, drivers_pick, constructors_pick, half_value)
  values (v_m1, 2027, v_d1, v_t1, false), (v_m2, 2027, v_d2, v_t1, true);

  -- ---------- approval guard ----------
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  begin
    perform public.admin_approve_season_result(v_id2);
    ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '55000'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || 'cannot approve while picks are open (' || msg || E')\n';

  reset role;
  update public.sessions set start_utc = now() - interval '1 day'
   where event_id in (select id from public.events where season = 2027 and round = 1);
  set local role authenticated;
  begin
    perform public.admin_approve_season_result(v_id2);
    ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '55000'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || 'cannot approve while late entry is still open (' || msg || E')\n';

  reset role;
  update public.sessions set start_utc = now() - interval '1 day'
   where event_id in (select id from public.events where season = 2027 and round = 5);
  set local role authenticated;
  begin
    perform public.admin_approve_season_result(v_id2);
    ok := true; msg := 'approved';
  exception when others then ok := false; msg := sqlstate || ' ' || sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || 'can approve once every window is closed (' || msg || E')\n';
  reset role;

  select points into v_s1 from public.season_scores where user_id = v_m1 and season = 2027;
  select points into v_s2 from public.season_scores where user_id = v_m2 and season = 2027;
  r := r || case when v_s1 = 110 and v_s2 = 30 then 'ok    ' else 'FAIL  ' end || 'scores after approval: full 110, half value 30 (got ' || coalesce(v_s1::text, 'none') || ' and ' || coalesce(v_s2::text, 'none') || E')\n';
  r := r || case when (select count(*) from public.season_results where season = 2027 and status = 'approved') = 1
                 then 'ok    ' else 'FAIL  ' end || E'exactly one approved result per season\n';
  r := r || case when (select breakdown ->> 'half' from public.season_scores where user_id = v_m2 and season = 2027) = 'true'
                 then 'ok    ' else 'FAIL  ' end || E'half-value flag is recorded in the breakdown\n';

  select count(*), coalesce(sum(points), 0) into v_cnt1, v_sum1 from public.scores;
  r := r || case when v_cnt0 = v_cnt1 and v_sum0 = v_sum1 then 'ok    ' else 'FAIL  ' end || E'session scores (and so the leaderboard) are untouched\n';

  -- ---------- visibility ----------
  perform set_config('request.jwt.claims', json_build_object('sub', v_m1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m1::text, true);
  set local role authenticated;
  select count(*) into n from public.season_scores where user_id = v_m2;
  r := r || case when n = 1 then 'ok    ' else 'FAIL  ' end || E'group-mates can see season scores\n';
  select count(*) into n from public.season_results;
  r := r || case when n = 1 then 'ok    ' else 'FAIL  ' end || E'players see only the approved season result\n';
  reset role;

  -- ---------- overview ----------
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  v_over := public.admin_season_overview();
  select x into v_row from jsonb_array_elements(v_over) x where (x ->> 'season')::int = 2027;
  r := r || case when v_row is not null
                  and (v_row ->> 'picks_count')::int = 2
                  and (v_row ->> 'closed')::boolean
                  and (v_row -> 'approved' ->> 'version')::int = 2
                  and (v_row -> 'pending') = 'null'::jsonb
                 then 'ok    ' else 'FAIL  ' end || E'overview shows 2027: 2 picks, closed, approved version 2, nothing pending\n';

  -- ---------- editing an approved result ----------
  v_id3 := public.admin_save_season_result(2027, array[v_d2, v_d1, v_d3], array[v_t2, v_t1, v_t3]);
  select x into v_row from jsonb_array_elements(public.admin_season_overview()) x where (x ->> 'season')::int = 2027;
  r := r || case when (v_row -> 'approved' ->> 'version')::int = 2
                  and (v_row -> 'pending' ->> 'version')::int = 3
                  and exists (select 1 from jsonb_array_elements(v_row -> 'pending' -> 'preview') p
                              where p ->> 'points' = '35')
                  and exists (select 1 from jsonb_array_elements(v_row -> 'pending' -> 'preview') p
                              where p ->> 'points' = '37')
                 then 'ok    ' else 'FAIL  ' end || E'an edit stays pending, the old result stays approved, and the preview shows 35 and 37\n';
  reset role;
  select points into v_s1 from public.season_scores where user_id = v_m1 and season = 2027;
  r := r || case when v_s1 = 110 then 'ok    ' else 'FAIL  ' end || E'scores do not change until the edit is approved\n';

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  perform public.admin_approve_season_result(v_id3);
  reset role;
  select points into v_s1 from public.season_scores where user_id = v_m1 and season = 2027;
  select points into v_s2 from public.season_scores where user_id = v_m2 and season = 2027;
  r := r || case when v_s1 = 35 and v_s2 = 37 then 'ok    ' else 'FAIL  ' end || 'approving the edit rescores: 35 and 37 (got ' || coalesce(v_s1::text, 'none') || ' and ' || coalesce(v_s2::text, 'none') || E')\n';
  r := r || case when (select status from public.season_results where id = v_id2) = 'superseded'
                  and (select count(*) from public.season_results where season = 2027 and status = 'approved') = 1
                  and (select count(*) from public.season_scores where season = 2027) = 2
                 then 'ok    ' else 'FAIL  ' end || E'old version superseded, one approved, one score row per pick\n';

  -- ---------- admin override after approval ----------
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  perform public.admin_set_season_prediction(v_m1, 2027, v_d2, v_t2, 'Test correction');
  reset role;
  select points into v_s1 from public.season_scores where user_id = v_m1 and season = 2027;
  r := r || case when v_s1 = 110 then 'ok    ' else 'FAIL  ' end || 'an admin pick override rescores straight away: new pick is both champions, 110 (got ' || coalesce(v_s1::text, 'none') || E')\n';

  -- ---------- rejecting ----------
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  v_id4 := public.admin_save_season_result(2027, array[v_d3, v_d2, v_d1], array[v_t3, v_t2, v_t1]);
  perform public.admin_reject_season_result(v_id4);
  begin
    perform public.admin_approve_season_result(v_id4);
    ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '22023'; msg := sqlstate; end;
  reset role;
  r := r || case when ok and (select status from public.season_results where id = v_id4) = 'rejected'
                  and (select count(*) from public.season_results where season = 2027 and status = 'approved') = 1
                 then 'ok    ' else 'FAIL  ' end || 'a rejected result cannot be approved and the approved one stays (' || msg || E')\n';

  select count(*), coalesce(sum(points), 0) into v_cnt1, v_sum1 from public.scores;
  r := r || case when v_cnt0 = v_cnt1 and v_sum0 = v_sum1 then 'ok    ' else 'FAIL  ' end || E'session scores still untouched at the end\n';

  raise exception E'B2.3a TEST REPORT (this error is expected; everything was rolled back)\nRESULT: %\n%',
    case when r like '%FAIL%' then 'FAILURES' else 'ALL OK' end, r;
end;
$$;