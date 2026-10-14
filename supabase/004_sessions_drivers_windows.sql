-- 004: Sessions, drivers, and prediction windows.
-- Start times are NULL until confirmed. NULL means predictions stay closed.

-- Tables ---------------------------------------------------------------

create table public.sessions (
  id            text primary key,   -- for example 'bahrain-2027-race'
  event_id      text not null references public.events (id) on delete cascade,
  session_type  text not null
                check (session_type in ('sprint_qualifying', 'sprint', 'qualifying', 'race')),
  start_utc     timestamptz,        -- NULL = not confirmed
  created_at    timestamptz not null default now(),
  unique (event_id, session_type)
);
create index sessions_event_idx on public.sessions (event_id);

create table public.drivers (
  id          text primary key,     -- for example '2027-ver'
  season      integer not null,
  code        text not null check (code ~ '^[A-Z]{3}$'),
  full_name   text not null,
  team_name   text not null,
  car_number  integer check (car_number between 1 and 99),
  external_id text unique,          -- id used by the results API, filled in later
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (season, code)
);

-- Row Level Security and privileges: public read-only --------------------

alter table public.sessions enable row level security;
alter table public.drivers  enable row level security;

create policy "sessions are readable by everyone"
  on public.sessions for select to anon, authenticated using (true);

create policy "drivers are readable by everyone"
  on public.drivers for select to anon, authenticated using (true);

revoke all on public.sessions, public.drivers from anon, authenticated;
grant select on public.sessions, public.drivers to anon, authenticated;

-- Session skeleton: 2 sessions per normal weekend, 4 per Sprint weekend ----
-- (24 events: 14 normal x 2 + 10 sprint x 4 = 68 rows)

insert into public.sessions (id, event_id, session_type)
select e.id || '-' || t.session_type, e.id, t.session_type
from public.events e
cross join lateral (
  select 'qualifying' as session_type
  union all select 'race'
  union all select 'sprint_qualifying' where e.has_sprint
  union all select 'sprint' where e.has_sprint
) as t
on conflict (id) do nothing;

-- Prediction windows -------------------------------------------------------
-- race   predictions lock when qualifying starts
-- sprint predictions lock when sprint qualifying starts
-- A missing start time means the window is closed.

create view public.prediction_windows
with (security_invoker = true) as
select
  s.id           as session_id,
  s.event_id     as event_id,
  s.session_type as target_type,
  l.id           as lock_session_id,
  l.start_utc    as lock_at,
  (l.start_utc is not null and now() < l.start_utc) as is_open
from public.sessions s
join public.sessions l
  on l.event_id = s.event_id
 and l.session_type = case s.session_type
                        when 'race'   then 'qualifying'
                        when 'sprint' then 'sprint_qualifying'
                      end
where s.session_type in ('race', 'sprint');

revoke all on public.prediction_windows from anon, authenticated;
grant select on public.prediction_windows to anon, authenticated;
