-- Removes the rehearsal weekend and the 2026 driver list
-- (deleting the event also removes its sessions, predictions, results and scores).
delete from public.import_log where event_id = 'united-states-2026';
delete from public.events     where id = 'united-states-2026';
delete from public.drivers    where season = 2026;
