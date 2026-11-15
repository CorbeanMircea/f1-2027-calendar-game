-- OPTIONAL scenario check for 037. NOTHING IS SAVED: the script always ends with an exception, which rolls back everything it
-- did (the correction, the rescoring, the notification). The exception message IS the report.
--
-- It needs a group admin and ONE session that is closed to players, has an approved result and a scored prediction.
-- Run it in the Supabase SQL Editor. "TEST REPORT (nothing was saved)" is the expected message.
--
-- Expected report:
--   1 correct ...... corrected 1; picks changed; created_at and updated_at unchanged; correction logged with the original picks and
--                    the player's original submission time; one notification; no other score and no season score changed
--   2 invalid ...... REJECTED (Cannot correct ...: ...) and the picks were not changed
--   3 revert ....... picks restored; the score is back to the original; created_at and updated_at unchanged; two log rows
--   4 revert again . REJECTED (This correction has already been reverted)

do $$
declare
  v_admin     uuid;
  v_session   text;
  v_type      text;
  v_pred      record;
  v_key       text;
  v_arr       jsonb;
  v_new       jsonb;
  v_bad       jsonb;
  v_res       jsonb;
  v_corr      uuid;
  v_cur       record;
  v_pts0      integer;
  v_pts1      integer;
  v_others0   numeric;
  v_others1   numeric;
  v_season0   bigint;
  v_season1   bigint;
  v_rows      integer;
  v_notes     integer;
  v_rep       text := '';
begin
  select gm.user_id into v_admin from public.group_members gm where gm.role = 'admin' limit 1;
  if v_admin is null then
    raise exception 'No admin found in group_members';
  end if;

  select s.id, s.session_type into v_session, v_type
  from public.sessions s
  where exists (select 1 from public.results r where r.session_id = s.id and r.status = 'approved')
    and exists (select 1 from public.scores sc where sc.session_id = s.id)
    and not coalesce((select pw.is_open from public.prediction_windows pw where pw.session_id = s.id), false)
  order by s.id
  limit 1;
  if v_session is null then
    raise exception 'No closed session with an approved result and a scored prediction was found';
  end if;

  select p.id, p.user_id, p.picks, p.created_at, p.updated_at, sc.points into v_pred
  from public.predictions p
  join public.scores sc on sc.user_id = p.user_id and sc.session_id = p.session_id
  where p.session_id = v_session
  order by p.created_at
  limit 1;

  v_key := case when v_type in ('qualifying', 'sprint_qualifying') then 'q3_order' else 'top8' end;
  v_arr := v_pred.picks -> v_key;
  -- A valid change: swap the first two drivers of the order.
  v_new := jsonb_set(v_pred.picks, array[v_key],
             jsonb_build_array(v_arr -> 1, v_arr -> 0) ||
             coalesce((select jsonb_agg(x.value order by x.ordinality)
                       from jsonb_array_elements(v_arr) with ordinality as x(value, ordinality)
                       where x.ordinality > 2), '[]'::jsonb));
  -- An invalid change: the first driver listed twice.
  v_bad := jsonb_set(v_pred.picks, array[v_key],
             jsonb_build_array(v_arr -> 1, v_arr -> 1) ||
             coalesce((select jsonb_agg(x.value order by x.ordinality)
                       from jsonb_array_elements(v_arr) with ordinality as x(value, ordinality)
                       where x.ordinality > 2), '[]'::jsonb));

  v_pts0 := v_pred.points;
  select coalesce(sum(sc.points), 0) into v_others0 from public.scores sc
   where not (sc.user_id = v_pred.user_id and sc.session_id = v_session);
  select count(*) into v_season0 from public.season_scores;

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  -- 1 correct
  v_res := public.admin_correct_predictions(
    v_session, jsonb_build_array(jsonb_build_object('user_id', v_pred.user_id, 'picks', v_new)), 'rollback-only test');
  v_corr := (v_res -> 'players' -> 0 ->> 'correction_id')::uuid;

  execute 'reset role';
  select p.picks, p.created_at, p.updated_at into v_cur from public.predictions p where p.id = v_pred.id;
  select sc.points into v_pts1 from public.scores sc where sc.user_id = v_pred.user_id and sc.session_id = v_session;
  select coalesce(sum(sc.points), 0) into v_others1 from public.scores sc
   where not (sc.user_id = v_pred.user_id and sc.session_id = v_session);
  select count(*) into v_season1 from public.season_scores;
  select count(*) into v_rows from public.prediction_corrections c
   where c.id = v_corr and c.before_picks = v_pred.picks and c.after_picks = v_new
     and c.original_created_at = v_pred.created_at and c.original_updated_at = v_pred.updated_at;
  select count(*) into v_notes from public.player_notifications n
   where n.user_id = v_pred.user_id and n.kind = 'prediction_corrected' and n.source_id = v_corr;

  v_rep := v_rep || '1 correct: corrected ' || (v_res ->> 'corrected') || ', picks changed ' || (v_cur.picks = v_new)::text ||
           ', created_at unchanged ' || (v_cur.created_at = v_pred.created_at)::text ||
           ', updated_at unchanged ' || (v_cur.updated_at = v_pred.updated_at)::text ||
           ', score ' || coalesce(v_pts0::text, '-') || ' -> ' || coalesce(v_pts1::text, '-') ||
           ', log row with the original picks and time ' || (v_rows = 1)::text ||
           ', notification ' || v_notes ||
           ', no other score changed ' || (v_others0 = v_others1)::text ||
           ', season scores unchanged ' || (v_season0 = v_season1)::text || E'\n';

  -- 2 invalid picks are refused and nothing changes
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    perform public.admin_correct_predictions(
      v_session, jsonb_build_array(jsonb_build_object('user_id', v_pred.user_id, 'picks', v_bad)), 'rollback-only test invalid');
    v_rep := v_rep || E'2 invalid: accepted (UNEXPECTED)\n';
  exception when others then
    v_rep := v_rep || '2 invalid: REJECTED ' || sqlerrm || E'\n';
  end;

  -- 3 revert
  v_res := public.admin_revert_correction(v_corr, 'rollback-only test');
  execute 'reset role';
  select p.picks, p.created_at, p.updated_at into v_cur from public.predictions p where p.id = v_pred.id;
  select sc.points into v_pts1 from public.scores sc where sc.user_id = v_pred.user_id and sc.session_id = v_session;
  select count(*) into v_rows from public.prediction_corrections c where c.prediction_id = v_pred.id;
  v_rep := v_rep || '3 revert: picks restored ' || (v_cur.picks = v_pred.picks)::text ||
           ', score back to the original ' || (v_pts1 is not distinct from v_pts0)::text ||
           ', created_at unchanged ' || (v_cur.created_at = v_pred.created_at)::text ||
           ', updated_at unchanged ' || (v_cur.updated_at = v_pred.updated_at)::text ||
           ', log rows ' || v_rows || E'\n';

  -- 4 a second revert of the same correction is refused
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    perform public.admin_revert_correction(v_corr, 'rollback-only test again');
    v_rep := v_rep || E'4 revert again: accepted (UNEXPECTED)\n';
  exception when others then
    v_rep := v_rep || '4 revert again: REJECTED ' || sqlerrm || E'\n';
  end;
  execute 'reset role';

  raise exception E'TEST REPORT (nothing was saved):\n%', v_rep;
end;
$$;
