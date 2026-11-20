-- Behaviour test for migrations 033, 034, 035 and 036 (prediction form lineup, grid penalties, notices read, push delivery).
-- Run it in the Supabase SQL Editor. It builds a temporary 2027 setup, tries the rules, and ends with an ERROR ON PURPOSE that
-- rolls back EVERYTHING it did. The error message is the report: every line starts with "ok" or "FAIL".
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
  v_q      text := 'bahrain-2027-qualifying';
  v_rc     text := 'bahrain-2027-race';
  v_sp     text := 'bahrain-2027-sprint';
  v_ver    text;
  v_code   text;
  v_n      integer;
  v_inact  boolean;
  v_ids    text[];
  v_oth    text[];
  v_race1  jsonb;
  v_form   jsonb;
  v_res    jsonb;
  v_pen    uuid;
  v_pen2   uuid;
  v_sub    uuid;
  v_note   uuid;
  v_first  timestamptz;
  v_unread1 integer;
  v_unread2 integer;
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

  update public.sessions set start_utc = now() + interval '30 days' where event_id = v_ev;

  select exists (select 1 from public.drivers d where d.season = 2027 and not d.is_active) into v_inact;
  v_ids := array(select d.id from public.drivers d where d.season = 2027 and d.is_active order by d.code);
  v_n := cardinality(v_ids);
  if v_n < 17 then
    raise exception 'The test needs at least 17 active 2026 drivers to copy into 2027 (found %)', v_n;
  end if;
  v_ver := v_ids[1];                       -- the driver who gets the penalty
  v_oth := array_remove(v_ids, v_ver);
  select d.code into v_code from public.drivers d where d.id = v_ver;
  v_race1 := jsonb_build_object('top8', to_jsonb(array[v_ver] || v_oth[1:7]), 'fastest_lap', v_ver, 'any_dnf', false, 'dnf_count', 0);

  -- player 1 saves a race prediction and a sprint prediction; player 2 saves nothing
  perform set_config('request.jwt.claims', json_build_object('sub', v_m1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m1::text, true);
  set local role authenticated;
  perform public.submit_prediction(v_rc, v_race1);
  perform public.submit_prediction(v_sp, jsonb_build_object('top8', to_jsonb(array[v_ver] || v_oth[1:7])));

  -- ---------- 033: the prediction form lineup ----------
  v_form := public.prediction_form_lineup(v_rc);
  r := r || case when (v_form ->> 'use')::boolean = v_inact and jsonb_array_length(v_form -> 'lineup') = v_n
                      and v_form -> 'stand_ins' = '{}'::jsonb and v_form -> 'changes' = '[]'::jsonb and v_form -> 'penalties' = '[]'::jsonb
                 then 'ok    ' else 'FAIL  ' end || E'033 with no changes the form gets the full lineup and no changes, stand-ins or penalties\n';

  begin perform public.prediction_form_lineup('no-such-session'); ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '22023'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '033 an unknown session is refused (' || msg || E')\n';

  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  begin perform public.prediction_form_lineup(v_rc); ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '28000'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '033 a signed-out caller is refused (' || msg || E')\n';

  -- ---------- 034: who may register a penalty ----------
  perform set_config('request.jwt.claims', json_build_object('sub', v_m1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m1::text, true);
  begin perform public.admin_register_grid_penalty(v_rc, v_ver, 'places', 3, 1, 4, 'Official: 3 place penalty'); ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '42501'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '034 a player cannot register a penalty (' || msg || E')\n';
  begin perform public.admin_preview_grid_penalty(v_rc); ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '42501'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '034 a player cannot preview a penalty (' || msg || E')\n';
  begin perform public.session_has_grid_penalty(v_rc); ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '42501'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '034 players cannot call session_has_grid_penalty (' || msg || E')\n';

  -- ---------- 034: the admin registers penalties ----------
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);

  v_res := public.admin_preview_grid_penalty(v_rc);
  r := r || case when (v_res ->> 'eligible')::boolean and (v_res ->> 'predictions')::integer = 1 then 'ok    ' else 'FAIL  ' end
         || E'034 the preview says the race is eligible and counts the 1 saved prediction\n';
  v_res := public.admin_preview_grid_penalty(v_q);
  r := r || case when not (v_res ->> 'eligible')::boolean then 'ok    ' else 'FAIL  ' end || E'034 the preview says qualifying is not eligible\n';

  begin perform public.admin_register_grid_penalty(v_q, v_ver, 'places', 3, 1, 4, 'Official: 3 place penalty'); ok := false; msg := 'no error';
  exception when others then ok := sqlerrm like '%Sprint or a Race%'; msg := sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '034 a qualifying penalty is refused (' || msg || E')\n';

  begin perform public.admin_register_grid_penalty(v_rc, v_ver, 'places', null, 1, 4, 'Official: 3 place penalty'); ok := false; msg := 'no error';
  exception when others then ok := sqlerrm like '%number of grid places%'; msg := sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '034 a places penalty needs the number of places (' || msg || E')\n';

  begin perform public.admin_register_grid_penalty(v_rc, v_ver, 'back_of_grid', 3, 1, 22, 'Official: back of the grid'); ok := false; msg := 'no error';
  exception when others then ok := sqlerrm like '%applies only to a places penalty%'; msg := sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '034 places only go with a places penalty (' || msg || E')\n';

  begin perform public.admin_register_grid_penalty(v_rc, v_ver, 'places', 3, 1, 4, ''); ok := false; msg := 'no error';
  exception when others then ok := sqlerrm like '%reason%'; msg := sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '034 a reason is required (' || msg || E')\n';

  begin perform public.admin_register_grid_penalty(v_rc, '2027-nobody', 'places', 3, 1, 4, 'Official: 3 place penalty'); ok := false; msg := 'no error';
  exception when others then ok := sqlerrm like '%not in the lineup%'; msg := sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '034 a driver who is not in the lineup is refused (' || msg || E')\n';

  reset role;
  select count(*) into n from public.grid_penalties where session_id in (v_q, v_rc, v_sp);
  r := r || case when n = 0 then 'ok    ' else 'FAIL  ' end || '034 refused attempts wrote nothing for this weekend (' || n || E' rows)\n';

  -- a session with no start time needs explicit confirmation
  update public.sessions set start_utc = null where id = v_sp;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  begin perform public.admin_register_grid_penalty(v_sp, v_ver, 'places', 3, 1, 4, 'Official: 3 place penalty'); ok := false; msg := 'no error';
  exception when others then ok := sqlerrm like '%confirm it explicitly%'; msg := sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '034 a session with no start time needs explicit confirmation (' || msg || E')\n';
  reset role;
  update public.sessions set start_utc = now() + interval '30 days' where id = v_sp;

  -- the real penalty
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  v_res := public.admin_register_grid_penalty(v_rc, v_ver, 'places', 3, 1, 4, 'Official: 3 place penalty', 'FIA document 12');
  reset role;
  v_pen := (v_res ->> 'penalty_id')::uuid;
  r := r || case when v_pen is not null and (v_res ->> 'notified')::integer = 1 then 'ok    ' else 'FAIL  ' end
         || E'034 the penalty is recorded and exactly one player (the one with a saved race prediction) is notified\n';

  select public.session_has_grid_penalty(v_rc) into ok;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || E'034 session_has_grid_penalty is true for the race\n';
  select public.session_has_grid_penalty(v_sp) into ok;
  r := r || case when not ok then 'ok    ' else 'FAIL  ' end || E'034 and still false for the sprint\n';

  select count(*) into n from public.player_notifications where kind = 'grid_penalty' and user_id = v_m1 and event_id = v_ev;
  r := r || case when n = 1 then 'ok    ' else 'FAIL  ' end || '034 player 1 got a grid_penalty notice (' || n || E')\n';
  select count(*) into n from public.player_notifications where kind = 'grid_penalty' and user_id = v_m2 and event_id = v_ev;
  r := r || case when n = 0 then 'ok    ' else 'FAIL  ' end || '034 player 2 (no prediction) got none (' || n || E')\n';

  -- the form shows the penalty to a player
  perform set_config('request.jwt.claims', json_build_object('sub', v_m2, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m2::text, true);
  set local role authenticated;
  v_form := public.prediction_form_lineup(v_rc);
  reset role;
  r := r || case when jsonb_array_length(v_form -> 'penalties') = 1
                      and v_form -> 'penalties' -> 0 -> 'driver' ->> 'code' = v_code
                      and v_form -> 'penalties' -> 0 ->> 'penalty_type' = 'places'
                 then 'ok    ' else 'FAIL  ' end || E'034 the prediction form lists the penalty in force (the right driver, places)\n';

  -- penalties are information only: nothing about predictions or lineup changed
  select count(*) into n from public.predictions where session_id = v_rc;
  r := r || case when n = 1 then 'ok    ' else 'FAIL  ' end || '034 the penalty does not touch predictions (' || n || E' saved)\n';

  begin update public.grid_penalties set reason = 'changed' where id = v_pen; ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '55000'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '034 the penalty history cannot be edited (' || msg || E')\n';
  begin delete from public.grid_penalties where id = v_pen; ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '55000'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '034 the penalty history cannot be deleted (' || msg || E')\n';

  -- ---------- 034: revoke, and revoke with a corrected penalty ----------
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  begin perform public.admin_revoke_grid_penalty(v_pen, ''); ok := false; msg := 'no error';
  exception when others then ok := sqlerrm like '%reason is required%'; msg := sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '034 a revoke needs a reason (' || msg || E')\n';

  begin
    perform public.admin_revoke_grid_penalty(v_pen, 'Corrected by the stewards',
      jsonb_build_object('penalty_type', 'places', 'places', 5, 'reason', ''));
    ok := false; msg := 'no error';
  exception when others then ok := sqlerrm like '%needs its own reason%'; msg := sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '034 a corrected penalty needs its own reason (' || msg || E')\n';

  v_res := public.admin_revoke_grid_penalty(v_pen, 'Corrected by the stewards',
    jsonb_build_object('penalty_type', 'places', 'places', 5, 'original_position', 1, 'adjusted_position', 6, 'reason', 'Official: 5 place penalty'));
  reset role;
  v_pen2 := (v_res ->> 'penalty_id')::uuid;
  r := r || case when v_pen2 is not null and v_pen2 <> v_pen then 'ok    ' else 'FAIL  ' end || E'034 revoking with a replacement creates a new penalty\n';
  select count(*) into n from public.grid_penalties p
   where p.session_id = v_rc and p.entry_type = 'penalty' and not exists (select 1 from public.grid_penalties x where x.revokes_id = p.id);
  r := r || case when n = 1 then 'ok    ' else 'FAIL  ' end || '034 exactly one penalty is in force after the correction (' || n || E')\n';
  select count(*) into n from public.player_notifications where kind = 'grid_penalty_updated' and user_id = v_m1 and event_id = v_ev;
  r := r || case when n = 1 then 'ok    ' else 'FAIL  ' end || '034 the player is told about the corrected penalty (' || n || E')\n';

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  begin perform public.admin_revoke_grid_penalty(v_pen, 'again'); ok := false; msg := 'no error';
  exception when others then ok := sqlerrm like '%already been revoked%'; msg := sqlerrm; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '034 a penalty cannot be revoked twice (' || msg || E')\n';
  v_res := public.admin_revoke_grid_penalty(v_pen2, 'Withdrawn completely');
  reset role;
  select public.session_has_grid_penalty(v_rc) into ok;
  r := r || case when not ok then 'ok    ' else 'FAIL  ' end || E'034 after revoking without a replacement no penalty is in force\n';
  select count(*) into n from public.player_notifications where kind = 'grid_penalty_revoked' and user_id = v_m1 and event_id = v_ev;
  r := r || case when n = 1 then 'ok    ' else 'FAIL  ' end || '034 the player is told about the revocation (' || n || E')\n';

  -- ---------- 035: mark notifications as read ----------
  select count(*) into n from public.player_notifications where user_id = v_m1 and read_at is null and event_id = v_ev;
  r := r || case when n = 3 then 'ok    ' else 'FAIL  ' end || '035 player 1 starts with 3 unread notices for this weekend (' || n || E')\n';
  select count(*) into v_unread1 from public.player_notifications where user_id = v_m1 and read_at is null;
  select count(*) into v_unread2 from public.player_notifications where user_id = v_m2 and read_at is null;

  perform set_config('request.jwt.claims', json_build_object('sub', v_m2, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m2::text, true);
  set local role authenticated;
  select public.mark_notifications_read(null) into n;
  reset role;
  r := r || case when n = v_unread2 then 'ok    ' else 'FAIL  ' end || '035 player 2 marks only his own notices (' || n || ' of his ' || v_unread2 || E')\n';
  select count(*) into n from public.player_notifications where user_id = v_m1 and read_at is null;
  r := r || case when n = v_unread1 then 'ok    ' else 'FAIL  ' end || '035 player 1''s notices are still unread (' || n || E')\n';

  select id into v_note from public.player_notifications where user_id = v_m1 and event_id = v_ev order by created_at, id limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', v_m1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m1::text, true);
  set local role authenticated;
  select public.mark_notifications_read(array[v_note]) into n;
  r := r || case when n = 1 then 'ok    ' else 'FAIL  ' end || '035 marking one notice read changes exactly one (' || n || E')\n';
  select public.mark_notifications_read(array[v_note]) into n;
  r := r || case when n = 0 then 'ok    ' else 'FAIL  ' end || '035 marking it again changes nothing (' || n || E')\n';
  begin update public.player_notifications set read_at = null where id = v_note; ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '42501'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '035 players cannot edit notifications directly (' || msg || E')\n';
  select public.mark_notifications_read(null) into n;
  r := r || case when n = v_unread1 - 1 then 'ok    ' else 'FAIL  ' end || '035 marking all read changes all the others (' || n || ' of ' || (v_unread1 - 1) || E')\n';
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  begin perform public.mark_notifications_read(null); ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '28000'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '035 a signed-out caller is refused (' || msg || E')\n';
  reset role;

  -- ---------- 036: push delivery ----------
  -- a fresh unread notice for player 1, and a registered device for each player
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  v_res := public.admin_register_grid_penalty(v_rc, v_ver, 'back_of_grid', null, 1, 22, 'Official: back of the grid');
  reset role;
  insert into public.push_subscriptions (endpoint, user_id, p256dh, auth) values
    ('https://push.test/m1-phone', v_m1, 'k1', 'a1'),
    ('https://push.test/m1-laptop', v_m1, 'k2', 'a2'),
    ('https://push.test/m2-phone', v_m2, 'k3', 'a3');

  select count(*) into n from public.due_push_notices(now()) where endpoint like 'https://push.test/%' and notification_id in (select pn.id from public.player_notifications pn where pn.event_id = v_ev);
  r := r || case when n = 2 then 'ok    ' else 'FAIL  ' end
         || '036 the new unread notice is due on both of player 1''s devices and nowhere else (' || n || E' rows)\n';
  select count(*) into n from public.due_push_notices(now()) where user_id = v_m2 and endpoint like 'https://push.test/%' and notification_id in (select pn.id from public.player_notifications pn where pn.event_id = v_ev);
  r := r || case when n = 0 then 'ok    ' else 'FAIL  ' end || '036 player 2 (no notice) gets no push (' || n || E')\n';

  select min(notification_id::text)::uuid into v_note from public.due_push_notices(now()) where endpoint like 'https://push.test/%' and notification_id in (select pn.id from public.player_notifications pn where pn.event_id = v_ev);
  if v_note is not null then
    insert into public.push_notice_log (endpoint, notification_id) values ('https://push.test/m1-phone', v_note);
  end if;
  select count(*) into n from public.due_push_notices(now()) where endpoint like 'https://push.test/%' and notification_id in (select pn.id from public.player_notifications pn where pn.event_id = v_ev);
  r := r || case when n = 1 then 'ok    ' else 'FAIL  ' end || '036 once a device has received a notice it is not due again there (' || n || E' left)\n';

  select count(*) into n from public.due_push_notices(now() + interval '4 hours') where endpoint like 'https://push.test/%' and notification_id in (select pn.id from public.player_notifications pn where pn.event_id = v_ev);
  r := r || case when n = 0 then 'ok    ' else 'FAIL  ' end || '036 notices older than 3 hours are no longer pushed (' || n || E')\n';

  update public.player_notifications set read_at = now() where user_id = v_m1;
  select count(*) into n from public.due_push_notices(now()) where endpoint like 'https://push.test/%' and notification_id in (select pn.id from public.player_notifications pn where pn.event_id = v_ev);
  r := r || case when n = 0 then 'ok    ' else 'FAIL  ' end || '036 read notices are not pushed (' || n || E')\n';

  perform set_config('request.jwt.claims', json_build_object('sub', v_m1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_m1::text, true);
  set local role authenticated;
  begin perform * from public.due_push_notices(now()); ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '42501'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '036 players cannot call due_push_notices (' || msg || E')\n';
  begin perform * from public.push_notice_log; ok := false; msg := 'no error';
  exception when others then ok := sqlstate = '42501'; msg := sqlstate; end;
  r := r || case when ok then 'ok    ' else 'FAIL  ' end || '036 players cannot read the push log (' || msg || E')\n';
  reset role;

  raise exception E'M3 TO M5B DATABASE TEST REPORT (this error is expected; everything was rolled back)\nRESULT: %\n%',
    case when r like '%FAIL%' then 'FAILURES' else 'ALL OK' end, r;
end;
$$;
