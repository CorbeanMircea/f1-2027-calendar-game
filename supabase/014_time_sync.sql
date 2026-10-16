-- 014: New log actions for the session-time sync, plus one more real 2026 test event.

alter table public.import_log drop constraint if exists import_log_action_check;
alter table public.import_log add constraint import_log_action_check
  check (action in ('created_pending', 'unchanged', 'skipped', 'error', 'time_set', 'time_updated'));

-- TEST DATA: the real Brazilian Grand Prix 2026 (still in the future). Session times start empty.
-- Remove with supabase/maintenance/remove_test_season_2026.sql
insert into public.events
  (id, season, round, name, circuit, locality, country, start_date, end_date, has_sprint, status)
values
  ('brazil-2026', 2026, 20, 'Brazilian Grand Prix (2026 test data)', 'Autodromo Jose Carlos Pace',
   'Sao Paulo', 'Brazil', '2026-11-06', '2026-11-08', false, 'scheduled')
on conflict (id) do nothing;

insert into public.sessions (id, event_id, session_type) values
  ('brazil-2026-qualifying', 'brazil-2026', 'qualifying'),
  ('brazil-2026-race',       'brazil-2026', 'race')
on conflict (id) do nothing;