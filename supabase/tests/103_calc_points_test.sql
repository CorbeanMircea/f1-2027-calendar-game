-- Scoring rules of the database function calc_points (migrations 009, 010 and 020). Replaces the retired test 009 and covers the
-- multi-DNF rule of migration 020. The same scenarios, with the same numbers, are checked against the browser's scoring engine
-- (scorecard-engine.js) by tests/unit/scorecard-engine.spec.js, so the two can never drift apart unnoticed.
-- Pure calculation: it needs no members, creates no data, and ends with an ERROR ON PURPOSE.

do $$
declare
  r      text := '';
  v_ids  text[] := array['2026-alb','2026-alo','2026-ant','2026-bea','2026-bor','2026-bot','2026-col','2026-gas','2026-had','2026-ham',
                         '2026-hul','2026-law','2026-lec','2026-lin','2026-nor','2026-oco','2026-per','2026-pia','2026-rus','2026-sai',
                         '2026-str','2026-ver'];
  v_qa   jsonb;   -- qualifying result: ids 17-22 out in Q1, 11-16 out in Q2, 1-10 reach Q3 in this order
  v_ra   jsonb;   -- race result with no retirements
  v_n    integer;
  v_c    jsonb;
begin
  v_qa := jsonb_build_object('q1_out', to_jsonb(v_ids[17:22]), 'q2_out', to_jsonb(v_ids[11:16]), 'q3_order', to_jsonb(v_ids[1:10]));
  v_ra := jsonb_build_object('top8', to_jsonb(v_ids[1:8]), 'fastest_lap', v_ids[1], 'dnf_drivers', '[]'::jsonb, 'grid_top8', to_jsonb(v_ids[1:8]));

  -- Qualifying (maximum 62) ----------------------------------------------------------------------------------------------------------
  v_c := public.calc_points('qualifying', v_qa, v_qa);
  r := r || case when (v_c ->> 'total')::int = 62 and (v_c ->> 'group')::int = 22 and (v_c ->> 'exact')::int = 30 and (v_c ->> 'bonus')::int = 10
                 then 'ok    ' else 'FAIL  ' end || E'a perfect qualifying prediction scores 62 (22 group + 30 exact + 10 bonus)\n';
  r := r || case when (public.calc_points('qualifying', '{}'::jsonb, v_qa) ->> 'total')::int = 0 then 'ok    ' else 'FAIL  ' end || E'an empty qualifying prediction scores 0\n';
  r := r || case when (public.calc_points('qualifying',
        jsonb_build_object('q1_out', to_jsonb(v_ids[1:6]), 'q2_out', to_jsonb(v_ids[1:6]), 'q3_order', to_jsonb(v_ids[11:20])), v_qa) ->> 'total')::int = 0
        then 'ok    ' else 'FAIL  ' end || E'a completely wrong qualifying prediction scores 0\n';
  v_c := public.calc_points('qualifying',
        jsonb_build_object('q1_out', '[]'::jsonb, 'q2_out', '[]'::jsonb, 'q3_order', to_jsonb(array[v_ids[10],v_ids[9],v_ids[8],v_ids[7],v_ids[6],v_ids[5],v_ids[4],v_ids[3],v_ids[2],v_ids[1]])), v_qa);
  r := r || case when (v_c ->> 'total')::int = 10 and (v_c ->> 'exact')::int = 0 and (v_c ->> 'bonus')::int = 0 then 'ok    ' else 'FAIL  ' end
         || E'the right ten drivers in reverse order score 1 each, no exact points, no bonus\n';
  v_c := public.calc_points('qualifying',
        jsonb_build_object('q1_out', to_jsonb(array[v_ids[17],v_ids[18],v_ids[19],v_ids[1],v_ids[2],v_ids[3]]),
                           'q2_out', to_jsonb(array[v_ids[11],v_ids[12],v_ids[1],v_ids[2],v_ids[3],v_ids[4]]),
                           'q3_order', to_jsonb(array[v_ids[1],v_ids[2],v_ids[3],v_ids[4],v_ids[8],v_ids[11],v_ids[5],v_ids[6],v_ids[7],v_ids[9]])), v_qa);
  r := r || case when (v_c ->> 'total')::int = 26 and (v_c ->> 'group')::int = 14 and (v_c ->> 'exact')::int = 12 and (v_c ->> 'bonus')::int = 0
                 then 'ok    ' else 'FAIL  ' end || E'a mixed qualifying prediction adds up (3 + 2 + 16 + 5 = 26)\n';
  r := r || case when (public.calc_points('sprint_qualifying', v_qa, v_qa) ->> 'total')::int = 62 then 'ok    ' else 'FAIL  ' end
         || E'sprint qualifying is scored like qualifying\n';

  -- Sprint (maximum 32) ---------------------------------------------------------------------------------------------------------------------
  r := r || case when (public.calc_points('sprint', jsonb_build_object('top8', to_jsonb(v_ids[1:8])), jsonb_build_object('top8', to_jsonb(v_ids[1:8]))) ->> 'total')::int = 32
                 then 'ok    ' else 'FAIL  ' end || E'a perfect sprint top 8 scores 32 (8 x 3 + 8 bonus)\n';
  r := r || case when (public.calc_points('sprint',
        jsonb_build_object('top8', to_jsonb(array[v_ids[1],v_ids[2],v_ids[3],v_ids[5],v_ids[4],v_ids[20],v_ids[21],v_ids[22]])),
        jsonb_build_object('top8', to_jsonb(v_ids[1:8]))) ->> 'total')::int = 11
        then 'ok    ' else 'FAIL  ' end || E'sprint: exact = 3, right driver in the wrong place = 1, outside the top 8 = 0 (9 + 2 = 11)\n';
  r := r || case when (public.calc_points('sprint',
        jsonb_build_object('top8', to_jsonb(array[v_ids[1],v_ids[2],v_ids[3],v_ids[4],v_ids[5],v_ids[6],v_ids[7],v_ids[20]])),
        jsonb_build_object('top8', to_jsonb(v_ids[1:8]))) ->> 'total')::int = 21
        then 'ok    ' else 'FAIL  ' end || E'seven exact sprint positions do not earn the bonus (21)\n';
  r := r || case when (public.calc_points('sprint', '{}'::jsonb, jsonb_build_object('top8', to_jsonb(v_ids[1:8]))) ->> 'total')::int = 0
                 then 'ok    ' else 'FAIL  ' end || E'an empty sprint prediction scores 0\n';

  -- Race, no retirements (maximum 65) ----------------------------------------------------------------------------------------------------------
  v_c := public.calc_points('race', jsonb_build_object('top8', to_jsonb(v_ids[1:8]), 'fastest_lap', v_ids[1], 'any_dnf', false, 'dnf_count', 0, 'dnf_drivers', '[]'::jsonb), v_ra);
  r := r || case when (v_c ->> 'total')::int = 65 and (v_c ->> 'exact')::int = 40 and (v_c ->> 'bonus')::int = 15 and (v_c ->> 'fastest_lap')::int = 3
                  and (v_c ->> 'any_dnf')::int = 2 and (v_c ->> 'dnf_count')::int = 5
                 then 'ok    ' else 'FAIL  ' end || E'a perfect Race prediction scores 65 (40 + 15 bonus + 3 fastest lap + 2 + 5)\n';
  r := r || case when (public.calc_points('race', jsonb_build_object('top8', to_jsonb(array[v_ids[1],v_ids[2],v_ids[3],v_ids[4],v_ids[5],v_ids[6],v_ids[7],v_ids[20]]),
        'any_dnf', false, 'dnf_count', 0), v_ra) ->> 'bonus')::int = 0
        then 'ok    ' else 'FAIL  ' end || E'seven exact Race positions do not earn the 15-point bonus\n';
  r := r || case when (public.calc_points('race', jsonb_build_object('fastest_lap', v_ids[2], 'any_dnf', false, 'dnf_count', 0), v_ra) ->> 'fastest_lap')::int = 0
                  and (public.calc_points('race', jsonb_build_object('fastest_lap', v_ids[1], 'any_dnf', false, 'dnf_count', 0), v_ra) ->> 'fastest_lap')::int = 3
                 then 'ok    ' else 'FAIL  ' end || E'fastest lap: 3 for the right driver, 0 for the wrong one\n';

  -- Race, retirements (migrations 010 and 020) ---------------------------------------------------------------------------------------------------
  -- Two retirements: ids[3] started in the real top 8, ids[20] did not.
  v_c := public.calc_points('race',
        jsonb_build_object('top8', to_jsonb(array[v_ids[1],v_ids[2],v_ids[4],v_ids[5],v_ids[6],v_ids[21],v_ids[22],v_ids[19]]),
                           'fastest_lap', v_ids[9], 'any_dnf', true, 'dnf_count', 2, 'dnf_drivers', to_jsonb(array[v_ids[3], v_ids[20], v_ids[11]])),
        jsonb_build_object('top8', to_jsonb(v_ids[1:8]), 'fastest_lap', v_ids[2], 'dnf_drivers', to_jsonb(array[v_ids[3], v_ids[20]]), 'grid_top8', to_jsonb(v_ids[1:8])));
  r := r || case when (v_c ->> 'dnf_driver')::int = 12 then 'ok    ' else 'FAIL  ' end
         || E'a DNF pick scores 8 if he started in the real top 8, 4 if not, 0 if he did not retire (8 + 4 + 0)\n';
  r := r || case when (v_c ->> 'total')::int = 35 and (v_c ->> 'exact')::int = 10 and (v_c ->> 'in_top8')::int = 6 and (v_c ->> 'any_dnf')::int = 2 and (v_c ->> 'dnf_count')::int = 5
                 then 'ok    ' else 'FAIL  ' end || E'the whole two-retirement example adds up (10 + 6 + 2 + 5 + 12 = 35)\n';

  -- The number of retirements: exact 5, one off 2, further off 0.
  v_n := 0;
  r := r || case when (public.calc_points('race', jsonb_build_object('any_dnf', true, 'dnf_count', 1),
            jsonb_build_object('dnf_drivers', to_jsonb(array[v_ids[20]]), 'grid_top8', '[]'::jsonb)) ->> 'dnf_count')::int = 5 then 'ok    ' else 'FAIL  ' end || E'DNF count exactly right scores 5\n';
  r := r || case when (public.calc_points('race', jsonb_build_object('any_dnf', true, 'dnf_count', 2),
            jsonb_build_object('dnf_drivers', to_jsonb(array[v_ids[20]]), 'grid_top8', '[]'::jsonb)) ->> 'dnf_count')::int = 2 then 'ok    ' else 'FAIL  ' end || E'DNF count one off scores 2\n';
  r := r || case when (public.calc_points('race', jsonb_build_object('any_dnf', true, 'dnf_count', 3),
            jsonb_build_object('dnf_drivers', to_jsonb(array[v_ids[20]]), 'grid_top8', '[]'::jsonb)) ->> 'dnf_count')::int = 0 then 'ok    ' else 'FAIL  ' end || E'DNF count two or more off scores 0\n';

  -- The yes/no question.
  r := r || case when (public.calc_points('race', jsonb_build_object('any_dnf', false, 'dnf_count', 0),
            jsonb_build_object('dnf_drivers', to_jsonb(array[v_ids[20], v_ids[21]]), 'grid_top8', '[]'::jsonb)) ->> 'any_dnf')::int = 0
                  and (public.calc_points('race', jsonb_build_object('any_dnf', true, 'dnf_count', 0),
            jsonb_build_object('dnf_drivers', to_jsonb(array[v_ids[20], v_ids[21]]), 'grid_top8', '[]'::jsonb)) ->> 'any_dnf')::int = 2
                  and (public.calc_points('race', jsonb_build_object('any_dnf', false, 'dnf_count', 0), v_ra) ->> 'any_dnf')::int = 2
                  and (public.calc_points('race', jsonb_build_object('any_dnf', true, 'dnf_count', 0), v_ra) ->> 'any_dnf')::int = 0
                 then 'ok    ' else 'FAIL  ' end || E'"any DNF" scores 2 only when the yes/no answer is right\n';

  -- The old single dnf_driver field still scores.
  r := r || case when (public.calc_points('race', jsonb_build_object('any_dnf', true, 'dnf_count', 1, 'dnf_driver', v_ids[3]),
            jsonb_build_object('top8', to_jsonb(v_ids[1:8]), 'dnf_drivers', to_jsonb(array[v_ids[3]]), 'grid_top8', to_jsonb(v_ids[1:8]))) ->> 'dnf_driver')::int = 8
        then 'ok    ' else 'FAIL  ' end || E'the legacy single dnf_driver field still scores\n';

  -- The published maximum with five retirements who all started in the top 8: 65 + 5 x 8 = 105.
  v_c := public.calc_points('race',
        jsonb_build_object('top8', to_jsonb(v_ids[1:8]), 'fastest_lap', v_ids[1], 'any_dnf', true, 'dnf_count', 5, 'dnf_drivers', to_jsonb(v_ids[9:13])),
        jsonb_build_object('top8', to_jsonb(v_ids[1:8]), 'fastest_lap', v_ids[1], 'dnf_drivers', to_jsonb(v_ids[9:13]), 'grid_top8', to_jsonb(v_ids[9:13] || v_ids[1:3])));
  r := r || case when (v_c ->> 'total')::int = 105 and (v_c ->> 'dnf_driver')::int = 40 then 'ok    ' else 'FAIL  ' end
         || E'a perfect Race with five retirements scores 65 + 5 x 8 = 105\n';

  -- Empty and missing input never fails.
  r := r || case when (public.calc_points('race', '{}'::jsonb, '{"dnf_drivers":[]}'::jsonb) ->> 'total')::int = 0
                  and (public.calc_points('sprint', '{}'::jsonb, '{}'::jsonb) ->> 'total')::int = 0
                 then 'ok    ' else 'FAIL  ' end || E'empty predictions score 0 and never raise an error\n';

  raise exception E'CALC POINTS TEST REPORT (this error is expected; nothing was written)\nRESULT: %\n%',
    case when r like '%FAIL%' then 'FAILURES' else 'ALL OK' end, r;
end;
$$;
