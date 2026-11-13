-- ROLLBACK for 036_push_notices.sql: removes the function and the push log. In-app notifications are untouched.
-- Redeploy the previous send-reminders function first.
begin;
drop function public.due_push_notices(timestamptz, interval);
drop table public.push_notice_log;
commit;
