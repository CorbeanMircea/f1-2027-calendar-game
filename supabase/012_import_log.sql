-- 012: Log of everything the importer does. Readable only by the service role / SQL Editor.
create table public.import_log (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  season        integer,
  round         integer,
  event_id      text,
  session_type  text,
  action        text not null
                check (action in ('created_pending', 'unchanged', 'skipped', 'error')),
  detail        text,
  result_id     uuid references public.results (id) on delete set null
);
create index import_log_created_idx on public.import_log (created_at desc);

alter table public.import_log enable row level security;

revoke all on public.import_log from anon, authenticated;
grant all on public.import_log to service_role;
