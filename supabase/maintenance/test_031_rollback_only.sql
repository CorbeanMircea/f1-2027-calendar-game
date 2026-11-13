-- OPTIONAL scenario check for 030 + 031. NOTHING IS SAVED: the script always ends with an exception, which rolls back
-- everything it did (the test driver, the substitution, the notifications). The exception message IS the report.
--
-- It needs: a group admin, and an upcoming scheduled event whose session start times are all confirmed and in the future.
-- Run it in the Supabase SQL Editor. Read the report in the error message; "TEST REPORT (nothing was saved)" is expected.
--
-- Expected lines (n = lineup size, normally 22):
--   1 preview ........... sessions = 4 (or 2), eligible = all of them
--   2 register .......... notified = number of players with a saved prediction for this event, new driver id season-zzz
--   3 lineup ............ size n, outgoing present false, new present true
--   4a lineup picks ..... accepted
--   4b withdrawn pick, no stand-in ... REJECTED (Unknown or inactive driver)
--   4c withdrawn pick, saved by player (stand-in) ... accepted
--   4d both withdrawn and replacement ... REJECTED (Your ranking must include every driver)
--   4e result: lineup accepted, withdrawn driver REJECTED
--   5 notifications ..... created = players with predictions (no duplicates)
--   6 revert ............ reverted sessions = all, outgoing back in the lineup, new driver mapped back to the outgoing one
--   7 second revert ..... REJECTED (Nothing to revert)

do $$
declare
  v_admin    uuid;
  v_event    text;
  v_season   integer;
  v_out      text;
  v_new      text;
  v_sub      uuid;
  v_sessions text[];
  v_q        text;
  v_res      jsonb;
  v_state    record;
  v_arr      text[];
  v_n        integer;
  v_picks    jsonb;
  v_swapped  jsonb;
  v_both     jsonb;
  v_rep      text := '';
  v_expect   integer;
  v_got      integer;
