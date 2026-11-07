-- Behaviour test for migration 025. Run it in the Supabase SQL Editor.
-- It builds a temporary 2027 setup, tries every rule, and then ends with an ERROR ON PURPOSE.
-- The error rolls back EVERYTHING it did (nothing is kept), and its message is the report:
-- every line starts with "ok" or "FAIL". The first line says "ALL OK" or "FAILURES".

do $$
declare
  r          text := '';
  ok         boolean;
  msg        text;
  n          integer;
  v_admin    uuid;
  v_m1       uuid;
  v_m2       uuid;
  v_nonadmin uuid;
  v_drv      text;
  v_team     text;
  v_team2    text;
  v_half     boolean;
  v_open     boolean;
  v_late     boolean;
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

  select d.id, d.team_name into v_drv, v_team from public.drivers d where d.season = 2027 and d.is_active order by d.id limit 1;
  select d.team_name into v_team2 from public.drivers d where d.season = 2027 and d.is_active and d.team_name <> v_team order by d.team_name limit 1;
  if v_drv is null or v_team2 is null then
    raise exception 'The test needs 2026 drivers from two teams to copy into 2027';
  end if;

  update public.sessions set start_utc = now() + interval '30 days'
   where event_id in (select id from public.events where season = 2027 and round = 1);
  update public.sessions set start_utc = now() + interval '60 days'
   where event_id in (select id from public.events where season = 2027 and round = 5);

  -- ---------- before the lock ----------
  select w.is_open, w.late_open into v_open, v_late from public.season_prediction_windows w where w.season = 2027;
  r := r || case when v_open and not v_late then 'ok    ' else 'FAIL  ' end || E'window is open before Round 1\n';

  perform set_config('request.jwt.claims', json_build_object('sub', v_m1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m1::text, true);
  set local role authenticated;

  begin
    perform public.submit_season_prediction(2027, v_drv, v_team);
    ok := true; msg := 'saved';
  exception when others then ok := false; msg := sqlstate || ' ' || sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || 'player saves valid picks before the lock (' || msg || E')\n';

  begin
    perform public.submit_season_prediction(2027, '2026-nor', v_team);
    ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '22023'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || 'a driver from another season is refused (' || msg || E')\n';

  begin
    perform public.submit_season_prediction(2027, v_drv, 'No Such Team');
    ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '22023'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || 'an unknown team is refused (' || msg || E')\n';

  begin
    perform public.submit_season_prediction(2027, v_drv, v_team2);
    ok := true; msg := 'saved';
  exception when others then ok := false; msg := sqlstate || ' ' || sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || 'player can edit picks before the lock (' || msg || E')\n';

  begin
    insert into public.season_predictions (user_id, season, drivers_pick, constructors_pick) values (v_m1, 2027, v_drv, v_team);
    ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '42501'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || 'direct table writes are blocked (' || msg || E')\n';

  select count(*) into n from public.season_predictions where user_id = v_m1;
  r := r || case when n = 1 then 'ok    ' else 'FAIL  ' end || E'player sees their own picks\n';

  perform set_config('request.jwt.claims', json_build_object('sub', v_m2, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m2::text, true);
  select count(*) into n from public.season_predictions where user_id = v_m1;
  r := r || case when n = 0 then 'ok    ' else 'FAIL  ' end || E'group-mates cannot see picks before the lock\n';

  reset role;
  select sp.constructors_pick = v_team2, sp.half_value into ok, v_half
    from public.season_predictions sp where sp.user_id = v_m1 and sp.season = 2027;
  r := r || case when ok and not v_half then 'ok    ' else 'FAIL  ' end || E'saved row has the edited team and full value\n';
  r := r || case when not has_table_privilege('anon', 'public.season_predictions', 'select')
                  and not has_table_privilege('anon', 'public.season_prediction_log', 'select')
                  and not has_table_privilege('anon', 'public.season_prediction_windows', 'select')
                 then 'ok    ' else 'FAIL  ' end || E'anon cannot read the new tables or the view\n';

  -- ---------- after the main lock, before the late lock ----------
  update public.sessions set start_utc = now() - interval '1 day'
   where event_id in (select id from public.events where season = 2027 and round = 1);
  select w.is_open, w.late_open into v_open, v_late from public.season_prediction_windows w where w.season = 2027;
  r := r || case when not v_open and v_late then 'ok    ' else 'FAIL  ' end || E'after Round 1 starts: closed, late window open\n';

  perform set_config('request.jwt.claims', json_build_object('sub', v_m1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m1::text, true);
  set local role authenticated;
  begin
    perform public.submit_season_prediction(2027, v_drv, v_team);
    ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '55000'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || 'a player who joined before the lock cannot pick after it (' || msg || E')\n';

  perform set_config('request.jwt.claims', json_build_object('sub', v_m2, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m2::text, true);
  select count(*) into n from public.season_predictions where user_id = v_m1;
  r := r || case when n = 1 then 'ok    ' else 'FAIL  ' end || E'group-mates see normal picks after the lock\n';

  reset role;
  update public.group_members set joined_at = now() where user_id = v_m2;   -- m2 "joins late"
  perform set_config('request.jwt.claims', json_build_object('sub', v_m2, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m2::text, true);
  set local role authenticated;
  begin
    perform public.submit_season_prediction(2027, v_drv, v_team);
    ok := true; msg := 'saved';
  exception when others then ok := false; msg := sqlstate || ' ' || sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || 'a late joiner can pick in the late window (' || msg || E')\n';

  reset role;
  select sp.half_value into v_half from public.season_predictions sp where sp.user_id = v_m2 and sp.season = 2027;
  r := r || case when v_half then 'ok    ' else 'FAIL  ' end || E'late pick is stored at half value\n';

  perform set_config('request.jwt.claims', json_build_object('sub', v_m1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m1::text, true);
  set local role authenticated;
  select count(*) into n from public.season_predictions where user_id = v_m2;
  r := r || case when n = 0 then 'ok    ' else 'FAIL  ' end || E'a half-value pick stays hidden until the late window closes\n';

  -- ---------- administrator override ----------
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  begin
    perform public.admin_set_season_prediction(v_m1, 2027, v_drv, v_team, 'Test correction');
    ok := true; msg := 'saved';
  exception when others then ok := false; msg := sqlstate || ' ' || sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || 'admin can set a pick after the lock (' || msg || E')\n';

  begin
    perform public.admin_set_season_prediction(v_m1, 2027, v_drv, v_team, ' ');
    ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '22023'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || 'admin change without a reason is refused (' || msg || E')\n';

  select count(*) into n from public.season_prediction_log where user_id = v_m1 and reason = 'Test correction' and old_pick is not null;
  r := r || case when n = 1 then 'ok    ' else 'FAIL  ' end || E'admin change is logged with the old pick\n';

  begin
    perform public.admin_set_season_prediction(v_m2, 2027, v_drv, v_team2, 'Late joiner fix');
    ok := true; msg := 'saved';
  exception when others then ok := false; msg := sqlstate || ' ' || sqlerrm; end;
  reset role;
  select sp.half_value into v_half from public.season_predictions sp where sp.user_id = v_m2 and sp.season = 2027;
  r := r || case when ok and v_half then 'ok    ' else 'FAIL  ' end || E'admin change keeps the half-value flag\n';

  if v_nonadmin is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', v_nonadmin, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_nonadmin::text, true);
    set local role authenticated;
    begin
      perform public.admin_set_season_prediction(v_m1, 2027, v_drv, v_team, 'Not allowed');
      ok := false; msg := 'no error';
    exception when others then ok := sqlstate = '42501'; msg := sqlstate; end;
    r := r || case when ok then 'ok    ' else 'FAIL  ' end || 'non-admin cannot use the admin function (' || msg || E')\n';
    select count(*) into n from public.season_prediction_log;
    r := r || case when n = 0 then 'ok    ' else 'FAIL  ' end || E'non-admin cannot read the admin log\n';
    reset role;
  end if;

  -- ---------- after the late lock ----------
  update public.sessions set start_utc = now() - interval '1 day'
   where event_id in (select id from public.events where season = 2027 and round = 5);
  select w.is_open, w.late_open into v_open, v_late from public.season_prediction_windows w where w.season = 2027;
  r := r || case when not v_open and not v_late then 'ok    ' else 'FAIL  ' end || E'after Round 5 starts: everything closed\n';

  perform set_config('request.jwt.claims', json_build_object('sub', v_m2, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m2::text, true);
  set local role authenticated;
  begin
    perform public.submit_season_prediction(2027, v_drv, v_team);
    ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '55000'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || 'late joiner cannot pick after the late lock (' || msg || E')\n';

  perform set_config('request.jwt.claims', json_build_object('sub', v_m1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m1::text, true);
  select count(*) into n from public.season_predictions where user_id = v_m2;
  r := r || case when n = 1 then 'ok    ' else 'FAIL  ' end || E'half-value pick is visible after the late lock\n';

  -- ---------- other seasons ----------
  begin
    perform public.submit_season_prediction(1999, v_drv, v_team);
    ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '22023'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || 'an unknown season is refused (' || msg || E')\n';

  begin
    perform public.submit_season_prediction(2026, '2026-nor', v_team);
    ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '55000'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || 'a season without a usable Round 1 time is closed (' || msg || E')\n';
  reset role;

  raise exception E'B2.1 TEST REPORT (this error is expected; everything was rolled back)\nRESULT: %\n%',
    case when r like '%FAIL%' then 'FAILURES' else 'ALL OK' end, r;
end;
$$;