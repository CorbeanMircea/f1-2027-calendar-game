-- Removes the 2026 test data (deleting the events also removes their sessions,
-- predictions, results and scores).
delete from public.import_log where event_id in ('australia-2026', 'china-2026');
delete from public.events     where id in ('australia-2026', 'china-2026');
delete from public.drivers    where season = 2026;
