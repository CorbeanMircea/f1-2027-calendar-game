-- ROLLBACK for 035_notifications_read.sql: removes the function. Notifications and their read marks are kept.
-- Roll back the site files (predict.html, notices.js, notices.css) first.
begin;
drop function public.mark_notifications_read(uuid[]);
commit;
