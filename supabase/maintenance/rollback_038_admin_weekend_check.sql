-- Removes the Admin weekend check function (migration 038). Nothing else depends on it except the Admin "Weekend check" tab,
-- which then shows "could not load". Safe to run more than once.
drop function if exists public.admin_weekend_check(text);
