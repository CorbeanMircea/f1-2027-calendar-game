-- 001: Security baseline + empty events table
-- Rule for this project: every table is locked by default.
-- Access is granted explicitly, table by table, together with an RLS policy.

-- 1) New tables and sequences created by the postgres role
--    are NOT automatically accessible to the public API roles.
alter default privileges in schema public
  revoke all on tables from anon, authenticated;
alter default privileges in schema public
  revoke all on sequences from anon, authenticated;

-- 2) Events table (one row per Grand Prix weekend).
--    id is a stable slug (for example 'bahrain-2027') that will be used in QR code URLs.
create table public.events (
  id          text primary key,
  season      integer not null,
  round       integer not null,
  name        text not null,
  circuit     text not null,
  locality    text not null,
  country     text not null,
  start_date  date not null,
  end_date    date not null,
  has_sprint  boolean not null default false,
  status      text not null default 'scheduled'
              check (status in ('scheduled', 'postponed', 'cancelled')),
  created_at  timestamptz not null default now(),
  unique (season, round),
  check (end_date >= start_date)
);

-- 3) Row Level Security: on, with exactly one policy (read-only for everyone).
alter table public.events enable row level security;

create policy "events are readable by everyone"
  on public.events
  for select
  to anon, authenticated
  using (true);

-- 4) Explicit privileges: start from nothing, then allow SELECT only.
--    There is no INSERT/UPDATE/DELETE privilege or policy, so the website cannot change events.
revoke all on public.events from anon, authenticated;
grant select on public.events to anon, authenticated;
