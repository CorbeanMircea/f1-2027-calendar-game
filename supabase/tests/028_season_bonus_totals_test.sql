-- Behaviour test for migration 028. Run it in the Supabase SQL Editor.
-- It adds temporary season bonus rows, checks the league totals and XP, and ends with an ERROR ON PURPOSE that
-- rolls everything back; the message is the report (every line starts with "ok" or "FAIL").

do $$
declare
  r        text := '';
  n        integer;
  v_u1     uuid;
  v_u2     uuid;
  v_res26  uuid;
  v_res27  uuid;
  a        record;
  b        record;
  x0       record;
  v_cnt0   bigint;
  v_cols   text;
begin
  -- two players with 2026 session scores (the rehearsal weekends)
  select user_id into v_u1 from public.leaderboard where season = 2026 order by user_id limit 1;
  select user_id into v_u2 from public.leaderboard where season = 2026 and user_id <> v_u1 order by user_id limit 1;
  if v_u1 is null or v_u2 is null then
    raise exception 'The test needs two players with 2026 session scores';
  end if;

  -- Clear any 2026/2027 season data inside this test (rolled back at the end), so existing rows cannot interfere.
  delete from public.season_scores where season in (2026, 2027);
  delete from public.season_prediction_log where season in (2026, 2027);
  delete from public.season_predictions where season in (2026, 2027);
  delete from public.season_results where season in (2026, 2027);

  select count(*) into v_cnt0 from public.leaderboard;
  select * into a from public.leaderboard where season = 2026 and user_id = v_u1;
  select * into b from public.leaderboard where season = 2026 and user_id = v_u2;
  select * into x0 from public.player_xp where user_id = v_u1;

  -- before any season result: nothing changes
  r := r || case when a.total_points = a.session_points and a.bonus_points = 0
                  and b.total_points = b.session_points and b.bonus_points = 0
                 then 'ok    ' else 'FAIL  ' end || E'before any season result: total = session points, bonus 0\n';
  r := r || case when x0.xp = x0.session_xp and x0.bonus_xp = 0 then 'ok    ' else 'FAIL  ' end || E'before any season result: xp = session xp, bonus xp 0\n';

  -- column order: the old columns keep their place, new ones are at the end
  select string_agg(column_name, ',' order by ordinal_position) into v_cols
    from information_schema.columns where table_schema = 'public' and table_name = 'leaderboard';
  r := r || case when v_cols = 'season,user_id,display_name,total_points,sessions_scored,session_points,bonus_points'
                 then 'ok    ' else 'FAIL  ' end || 'leaderboard columns keep their order (' || v_cols || E')\n';
  select string_agg(column_name, ',' order by ordinal_position) into v_cols
    from information_schema.columns where table_schema = 'public' and table_name = 'player_xp';
  r := r || case when v_cols = 'user_id,display_name,avatar,xp,sessions_scored,best_session,session_xp,bonus_xp'
                 then 'ok    ' else 'FAIL  ' end || 'player_xp columns keep their order (' || v_cols || E')\n';

  -- temporary approved season results and season scores (written directly)
  insert into public.season_results (season, version, status, drivers_top3, constructors_top3, approved_at)
    values (2026, 1, 'approved', array['a', 'b', 'c'], array['x', 'y', 'z'], now()) returning id into v_res26;
  insert into public.season_results (season, version, status, drivers_top3, constructors_top3, approved_at)
    values (2027, 1, 'approved', array['a', 'b', 'c'], array['x', 'y', 'z'], now()) returning id into v_res27;
  insert into public.season_scores (user_id, season, result_id, points, breakdown)
    values (v_u1, 2026, v_res26, 55, '{}'::jsonb), (v_u1, 2027, v_res27, 10, '{}'::jsonb);

  select * into a from public.leaderboard where season = 2026 and user_id = v_u1;
  select * into b from public.leaderboard where season = 2026 and user_id = v_u2;
  r := r || case when a.bonus_points = 55 and a.total_points = a.session_points + 55 then 'ok    ' else 'FAIL  ' end || E'leaderboard: bonus is added to the total of that season\n';
  r := r || case when b.bonus_points = 0 and b.total_points = b.session_points then 'ok    ' else 'FAIL  ' end || E'leaderboard: a player without a bonus is unchanged\n';
  r := r || case when a.sessions_scored = (select count(*) from public.scores where user_id = v_u1) then 'ok    ' else 'FAIL  ' end || E'sessions_scored still counts scored sessions only\n';
  select count(*) into n from public.leaderboard;
  r := r || case when n = v_cnt0 then 'ok    ' else 'FAIL  ' end || E'the number of leaderboard rows did not change\n';
  r := r || case when not exists (select 1 from public.leaderboard where season = 2027 and user_id = v_u1)
                 then 'ok    ' else 'FAIL  ' end || E'a bonus alone does not create a leaderboard row (a scored session is needed)\n';

  select * into x0 from public.player_xp where user_id = v_u1;
  r := r || case when x0.bonus_xp = 65 and x0.xp = x0.session_xp + 65 then 'ok    ' else 'FAIL  ' end || E'player_xp: bonus from all seasons (55 + 10) is added to xp\n';
  r := r || case when x0.session_xp = (select coalesce(sum(points), 0) from public.scores where user_id = v_u1)
                  and x0.sessions_scored = (select count(*) from public.scores where user_id = v_u1)
                  and x0.best_session = (select coalesce(max(points), 0) from public.scores where user_id = v_u1)
                 then 'ok    ' else 'FAIL  ' end || E'session_xp, sessions_scored and best_session are session-only\n';

  -- session statistics must NOT include the bonus
  if to_regclass('public.player_season_stats') is not null then
    r := r || case when (select total_points from public.player_season_stats where season = 2026 and user_id = v_u1)
                       = (select session_points from public.leaderboard where season = 2026 and user_id = v_u1)
                   then 'ok    ' else 'FAIL  ' end || E'player_season_stats stays session-only (no bonus)\n';
  end if;

  -- visibility for a group-mate
  perform set_config('request.jwt.claims', json_build_object('sub', v_u2, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_u2::text, true);
  set local role authenticated;
  select count(*) into n from public.leaderboard where season = 2026 and user_id = v_u1 and bonus_points = 55;
  r := r || case when n = 1 then 'ok    ' else 'FAIL  ' end || E'a group-mate sees the bonus in the leaderboard\n';
  select count(*) into n from public.player_xp where user_id = v_u1 and bonus_xp = 65;
  r := r || case when n = 1 then 'ok    ' else 'FAIL  ' end || E'a group-mate sees the bonus xp\n';
  reset role;

  r := r || case when not has_table_privilege('anon', 'public.leaderboard', 'select')
                  and not has_table_privilege('anon', 'public.player_xp', 'select')
                  and has_table_privilege('authenticated', 'public.leaderboard', 'select')
                  and has_table_privilege('authenticated', 'public.player_xp', 'select')
                 then 'ok    ' else 'FAIL  ' end || E'only signed-in players can read the two views\n';

  raise exception E'B2.4a TEST REPORT (this error is expected; everything was rolled back)\nRESULT: %\n%',
    case when r like '%FAIL%' then 'FAILURES' else 'ALL OK' end, r;
end;
$$;