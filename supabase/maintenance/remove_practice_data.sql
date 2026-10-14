-- Removes ALL practice data (deleting the event also removes its sessions and predictions).
delete from public.events  where id = 'practice-event';
delete from public.drivers where season = 9999;
