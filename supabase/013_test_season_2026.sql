-- 013: REAL 2026 race data used to test the importer (Australia R1 and China R2).
-- Remove with supabase/maintenance/remove_test_season_2026.sql

insert into public.events
  (id, season, round, name, circuit, locality, country, start_date, end_date, has_sprint, status)
values
  ('australia-2026', 2026, 1, 'Australian Grand Prix (2026 test data)', 'Albert Park Grand Prix Circuit',
   'Melbourne', 'Australia', '2026-03-06', '2026-03-08', false, 'scheduled'),
  ('china-2026', 2026, 2, 'Chinese Grand Prix (2026 test data)', 'Shanghai International Circuit',
   'Shanghai', 'China', '2026-03-13', '2026-03-15', true, 'scheduled')
on conflict (id) do nothing;

insert into public.drivers (id, season, code, full_name, team_name, car_number, external_id) values
  ('2026-rus', 2026, 'RUS', 'George Russell',          'Mercedes',         63, 'russell'),
  ('2026-ant', 2026, 'ANT', 'Andrea Kimi Antonelli',   'Mercedes',         12, 'antonelli'),
  ('2026-lec', 2026, 'LEC', 'Charles Leclerc',         'Ferrari',          16, 'leclerc'),
  ('2026-ham', 2026, 'HAM', 'Lewis Hamilton',          'Ferrari',          44, 'hamilton'),
  ('2026-nor', 2026, 'NOR', 'Lando Norris',            'McLaren',           1, 'norris'),
  ('2026-pia', 2026, 'PIA', 'Oscar Piastri',           'McLaren',          81, 'piastri'),
  ('2026-ver', 2026, 'VER', 'Max Verstappen',          'Red Bull',          3, 'max_verstappen'),
  ('2026-had', 2026, 'HAD', 'Isack Hadjar',            'Red Bull',          6, 'hadjar'),
  ('2026-bea', 2026, 'BEA', 'Oliver Bearman',          'Haas F1 Team',     87, 'bearman'),
  ('2026-oco', 2026, 'OCO', 'Esteban Ocon',            'Haas F1 Team',     31, 'ocon'),
  ('2026-law', 2026, 'LAW', 'Liam Lawson',             'RB F1 Team',       30, 'lawson'),
  ('2026-lin', 2026, 'LIN', 'Arvid Lindblad',          'RB F1 Team',       41, 'arvid_lindblad'),
  ('2026-bor', 2026, 'BOR', 'Gabriel Bortoleto',       'Audi',              5, 'bortoleto'),
  ('2026-hul', 2026, 'HUL', 'Nico Hulkenberg',         'Audi',             27, 'hulkenberg'),
  ('2026-gas', 2026, 'GAS', 'Pierre Gasly',            'Alpine F1 Team',   10, 'gasly'),
  ('2026-col', 2026, 'COL', 'Franco Colapinto',        'Alpine F1 Team',   43, 'colapinto'),
  ('2026-alb', 2026, 'ALB', 'Alexander Albon',         'Williams',         23, 'albon'),
  ('2026-sai', 2026, 'SAI', 'Carlos Sainz',            'Williams',         55, 'sainz'),
  ('2026-per', 2026, 'PER', 'Sergio Perez',            'Cadillac F1 Team', 11, 'perez'),
  ('2026-bot', 2026, 'BOT', 'Valtteri Bottas',         'Cadillac F1 Team', 77, 'bottas'),
  ('2026-alo', 2026, 'ALO', 'Fernando Alonso',         'Aston Martin',     14, 'alonso'),
  ('2026-str', 2026, 'STR', 'Lance Stroll',            'Aston Martin',     18, 'stroll')
on conflict (id) do nothing;

insert into public.sessions (id, event_id, session_type)
select e.id || '-' || t.session_type, e.id, t.session_type
from public.events e
cross join lateral (
  select 'qualifying' as session_type
  union all select 'race'
  union all select 'sprint_qualifying' where e.has_sprint
  union all select 'sprint' where e.has_sprint
) as t
where e.id in ('australia-2026', 'china-2026')
on conflict (id) do nothing;

-- Real session start times from the results API schedule (UTC)
update public.sessions s
set start_utc = v.t::timestamptz
from (values
  ('australia-2026-qualifying',        '2026-03-07T05:00:00Z'),
  ('australia-2026-race',              '2026-03-08T04:00:00Z'),
  ('china-2026-sprint_qualifying',     '2026-03-13T07:30:00Z'),
  ('china-2026-sprint',                '2026-03-14T03:00:00Z'),
  ('china-2026-qualifying',            '2026-03-14T07:00:00Z'),
  ('china-2026-race',                  '2026-03-15T07:00:00Z')
) as v(id, t)
where s.id = v.id;

-- Three test predictions for the first group member, all exactly right
-- (expected scores: qualifying 62, race 73, sprint 32).
insert into public.predictions (user_id, session_id, picks)
select gm.user_id, v.session_id, v.picks
from (select user_id from public.group_members order by joined_at limit 1) as gm
cross join (values
  ('australia-2026-qualifying',
   jsonb_build_object(
     'q1_out',   to_jsonb(array['2026-ver', '2026-sai', '2026-per', '2026-str', '2026-alo', '2026-bot']),
     'q2_out',   to_jsonb(array['2026-hul', '2026-bea', '2026-oco', '2026-gas', '2026-alb', '2026-col']),
     'q3_order', to_jsonb(array['2026-rus', '2026-ant', '2026-had', '2026-lec', '2026-pia',
                                '2026-nor', '2026-ham', '2026-law', '2026-lin', '2026-bor']))),
  ('australia-2026-race',
   jsonb_build_object(
     'top8', to_jsonb(array['2026-rus', '2026-ant', '2026-lec', '2026-ham',
                            '2026-nor', '2026-ver', '2026-bea', '2026-lin']),
     'fastest_lap', '2026-ver',
     'any_dnf', true,
     'dnf_count', 4,
     'dnf_driver', '2026-had')),
  ('china-2026-sprint',
   jsonb_build_object(
     'top8', to_jsonb(array['2026-rus', '2026-lec', '2026-ham', '2026-nor',
                            '2026-ant', '2026-pia', '2026-law', '2026-bea'])))
) as v(session_id, picks)
on conflict (user_id, session_id) do nothing;
