-- Behaviour test for migration 037 (admin corrections of locked predictions). Run it in the Supabase SQL Editor.
-- It builds a temporary 2027 setup (a Sprint that is already locked, two saved predictions and an approved result), tries the
-- rules, and ends with an ERROR ON PURPOSE that rolls back EVERYTHING it did. The error message is the report.
--
-- Needs: one admin and two other group members, and the 2026 drivers (the active ones are copied into 2027 for the test).

do $$
declare
  r        text := '';
  ok       boolean;
  msg      text;
  n        integer;
  v_admin  uuid;
  v_m1     uuid;
  v_m2     uuid;
  v_ev     text := 'bahrain-2027';
  v_sp     text := 'bahrain-2027-sprint';
  v_open   text := 'saudi-arabia-2027-qualifying';
  v_ids    text[];
  v_picks1 jsonb;
  v_picks2 jsonb;
  v_pred2  record;
  v_cur    record;
  v_res_id uuid;
  v_res    jsonb;
  v_c1     uuid;
  v_c2     uuid;
  v_pts1   integer;
  v_pts2   integer;
  v_season bigint;
  v_season2 bigint;
  v_other  numeric;
  v_other2 numeric;
begin
  -- ---------- setup (all rolled back at the end) ----------
  select user_id into v_admin from public.group_members where role = 'admin' order by joined_at limit 1;
  select user_id into v_m1 from public.group_members where user_id <> v_admin order by joined_at limit 1;
  select user_id into v_m2 from public.group_members where user_id <> v_admin and user_id <> v_m1 order by joined_at limit 1;
  if v_admin is null or v_m1 is null or v_m2 is null then
    raise exception 'The test needs one admin and two other group members';
  end if;

  insert into public.drivers (id, season, code, full_name, team_name, car_number, external_id, is_active)
  select replace(d.id, '2026-', '2027-'), 2027, d.code, d.full_name, d.team_name, d.car_number, null, true
  from public.drivers d where d.season = 2026 and d.is_active
  on conflict do nothing;
  v_ids := array(select d.id from public.drivers d where d.season = 2027 and d.is_active order by d.code);
  if cardinality(v_ids) < 10 then raise exception 'The test needs at least 10 active 2026 drivers to copy into 2027 (found %)', cardinality(v_ids); end if;

  -- the Sprint is locked (its deadline is the Sprint Qualifying start); another session stays open
  update public.sessions set start_utc = now() - interval '3 hours' where id = 'bahrain-2027-sprint_qualifying';
  update public.sessions set start_utc = now() - interval '2 hours' where id = v_sp;
  update public.sessions set start_utc = now() + interval '30 days' where id = v_open;

  v_picks1 := jsonb_build_object('top8', to_jsonb(v_ids[1:8]));    -- the exact result
  v_picks2 := jsonb_build_object('top8', to_jsonb(v_ids[3:10]));   -- six right drivers, all in the wrong place

  insert into public.predictions (user_id, session_id, picks, created_at, updated_at)
  values (v_m1, v_sp, v_picks1, now() - interval '5 hours', now() - interval '5 hours'),
         (v_m2, v_sp, v_picks2, now() - interval '4 hours', now() - interval '4 hours' + interval '10 minutes');

  v_res_id := public.enter_result(v_sp, jsonb_build_object('top8', to_jsonb(v_ids[1:8])));
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  perform public.admin_approve_result(v_res_id);
  reset role;

  select sc.points into v_pts1 from public.scores sc where sc.user_id = v_m1 and sc.session_id = v_sp;
  select sc.points into v_pts2 from public.scores sc where sc.user_id = v_m2 and sc.session_id = v_sp;
  r := r || case when v_pts1 = 32 and v_pts2 = 6 then 'ok    ' else 'FAIL  ' end
         || 'setup: the approved result scored player 1 as 32 and player 2 as 6 (' || coalesce(v_pts1::text, '-') || ' and ' || coalesce(v_pts2::text, '-') || E')\n';

  select * into v_pred2 from public.predictions where user_id = v_m2 and session_id = v_sp;
  select coalesce(sum(points), 0) into v_other from public.scores where not (user_id = v_m2 and session_id = v_sp);
  select count(*) into v_season from public.season_scores;

  -- ---------- who may use it ----------
  perform set_config('request.jwt.claims', json_build_object('sub', v_m1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m1::text, true);
  set local role authenticated;
  begin perform public.admin_preview_corrections(v_sp); ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '42501'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '037 a player cannot open the correction preview (' || msg || E')\n';
  begin
    perform public.admin_correct_predictions(v_sp, jsonb_build_array(jsonb_build_object('user_id', v_m2, 'picks', v_picks1)), 'because');
    ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '42501'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '037 a player cannot correct a prediction (' || msg || E')\n';
  begin perform public.rescore_prediction(v_m2, v_sp); ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '42501'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '037 players cannot call rescore_prediction (' || msg || E')\n';
  reset role;

  -- ---------- preview ----------
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  v_res := public.admin_preview_corrections(v_sp);
  r := r || case when (v_res ->> 'eligible')::boolean and (v_res ->> 'has_approved_result')::boolean
                      and jsonb_array_length(v_res -> 'players') = 2 then 'ok    ' else 'FAIL  ' end
         || E'037 the preview lists the 2 saved predictions with the session eligible and its result approved\n';
  v_res := public.admin_preview_corrections(v_open);
  r := r || case when not (v_res ->> 'eligible')::boolean then 'ok    ' else 'FAIL  ' end || E'037 a session that is still open is not eligible\n';

  -- ---------- refusals (each must change nothing) ----------
  begin perform public.admin_correct_predictions(v_open, jsonb_build_array(jsonb_build_object('user_id', v_m2, 'picks', v_picks1)), 'because'); ok := false; msg := 'no error';
  exception when others then ok := sqlerrm like '%still open%'; msg := sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '037 an open session cannot be corrected (' || msg || E')\n';

  begin perform public.admin_correct_predictions(v_sp, jsonb_build_array(jsonb_build_object('user_id', v_m2, 'picks', v_picks1)), ' '); ok := false; msg := 'no error';
  exception when others then ok := sqlerrm like '%reason is required%'; msg := sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '037 a reason is required (' || msg || E')\n';

  begin perform public.admin_correct_predictions('no-such-session', jsonb_build_array(jsonb_build_object('user_id', v_m2, 'picks', v_picks1)), 'because'); ok := false; msg := 'no error';
  exception when others then ok := sqlerrm like '%Unknown session%'; msg := sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '037 an unknown session is refused (' || msg || E')\n';

  begin perform public.admin_correct_predictions(v_sp, '[]'::jsonb, 'because'); ok := false; msg := 'no error';
  exception when others then ok := sqlerrm like '%at least one player%'; msg := sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '037 at least one player must be selected (' || msg || E')\n';

  begin perform public.admin_correct_predictions(v_sp, jsonb_build_array(jsonb_build_object('user_id', v_admin, 'picks', v_picks1)), 'because'); ok := false; msg := 'no error';
  exception when others then ok := sqlerrm like '%no saved prediction%'; msg := sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '037 a member without a saved prediction (the admin) is refused (' || msg || E')\n';

  begin perform public.admin_correct_predictions(v_sp, jsonb_build_array(jsonb_build_object('user_id', v_m2, 'picks', v_picks2)), 'because'); ok := false; msg := 'no error';
  exception when others then ok := sqlerrm like '%same as the saved%'; msg := sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '037 picks identical to the saved ones are refused (' || msg || E')\n';

  begin
    perform public.admin_correct_predictions(v_sp, jsonb_build_array(
      jsonb_build_object('user_id', v_m2, 'picks', v_picks1), jsonb_build_object('user_id', v_m2, 'picks', v_picks1)), 'because');
    ok := false; msg := 'no error';
  exception when others then ok := sqlerrm like '%only once per operation%'; msg := sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '037 a player twice in one operation is refused (' || msg || E')\n';

  begin
    perform public.admin_correct_predictions(v_sp, jsonb_build_array(
      jsonb_build_object('user_id', v_m2, 'picks', v_picks1),
      jsonb_build_object('user_id', v_m1, 'picks', jsonb_build_object('top8', to_jsonb(array[v_ids[1], v_ids[1]] || v_ids[3:8])))), 'because');
    ok := false; msg := 'no error';
  exception when others then ok := sqlerrm like 'Cannot correct%'; msg := sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '037 invalid picks for one player refuse the whole operation (' || msg || E')\n';

  begin
    perform public.admin_correct_predictions(v_sp, jsonb_build_array(jsonb_build_object('user_id', v_m2, 'picks', v_picks1)), 'because',
      '00000000-0000-0000-0000-000000000001'::uuid, null);
    ok := false; msg := 'no error';
  exception when others then ok := sqlerrm like '%linked substitution%'; msg := sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '037 a link to a substitution that does not exist is refused (' || msg || E')\n';
  reset role;

  select count(*) into n from public.prediction_corrections where session_id = v_sp;
  r := r || case when n = 0 then 'ok    ' else 'FAIL  ' end || '037 refused attempts wrote nothing (' || n || E' log rows)\n';
  select * into v_cur from public.predictions where user_id = v_m2 and session_id = v_sp;
  r := r || case when v_cur.picks = v_picks2 then 'ok    ' else 'FAIL  ' end || E'037 and left the saved picks as they were\n';

  -- ---------- a correction ----------
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  v_res := public.admin_correct_predictions(v_sp, jsonb_build_array(jsonb_build_object('user_id', v_m2, 'picks', v_picks1)), 'Replacement driver was not selectable');
  reset role;
  v_c1 := (v_res -> 'players' -> 0 ->> 'correction_id')::uuid;

  select * into v_cur from public.predictions where user_id = v_m2 and session_id = v_sp;
  select sc.points into v_pts2 from public.scores sc where sc.user_id = v_m2 and sc.session_id = v_sp;
  select coalesce(sum(points), 0) into v_other2 from public.scores where not (user_id = v_m2 and session_id = v_sp);
  select count(*) into v_season2 from public.season_scores;

  r := r || case when (v_res ->> 'corrected')::integer = 1 and v_cur.picks = v_picks1 then 'ok    ' else 'FAIL  ' end || E'037 the picks are corrected\n';
  r := r || case when v_cur.created_at = v_pred2.created_at and v_cur.updated_at = v_pred2.updated_at then 'ok    ' else 'FAIL  ' end
         || E'037 the player''s created_at and updated_at are untouched\n';
  r := r || case when v_pts2 = 32 and (v_res -> 'players' -> 0 ->> 'points_before')::integer = 6
                      and (v_res -> 'players' -> 0 ->> 'points_after')::integer = 32 then 'ok    ' else 'FAIL  ' end
         || '037 the score is recalculated from 6 to 32 (now ' || coalesce(v_pts2::text, '-') || E')\n';
  r := r || case when v_other = v_other2 and v_season = v_season2 then 'ok    ' else 'FAIL  ' end
         || E'037 no other score and no season score changed\n';
  select count(*) into n from public.prediction_corrections c
   where c.id = v_c1 and c.action = 'correct' and c.before_picks = v_picks2 and c.after_picks = v_picks1
     and c.original_created_at = v_pred2.created_at and c.original_updated_at = v_pred2.updated_at
     and c.reason = 'Replacement driver was not selectable' and c.admin_id = v_admin;
  r := r || case when n = 1 then 'ok    ' else 'FAIL  ' end || E'037 the log keeps the picks before and after, the original times, the reason and the admin\n';
  select count(*) into n from public.player_notifications where user_id = v_m2 and kind = 'prediction_corrected' and source_id = v_c1;
  r := r || case when n = 1 then 'ok    ' else 'FAIL  ' end || '037 the player gets one notice (' || n || E')\n';
  select count(*) into n from public.player_notifications where user_id = v_m1 and kind = 'prediction_corrected' and source_id = v_c1;
  r := r || case when n = 0 then 'ok    ' else 'FAIL  ' end || '037 other players get none (' || n || E')\n';

  -- who can read the log
  perform set_config('request.jwt.claims', json_build_object('sub', v_m2, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m2::text, true);
  set local role authenticated;
  select count(*) into n from public.prediction_corrections where session_id = v_sp;
  r := r || case when n = 1 then 'ok    ' else 'FAIL  ' end || '037 the corrected player can read his own log row (' || n || E')\n';
  perform set_config('request.jwt.claims', json_build_object('sub', v_m1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m1::text, true);
  select count(*) into n from public.prediction_corrections where session_id = v_sp;
  r := r || case when n = 0 then 'ok    ' else 'FAIL  ' end || '037 another player (not corrected) cannot read it (' || n || E')\n';
  reset role;

  begin update public.prediction_corrections set reason = 'changed' where id = v_c1; ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '55000'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '037 the log cannot be edited (' || msg || E')\n';
  begin delete from public.prediction_corrections where id = v_c1; ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '55000'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '037 the log cannot be deleted (' || msg || E')\n';

  -- ---------- a second correction, then reverts (last in, first out) ----------
  -- One transaction means one timestamp for every row, so "which correction came later" would be a random choice. In real use
  -- each correction is its own transaction. Make the first one older (the log is append-only, so its guard is lifted for this
  -- one statement; this is rolled back with everything else).
  alter table public.prediction_corrections disable trigger user;
  update public.prediction_corrections set created_at = created_at - interval '1 minute' where id = v_c1;
  alter table public.prediction_corrections enable trigger user;

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  v_res := public.admin_correct_predictions(v_sp, jsonb_build_array(
             jsonb_build_object('user_id', v_m2, 'picks', jsonb_build_object('top8', to_jsonb(v_ids[2:9])))), 'Second fix');
  v_c2 := (v_res -> 'players' -> 0 ->> 'correction_id')::uuid;

  begin perform public.admin_revert_correction(v_c1, 'undo'); ok := false; msg := 'no error';
  exception when others then ok := sqlerrm like '%revert that one first%'; msg := sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '037 the earlier correction cannot be reverted while a later one is in force (' || msg || E')\n';
  begin perform public.admin_revert_correction(v_c2, ' '); ok := false; msg := 'no error';
  exception when others then ok := sqlerrm like '%reason is required%'; msg := sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '037 a revert needs a reason (' || msg || E')\n';
  begin perform public.admin_revert_correction('00000000-0000-0000-0000-000000000002'::uuid, 'undo'); ok := false; msg := 'no error';
  exception when others then ok := sqlerrm like '%Unknown correction%'; msg := sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '037 an unknown correction is refused (' || msg || E')\n';

  perform public.admin_revert_correction(v_c2, 'undo the second');
  reset role;
  select * into v_cur from public.predictions where user_id = v_m2 and session_id = v_sp;
  r := r || case when v_cur.picks = v_picks1 then 'ok    ' else 'FAIL  ' end || E'037 reverting the second correction restores the picks from before it\n';

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  begin perform public.admin_revert_correction(v_c2, 'again'); ok := false; msg := 'no error';
  exception when others then ok := sqlerrm like '%already been reverted%'; msg := sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '037 a correction cannot be reverted twice (' || msg || E')\n';
  perform public.admin_revert_correction(v_c1, 'undo the first');
  reset role;

  select * into v_cur from public.predictions where user_id = v_m2 and session_id = v_sp;
  select sc.points into v_pts2 from public.scores sc where sc.user_id = v_m2 and sc.session_id = v_sp;
  r := r || case when v_cur.picks = v_picks2 then 'ok    ' else 'FAIL  ' end || E'037 reverting the first correction restores the player''s original picks\n';
  r := r || case when v_pts2 = 6 then 'ok    ' else 'FAIL  ' end || '037 the score is back to the original 6 (' || coalesce(v_pts2::text, '-') || E')\n';
  r := r || case when v_cur.created_at = v_pred2.created_at and v_cur.updated_at = v_pred2.updated_at then 'ok    ' else 'FAIL  ' end
         || E'037 created_at and updated_at are still the player''s own\n';
  select count(*) into n from public.prediction_corrections where session_id = v_sp;
  r := r || case when n = 4 then 'ok    ' else 'FAIL  ' end || '037 the log keeps every step: 2 corrections and 2 reverts (' || n || E' rows)\n';

  raise exception E'M6 PREDICTION CORRECTIONS DATABASE TEST REPORT (this error is expected; everything was rolled back)\nRESULT: %\n%',
    case when r like '%FAIL%' then 'FAILURES' else 'ALL OK' end, r;
end;
$$;
