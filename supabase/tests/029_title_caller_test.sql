-- Behaviour test for migration 029. Run it in the Supabase SQL Editor.
-- It adds temporary season results, picks and season scores, checks the Title Caller achievement, and ends with an
-- ERROR ON PURPOSE that rolls everything back; the message is the report (every line starts with "ok" or "FAIL").

do $$
declare
  r        text := '';
  n        integer;
  v_u1 uuid; v_u2 uuid; v_u3 uuid;
  v_ds     text[];
  v_d1 text; v_d2 text; v_d3 text;
  v_t1 text; v_t2 text; v_t3 text;
  v_e1 text; v_e2 text; v_e3 text;     -- the same drivers in 2027
  v_res    uuid;
  a        record;
  v_players integer;
begin
  select user_id into v_u1 from (select distinct user_id from public.player_session_stats) x order by user_id limit 1;
  select user_id into v_u2 from (select distinct user_id from public.player_session_stats) x where user_id <> v_u1 order by user_id limit 1;
  select user_id into v_u3 from (select distinct user_id from public.player_session_stats) x where user_id not in (v_u1, v_u2) order by user_id limit 1;
  if v_u1 is null or v_u2 is null or v_u3 is null then
    raise exception 'The test needs three players with scored sessions';
  end if;

  insert into public.drivers (id, season, code, full_name, team_name, car_number, external_id, is_active)
  select replace(d.id, '2026-', '2027-'), 2027, d.code, d.full_name, d.team_name, d.car_number, null, true
  from public.drivers d where d.season = 2026
  on conflict do nothing;

  select array_agg(x.id order by x.team_name) into v_ds
  from (select distinct on (d.team_name) d.id, d.team_name from public.drivers d
        where d.season = 2026 order by d.team_name, d.id limit 3) x;
  if v_ds is null or cardinality(v_ds) < 3 then
    raise exception 'The test needs 2026 drivers from at least three teams';
  end if;
  v_d1 := v_ds[1]; v_d2 := v_ds[2]; v_d3 := v_ds[3];
  select team_name into v_t1 from public.drivers where id = v_d1;
  select team_name into v_t2 from public.drivers where id = v_d2;
  select team_name into v_t3 from public.drivers where id = v_d3;
  v_e1 := replace(v_d1, '2026-', '2027-'); v_e2 := replace(v_d2, '2026-', '2027-'); v_e3 := replace(v_d3, '2026-', '2027-');

  select count(distinct user_id) into v_players from public.player_session_stats;

  -- before anything: everyone has a title_caller row with 0 calls
  select * into a from public.player_achievements_all where user_id = v_u1 and achievement = 'title_caller';
  r := r || case when a.progress = 0 and a.level = 0 and a.step = 0 and a.next_target = 1 and a.max_level = 3 and a.earned_round is null
                 then 'ok    ' else 'FAIL  ' end || E'before any season result: 0 calls, level 0, next target 1\n';

  -- 2026 and 2027 approved results: champion = first driver and first team
  insert into public.season_results (season, version, status, drivers_top3, constructors_top3, approved_at)
    values (2026, 1, 'approved', array[v_d1, v_d2, v_d3], array[v_t1, v_t2, v_t3], now());
  insert into public.season_results (season, version, status, drivers_top3, constructors_top3, approved_at)
    values (2027, 1, 'approved', array[v_e1, v_e2, v_e3], array[v_t1, v_t2, v_t3], now());

  -- picks: u1 calls both champions in both seasons (4 calls); u2 calls only the driver in 2026, as a half-value pick (1 call);
  -- u2 calls nothing in 2027; u3 has no picks
  insert into public.season_predictions (user_id, season, drivers_pick, constructors_pick, half_value) values
    (v_u1, 2026, v_d1, v_t1, false), (v_u1, 2027, v_e1, v_t1, false),
    (v_u2, 2026, v_d1, v_t2, true),  (v_u2, 2027, v_e2, v_t2, false);
  perform public.recalculate_season_scores(2026);
  perform public.recalculate_season_scores(2027);

  select * into a from public.player_achievements_all where user_id = v_u1 and achievement = 'title_caller';
  r := r || case when a.progress = 4 and a.level = 3 and a.step = 4 and a.next_target is null and a.next_step is null
                 then 'ok    ' else 'FAIL  ' end || 'u1 called 4 champions: level 3, step 4, maxed (progress ' || a.progress || E')\n';
  r := r || case when a.earned_season = 2027 and a.earned_event = 'Season picks'
                  and a.earned_round = (select max(round) from public.events where season = 2027)
                 then 'ok    ' else 'FAIL  ' end || E'level 3 was earned in 2027, at that season''s last round, labelled Season picks\n';

  select * into a from public.player_achievements_all where user_id = v_u2 and achievement = 'title_caller';
  r := r || case when a.progress = 1 and a.level = 1 and a.step = 2 and a.next_target = 2 and a.next_step = 3
                 then 'ok    ' else 'FAIL  ' end || 'u2 called 1 champion (a half-value pick still counts): level 1, step 2 (progress ' || a.progress || E')\n';
  r := r || case when a.earned_season = 2026 and a.earned_round = (select max(round) from public.events where season = 2026)
                 then 'ok    ' else 'FAIL  ' end || E'u2 earned level 1 in 2026\n';

  select * into a from public.player_achievements_all where user_id = v_u3 and achievement = 'title_caller';
  r := r || case when a.progress = 0 and a.level = 0 and a.earned_season is null then 'ok    ' else 'FAIL  ' end || E'a player without picks stays at 0\n';

  -- a pending (not approved) result changes nothing
  insert into public.season_results (season, version, status, drivers_top3, constructors_top3)
    values (2026, 2, 'pending', array[v_d2, v_d1, v_d3], array[v_t2, v_t1, v_t3]);
  select * into a from public.player_achievements_all where user_id = v_u2 and achievement = 'title_caller';
  r := r || case when a.progress = 1 then 'ok    ' else 'FAIL  ' end || E'a pending season result does not change anything\n';

  -- shape: one extra row per player, the 13 existing rows are identical
  select count(*) into n from public.player_achievements_all where achievement = 'title_caller';
  r := r || case when n = v_players then 'ok    ' else 'FAIL  ' end || E'exactly one title_caller row per player\n';
  r := r || case when (select count(*) from public.player_achievements_all) = (select count(*) from public.player_achievements) + v_players
                 then 'ok    ' else 'FAIL  ' end || E'player_achievements_all = the existing rows + one per player\n';
  r := r || case when not exists (
                   (select * from public.player_achievements_all where achievement <> 'title_caller'
                    except select * from public.player_achievements)
                   union all
                   (select * from public.player_achievements
                    except select * from public.player_achievements_all where achievement <> 'title_caller'))
                 then 'ok    ' else 'FAIL  ' end || E'the existing achievements are returned unchanged\n';

  r := r || case when not has_table_privilege('anon', 'public.player_achievements_all', 'select')
                  and has_table_privilege('authenticated', 'public.player_achievements_all', 'select')
                 then 'ok    ' else 'FAIL  ' end || E'only signed-in players can read the view\n';

  raise exception E'B2.5 TEST REPORT (this error is expected; everything was rolled back)\nRESULT: %\n%',
    case when r like '%FAIL%' then 'FAILURES' else 'ALL OK' end, r;
end;
$$;