begin
  select gm.user_id into v_admin from public.group_members gm where gm.role = 'admin' limit 1;
  if v_admin is null then
    raise exception 'No admin found in group_members';
  end if;

  select e.id, e.season into v_event, v_season
  from public.events e
  where e.status = 'scheduled'
    and exists (select 1 from public.sessions s where s.event_id = e.id and s.start_utc > now() + interval '1 hour')
    and not exists (select 1 from public.sessions s where s.event_id = e.id and (s.start_utc is null or s.start_utc <= now()))
  order by e.start_date
  limit 1;
  if v_event is null then
    raise exception 'No upcoming scheduled event with confirmed future session times was found';
  end if;

  select array_agg(s.id order by s.id) into v_sessions from public.sessions s where s.event_id = v_event;
  select s.id into v_q from public.sessions s where s.event_id = v_event and s.session_type = 'qualifying';
  select d.id into v_out from public.drivers d where d.season = v_season and d.is_active order by d.code limit 1;

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  -- 1 preview
  v_res := public.admin_preview_substitution(v_event, v_out, null);
  v_rep := v_rep || '1 preview: event ' || v_event || ', sessions = ' || jsonb_array_length(v_res -> 'sessions') ||
           ', eligible = ' || (select count(*) from jsonb_array_elements(v_res -> 'sessions') x where (x ->> 'eligible')::boolean) || E'\n';

  -- 2 register with a NEW driver (created inactive)
  v_res := public.admin_register_substitution(
    v_event, v_out, null,
    jsonb_build_object('code', 'ZZZ', 'full_name', 'Test Driver', 'team_name', 'Test Team', 'car_number', '99', 'external_id', 'test_zzz'),
    v_sessions, '{}'::text[], 'rollback-only test');
  v_new := v_res ->> 'new_driver_id';
  v_sub := (v_res ->> 'substitution_id')::uuid;
  v_rep := v_rep || '2 register: new driver ' || v_new || ', notified = ' || (v_res ->> 'notified') || E'\n';

  -- 3 lineup (as a signed-in user would read it)
  v_arr := public.session_lineup(v_q);
  v_rep := v_rep || '3 lineup: size ' || cardinality(v_arr) || ', outgoing present ' || (v_out = any (v_arr))::text ||
           ', new present ' || (v_new = any (v_arr))::text || E'\n';

  -- 4 validation (service-level function, so leave the signed-in role)
  execute 'reset role';
  select ls.o_use, ls.o_lineup, ls.o_stand_ins into v_state from public.session_lineup_state(v_q) ls;
  v_arr := v_state.o_lineup;
  v_n := cardinality(v_arr);
  v_picks := jsonb_build_object(
    'q1_out',   to_jsonb(v_arr[1:v_n - 16]),
    'q2_out',   to_jsonb(v_arr[v_n - 15:v_n - 10]),
    'q3_order', to_jsonb(v_arr[v_n - 9:v_n]));

  begin
    perform public.validate_session_data('qualifying', v_picks, v_season, false, v_arr, '{}'::jsonb);
    v_rep := v_rep || E'4a lineup picks: accepted\n';
  exception when others then
    v_rep := v_rep || '4a lineup picks: REJECTED ' || sqlerrm || E'\n';
  end;

  v_swapped := replace(v_picks::text, '"' || v_new || '"', '"' || v_out || '"')::jsonb;

  begin
    perform public.validate_session_data('qualifying', v_swapped, v_season, false, v_arr, '{}'::jsonb);
    v_rep := v_rep || E'4b withdrawn pick, no stand-in: accepted (UNEXPECTED)\n';
  exception when others then
    v_rep := v_rep || '4b withdrawn pick, no stand-in: REJECTED ' || sqlerrm || E'\n';
  end;

  begin
    perform public.validate_session_data('qualifying', v_swapped, v_season, false, v_arr, jsonb_build_object(v_out, v_new));
    v_rep := v_rep || E'4c withdrawn pick saved by the player: accepted\n';
  exception when others then
    v_rep := v_rep || '4c withdrawn pick saved by the player: REJECTED (UNEXPECTED) ' || sqlerrm || E'\n';
  end;

  v_both := replace(v_picks::text, '"' || v_arr[2] || '"', '"' || v_out || '"')::jsonb;
  begin
    perform public.validate_session_data('qualifying', v_both, v_season, false, v_arr, jsonb_build_object(v_out, v_new));
    v_rep := v_rep || E'4d both withdrawn and replacement: accepted (UNEXPECTED)\n';
  exception when others then
    v_rep := v_rep || '4d both withdrawn and replacement: REJECTED ' || sqlerrm || E'\n';
  end;

  begin
    perform public.validate_session_data('qualifying', v_picks, v_season, true, v_arr);
    perform public.validate_session_data('qualifying', v_swapped, v_season, true, v_arr);
    v_rep := v_rep || E'4e result: withdrawn driver accepted (UNEXPECTED)\n';
  exception when others then
    v_rep := v_rep || '4e result: lineup accepted, withdrawn driver REJECTED ' || sqlerrm || E'\n';
  end;

  -- 5 notifications: one per player with a saved prediction, no duplicates
  select count(distinct pr.user_id) into v_expect from public.predictions pr where pr.session_id = any (v_sessions);
  select count(*) into v_got from public.player_notifications n where n.source_id = (v_res ->> 'batch_id')::uuid;
  v_rep := v_rep || '5 notifications: created ' || v_got || ', players with predictions ' || v_expect || E'\n';

  -- 6 revert
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  v_res := public.admin_revert_substitution(v_sub, 'rollback-only test');
  execute 'reset role';
  select ls.o_use, ls.o_lineup, ls.o_stand_ins into v_state from public.session_lineup_state(v_q) ls;
  v_rep := v_rep || '6 revert: reverted sessions = ' || jsonb_array_length(v_res -> 'reverted_sessions') ||
           ', outgoing back in lineup ' || (v_out = any (v_state.o_lineup))::text ||
           ', new driver in lineup ' || (v_new = any (v_state.o_lineup))::text ||
           ', new driver maps back to ' || coalesce(v_state.o_stand_ins ->> v_new, 'NOTHING (UNEXPECTED)') || E'\n';

  -- 7 second revert must be refused
  execute 'set local role authenticated';
  begin
    perform public.admin_revert_substitution(v_sub, 'rollback-only test again');
    v_rep := v_rep || E'7 second revert: accepted (UNEXPECTED)\n';
  exception when others then
    v_rep := v_rep || '7 second revert: REJECTED ' || sqlerrm || E'\n';
  end;
  execute 'reset role';

  raise exception E'TEST REPORT (nothing was saved):\n%', v_rep;
end;
$$;
