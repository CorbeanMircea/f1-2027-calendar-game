-- 036: Push delivery of change notifications (Milestone M5b, database part).
--
-- Players who turned reminders on (push_subscriptions, Account page) also receive a push message when an admin registers or
-- changes a driver substitution or a grid penalty for a session they saved a prediction for. It is the same in-app notice
-- (player_notifications) delivered to their devices. Informational only: nothing here touches predictions, deadlines,
-- locking, scoring or season data.
--
--   push_notice_log   one row per (device, notification) already pushed, so a notice is never pushed twice to a device
--   due_push_notices  (service role only) the unread notices created in the last 3 hours that a device has not received yet
--
-- ROLLBACK: supabase/maintenance/rollback_036_push_notices.sql
-- Run the whole file once in the Supabase SQL Editor (one transaction).

begin;

create table public.push_notice_log (
  endpoint         text        not null,
  notification_id  uuid        not null references public.player_notifications (id) on delete cascade,
  sent_at          timestamptz not null default now(),
  primary key (endpoint, notification_id)
);

alter table public.push_notice_log enable row level security;
revoke all on public.push_notice_log from anon, authenticated;

create function public.due_push_notices(p_now timestamptz default now(), p_max_age interval default interval '3 hours')
returns table (
  notification_id uuid,
  endpoint        text,
  p256dh          text,
  auth            text,
  user_id         uuid,
  kind            text,
  payload         jsonb,
  created_at      timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select n.id, sub.endpoint, sub.p256dh, sub.auth, n.user_id, n.kind, n.payload, n.created_at
  from public.player_notifications n
  join public.push_subscriptions sub on sub.user_id = n.user_id
  where n.read_at is null
    and n.created_at > p_now - p_max_age
    and not exists (
      select 1 from public.push_notice_log g
      where g.endpoint = sub.endpoint and g.notification_id = n.id)
  order by n.created_at;
$$;

revoke all on function public.due_push_notices(timestamptz, interval) from public, anon, authenticated;
grant execute on function public.due_push_notices(timestamptz, interval) to service_role;

do $$
declare
  v_bad text := '';
  r     record;
begin
  for r in
    select p.oid::regprocedure::text as fn
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname = 'due_push_notices'
      and (has_function_privilege('anon', p.oid, 'EXECUTE')
           or has_function_privilege('authenticated', p.oid, 'EXECUTE')
           or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                      where a.grantee = 0 and a.privilege_type = 'EXECUTE'))
  loop
    v_bad := v_bad || r.fn || '; ';
  end loop;
  if v_bad <> '' then
    raise exception 'Unexpected EXECUTE rights (anon, authenticated or PUBLIC) on: %', v_bad;
  end if;
end;
$$;

commit;
