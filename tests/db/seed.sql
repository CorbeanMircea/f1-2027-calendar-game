-- LIGHTS OUT - LOCAL TEST SEED (runs ONLY against the local Docker database; never against production).
--
-- Creates, using the application's own functions wherever possible:
--   * 1 admin and 3 players in one group (fixed ids, so every run is identical)
--   * Predictions and APPROVED results for four 2026 test sessions, so the leaderboard, statistics and
--     title-caller tests have scored data. The three players deliberately predict differently.
-- The users have no password: they exist for the SQL tests. Browser tests (T4) create their own sign-in users.
--
-- Safe to read: it only inserts. Run it on a freshly replayed database (npm run db:seed does the whole sequence).
begin;

-- 1. Users (auth.users is Supabase's own table; only the columns the tests need) -----------------------------
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'seed-admin@lightsout.test',   now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'seed-player1@lightsout.test', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('00000000-0000-4000-8000-0000000000b2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'seed-player2@lightsout.test', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('00000000-0000-4000-8000-0000000000b3', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'seed-player3@lightsout.test', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now());

-- 2. The group (invite codes are stored upper-case, letters and digits only) ---------------------------------
insert into public.groups (name, invite_code) values ('Lights Out Test Group', 'LOSEEDCODE1');

-- 3. Join the group with the real join_group() function, then make the first user an admin -----------------
do $$
declare
  v_ids   uuid[] := array['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1',
                          '00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-0000000000b3']::uuid[];
  v_names text[] := array['Seed Admin', 'Seed Player 1', 'Seed Player 2', 'Seed Player 3'];
  i       integer;
begin
  for i in 1 .. array_length(v_ids, 1) loop
    perform set_config('request.jwt.claims', json_build_object('sub', v_ids[i], 'role', 'authenticated')::text, true);
    set local role authenticated;
    perform public.join_group('LO-SEED-CODE-1', v_names[i]);
    reset role;
    -- Members get distinct, ordered join times (tests pick "the first member" by joined_at).
    update public.group_members set joined_at = now() - interval '10 days' + (i * interval '1 minute') where user_id = v_ids[i];
  end loop;
  update public.group_members set role = 'admin' where user_id = v_ids[1];
end $$;

-- 4. Predictions for four 2026 test sessions (inserted directly, dated BEFORE each session, so they are full value) ---
-- Drivers: 2026 test season (migration 013). "Actual" order used for the results below:
--   qualifying: Q3 = alb alo ant bea bor bot col gas had ham  | Q2 out = hul law lec lin nor oco | Q1 out = per pia rus sai str ver
--   race:       top 8 = alb alo ant bea bor bot col gas, fastest lap alb, one retirement (hul, who started P9).
insert into public.predictions (user_id, session_id, picks, created_at, updated_at)
select p.user_id, p.session_id, p.picks, p.stamp, p.stamp
from (values
  -- Player 1: very good predictor (perfect qualifying, near-perfect race)
  ('00000000-0000-4000-8000-0000000000b1'::uuid, 'australia-2026-qualifying',
   '{"q1_out":["2026-per","2026-pia","2026-rus","2026-sai","2026-str","2026-ver"],"q2_out":["2026-hul","2026-law","2026-lec","2026-lin","2026-nor","2026-oco"],"q3_order":["2026-alb","2026-alo","2026-ant","2026-bea","2026-bor","2026-bot","2026-col","2026-gas","2026-had","2026-ham"]}'::jsonb,
   timestamptz '2026-03-05 12:00+00'),
  ('00000000-0000-4000-8000-0000000000b1'::uuid, 'australia-2026-race',
   '{"top8":["2026-alb","2026-alo","2026-ant","2026-bea","2026-bor","2026-bot","2026-col","2026-gas"],"fastest_lap":"2026-alb","any_dnf":true,"dnf_count":1,"dnf_drivers":["2026-hul"]}'::jsonb,
   timestamptz '2026-03-05 12:00+00'),
  ('00000000-0000-4000-8000-0000000000b1'::uuid, 'china-2026-qualifying',
   '{"q1_out":["2026-per","2026-pia","2026-rus","2026-sai","2026-str","2026-ver"],"q2_out":["2026-hul","2026-law","2026-lec","2026-lin","2026-nor","2026-oco"],"q3_order":["2026-alo","2026-alb","2026-ant","2026-bea","2026-bor","2026-bot","2026-col","2026-gas","2026-had","2026-ham"]}'::jsonb,
   timestamptz '2026-03-12 12:00+00'),
  ('00000000-0000-4000-8000-0000000000b1'::uuid, 'china-2026-race',
   '{"top8":["2026-alb","2026-alo","2026-bea","2026-ant","2026-bor","2026-bot","2026-col","2026-gas"],"fastest_lap":"2026-alo","any_dnf":false,"dnf_count":0,"dnf_drivers":[]}'::jsonb,
   timestamptz '2026-03-12 12:00+00'),
  -- Player 2: middling predictor
  ('00000000-0000-4000-8000-0000000000b2'::uuid, 'australia-2026-qualifying',
   '{"q1_out":["2026-per","2026-pia","2026-rus","2026-ham","2026-str","2026-ver"],"q2_out":["2026-hul","2026-law","2026-lec","2026-lin","2026-sai","2026-oco"],"q3_order":["2026-alo","2026-alb","2026-bea","2026-ant","2026-bor","2026-col","2026-bot","2026-gas","2026-had","2026-nor"]}'::jsonb,
   timestamptz '2026-03-05 13:00+00'),
  ('00000000-0000-4000-8000-0000000000b2'::uuid, 'australia-2026-race',
   '{"top8":["2026-alb","2026-ant","2026-alo","2026-bea","2026-bor","2026-gas","2026-col","2026-lec"],"fastest_lap":"2026-alo","any_dnf":false,"dnf_count":0,"dnf_drivers":[]}'::jsonb,
   timestamptz '2026-03-05 13:00+00'),
  ('00000000-0000-4000-8000-0000000000b2'::uuid, 'china-2026-qualifying',
   '{"q1_out":["2026-per","2026-pia","2026-rus","2026-sai","2026-str","2026-ver"],"q2_out":["2026-hul","2026-law","2026-lec","2026-lin","2026-nor","2026-oco"],"q3_order":["2026-alb","2026-alo","2026-ant","2026-bea","2026-bor","2026-bot","2026-col","2026-gas","2026-had","2026-ham"]}'::jsonb,
   timestamptz '2026-03-12 13:00+00'),
  -- Player 3: weak predictor, and no China race prediction at all (a missing prediction scores nothing)
  ('00000000-0000-4000-8000-0000000000b3'::uuid, 'australia-2026-qualifying',
   '{"q1_out":["2026-alb","2026-alo","2026-ant","2026-bea","2026-bor","2026-bot"],"q2_out":["2026-col","2026-gas","2026-had","2026-ham","2026-hul","2026-law"],"q3_order":["2026-per","2026-pia","2026-rus","2026-sai","2026-str","2026-ver","2026-lec","2026-lin","2026-nor","2026-oco"]}'::jsonb,
   timestamptz '2026-03-05 14:00+00'),
  ('00000000-0000-4000-8000-0000000000b3'::uuid, 'australia-2026-race',
   '{"top8":["2026-ver","2026-per","2026-pia","2026-rus","2026-sai","2026-str","2026-nor","2026-oco"],"fastest_lap":"2026-ver","any_dnf":true,"dnf_count":2,"dnf_drivers":["2026-lec","2026-lin"]}'::jsonb,
   timestamptz '2026-03-05 14:00+00'),
  ('00000000-0000-4000-8000-0000000000b3'::uuid, 'china-2026-qualifying',
   '{"q1_out":["2026-per","2026-pia","2026-rus","2026-sai","2026-str","2026-ver"],"q2_out":["2026-lec","2026-lin","2026-nor","2026-oco","2026-hul","2026-law"],"q3_order":["2026-alo","2026-ant","2026-alb","2026-bor","2026-bea","2026-bot","2026-gas","2026-col","2026-ham","2026-had"]}'::jsonb,
   timestamptz '2026-03-12 14:00+00')
) as p(user_id, session_id, picks, stamp);

-- 5. Results: entered, then APPROVED by the admin through the real admin function (which scores everyone) ----------------
create temp table seed_results (session_id text primary key, result_id uuid) on commit drop;

insert into seed_results (session_id, result_id) values
  ('australia-2026-qualifying', public.enter_result('australia-2026-qualifying',
     '{"q1_out":["2026-per","2026-pia","2026-rus","2026-sai","2026-str","2026-ver"],"q2_out":["2026-hul","2026-law","2026-lec","2026-lin","2026-nor","2026-oco"],"q3_order":["2026-alb","2026-alo","2026-ant","2026-bea","2026-bor","2026-bot","2026-col","2026-gas","2026-had","2026-ham"]}'::jsonb, 'seed')),
  ('australia-2026-race', public.enter_result('australia-2026-race',
     '{"top8":["2026-alb","2026-alo","2026-ant","2026-bea","2026-bor","2026-bot","2026-col","2026-gas"],"fastest_lap":"2026-alb","dnf_drivers":["2026-hul"],"grid_top8":["2026-alb","2026-alo","2026-ant","2026-bea","2026-bor","2026-bot","2026-col","2026-hul"]}'::jsonb, 'seed')),
  ('china-2026-qualifying', public.enter_result('china-2026-qualifying',
     '{"q1_out":["2026-per","2026-pia","2026-rus","2026-sai","2026-str","2026-ver"],"q2_out":["2026-hul","2026-law","2026-lec","2026-lin","2026-nor","2026-oco"],"q3_order":["2026-alb","2026-alo","2026-ant","2026-bea","2026-bor","2026-bot","2026-col","2026-gas","2026-had","2026-ham"]}'::jsonb, 'seed')),
  ('china-2026-race', public.enter_result('china-2026-race',
     '{"top8":["2026-alb","2026-alo","2026-ant","2026-bea","2026-bor","2026-bot","2026-col","2026-gas"],"fastest_lap":"2026-alo","dnf_drivers":[],"grid_top8":["2026-alb","2026-alo","2026-ant","2026-bea","2026-bor","2026-bot","2026-col","2026-gas"]}'::jsonb, 'seed'));

do $$
declare
  v_results uuid[];
  i         integer;
begin
  select array_agg(result_id order by session_id) into v_results from seed_results;
  perform set_config('request.jwt.claims',
    json_build_object('sub', '00000000-0000-4000-8000-0000000000a1', 'role', 'authenticated')::text, true);
  set local role authenticated;
  for i in 1 .. array_length(v_results, 1) loop
    perform public.admin_approve_result(v_results[i]);
  end loop;
  reset role;
end $$;

-- 6. Self-check: the seed must have produced what the tests expect --------------------------------------------------------
do $$
declare v_members int; v_admins int; v_scored int; v_players int;
begin
  select count(*), count(*) filter (where role = 'admin') into v_members, v_admins from public.group_members;
  select count(*), count(distinct user_id) into v_scored, v_players from public.scores;
  if v_members <> 4 or v_admins <> 1 then raise exception 'Seed check failed: expected 4 members with 1 admin, got % with %', v_members, v_admins; end if;
  if v_players <> 3 or v_scored < 9 then raise exception 'Seed check failed: expected scores for 3 players (at least 9 rows), got % players and % rows', v_players, v_scored; end if;
end $$;

commit;
