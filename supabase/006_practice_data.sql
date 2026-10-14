-- 006: PRACTICE data so the prediction form can be tried before the season.
-- Season 9999 is never shown by the Next Race card.
-- REMOVE before the real season with supabase/maintenance/remove_practice_data.sql

insert into public.events
  (id, season, round, name, circuit, locality, country, start_date, end_date, has_sprint, status)
values
  ('practice-event', 9999, 1, 'Practice Grand Prix (test)', 'Test Circuit', 'Testville', 'Nowhere',
   current_date + 7, current_date + 9, true, 'scheduled')
on conflict (id) do nothing;

insert into public.drivers (id, season, code, full_name, team_name) values
  ('practice-a', 9999, 'PRA', 'Practice Driver A', 'Practice Team 1'),
  ('practice-b', 9999, 'PRB', 'Practice Driver B', 'Practice Team 1'),
  ('practice-c', 9999, 'PRC', 'Practice Driver C', 'Practice Team 2'),
  ('practice-d', 9999, 'PRD', 'Practice Driver D', 'Practice Team 2'),
  ('practice-e', 9999, 'PRE', 'Practice Driver E', 'Practice Team 3'),
  ('practice-f', 9999, 'PRF', 'Practice Driver F', 'Practice Team 3'),
  ('practice-g', 9999, 'PRG', 'Practice Driver G', 'Practice Team 4'),
  ('practice-h', 9999, 'PRH', 'Practice Driver H', 'Practice Team 4')
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
where e.id = 'practice-event'
on conflict (id) do nothing;

update public.sessions set start_utc = now() + interval '7 days'
  where id = 'practice-event-qualifying';
update public.sessions set start_utc = now() + interval '6 days'
  where id = 'practice-event-sprint_qualifying';
