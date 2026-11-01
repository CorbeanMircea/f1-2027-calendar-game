-- 021: Push reminders ("predictions lock soon and you have not picked").
-- Additive only: two new tables and four new functions. Nothing existing is changed.
--
-- To undo:
--   drop function if exists public.due_push_reminders(timestamptz);
--   drop function if exists public.save_push_subscription(text, text, text, text);
--   drop function if exists public.remove_push_subscription(text);
--   drop table if exists public.push_log;
--   drop table if exists public.push_subscriptions;

-- One row per device that turned reminders on ---------------------------------------------
create table if not exists public.push_subscriptions (
  endpoint    text primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now(),
  last_ok_at  timestamptz
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

-- Which reminder went to which device, so nobody gets the same one twice ------------------
create table if not exists public.push_log (
  endpoint    text not null,
  session_id  text not null,      -- the session whose start is the deadline
  kind        text not null check (kind in ('h3', 'h1')),
  sent_at     timestamptz not null default now(),
  primary key (endpoint, session_id, kind)
);

alter table public.push_subscriptions enable row level security;
alter table public.push_log enable row level security;

revoke all on public.push_subscriptions from anon, authenticated;
revoke all on public.push_log from anon, authenticated;
grant select on public.push_subscriptions to authenticated;

drop policy if exists push_subscriptions_select_own on public.push_subscriptions;
create policy push_subscriptions_select_own on public.push_subscriptions
  for select to authenticated using (user_id = auth.uid());

-- The website saves and removes a device through these two functions ----------------------
create or replace function public.save_push_subscription(
  p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  if not exists (select 1 from public.profiles where id = v_user) then
    raise exception 'Join the friends group before turning on reminders' using errcode = '22023';
  end if;
  if p_endpoint is null or p_endpoint !~ '^https://' or char_length(p_endpoint) > 1500
     or p_p256dh is null or char_length(p_p256dh) not between 20 and 200
     or p_auth is null or char_length(p_auth) not between 8 and 100 then
    raise exception 'Invalid reminder registration' using errcode = '22023';
  end if;

  insert into public.push_subscriptions (endpoint, user_id, p256dh, auth, user_agent)
  values (p_endpoint, v_user, p_p256dh, p_auth, left(p_user_agent, 200))
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
        user_agent = excluded.user_agent, last_ok_at = null;
end;
$$;

create or replace function public.remove_push_subscription(p_endpoint text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
end;
$$;

revoke all on function public.save_push_subscription(text, text, text, text) from public, anon;
revoke all on function public.remove_push_subscription(text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;
grant execute on function public.remove_push_subscription(text) to authenticated;

-- Who should be reminded right now? Used only by the reminder job (service role). ----------
-- A deadline is the start of Qualifying (covers Qualifying + Race) or of Sprint Qualifying
-- (covers Sprint Qualifying + Sprint), exactly like the real lock rule.
--   kind h3: the deadline is between 1 and 3 hours away
--   kind h1: the deadline is less than 1 hour away
-- A device is only listed when its owner has not yet predicted at least one covered session,
-- and has not already received this reminder.
create or replace function public.due_push_reminders(p_now timestamptz default now())
returns table (
  endpoint    text,
  p256dh      text,
  auth        text,
  user_id     uuid,
  lock_id     text,
  kind        text,
  event_name  text,
  lock_at     timestamptz,
  missing     text[]
)
language sql
stable
security definer
set search_path = ''
as $$
  with locks as (
    select s.id as lock_id, s.event_id, s.session_type as lock_type, s.start_utc as lock_at,
           case when s.start_utc <= p_now + interval '1 hour' then 'h1' else 'h3' end as kind
    from public.sessions s
    join public.events e on e.id = s.event_id and e.status <> 'cancelled'
    where s.session_type in ('qualifying', 'sprint_qualifying')
      and s.start_utc is not null
      and s.start_utc > p_now
      and s.start_utc <= p_now + interval '3 hours'
  ),
  covered as (
    select l.lock_id, c.id as session_id, c.session_type
    from locks l
    join public.sessions c on c.event_id = l.event_id
     and ((l.lock_type = 'qualifying' and c.session_type in ('qualifying', 'race'))
       or (l.lock_type = 'sprint_qualifying' and c.session_type in ('sprint_qualifying', 'sprint')))
  )
  select sub.endpoint, sub.p256dh, sub.auth, sub.user_id, l.lock_id, l.kind, e.name, l.lock_at,
         array_agg(c.session_type order by
           case c.session_type when 'sprint_qualifying' then 1 when 'sprint' then 2
                               when 'qualifying' then 3 else 4 end) as missing
  from locks l
  join public.events e on e.id = l.event_id
  join covered c on c.lock_id = l.lock_id
  cross join public.push_subscriptions sub
  where not exists (
          select 1 from public.predictions p
          where p.user_id = sub.user_id and p.session_id = c.session_id)
    and not exists (
          select 1 from public.push_log g
          where g.endpoint = sub.endpoint and g.session_id = l.lock_id and g.kind = l.kind)
  group by sub.endpoint, sub.p256dh, sub.auth, sub.user_id, l.lock_id, l.kind, e.name, l.lock_at;
$$;

revoke all on function public.due_push_reminders(timestamptz) from public, anon, authenticated;
grant execute on function public.due_push_reminders(timestamptz) to service_role;

notify pgrst, 'reload schema';
