-- 018: Rehearsal weekend: the REAL United States Grand Prix 2026 (round 18), used as "race 1"
-- to test the whole app with real data. Remove it after the weekend with
-- supabase/maintenance/remove_rehearsal_weekend.sql

insert into public.events
  (id, season, round, name, circuit, locality, country, start_date, end_date, has_sprint, status)
values
  ('united-states-2026', 2026, 18, 'United States Grand Prix', 'Circuit of the Americas',
   'Austin', 'United States', '2026-10-23', '2026-10-25', false, 'scheduled')
on conflict (id) do nothing;

insert into public.sessions (id, event_id, session_type) values
  ('united-states-2026-qualifying', 'united-states-2026', 'qualifying'),
  ('united-states-2026-race',       'united-states-2026', 'race')
on conflict (id) do nothing;
