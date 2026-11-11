-- 031: Driver substitutions, part A (database only). Milestone M2a.
--
-- WHAT THIS DOES
--   0. Corrects session_lineup_state() from migration 030 (see below).
--   1. Adds batch_id to driver_substitution_sessions (the table is empty).
--   2. Creates player_notifications (in-app, informational) and the internal helper lo_notify_change().
--   3. Adds three admin-only functions: admin_preview_substitution, admin_register_substitution, admin_revert_substitution.
--
-- WHAT IT DOES NOT DO
--   * No substitution, driver or notification rows are created by this file.
--   * Predictions, results, scores, deadlines, locking, season picks, bonus points, XP and achievements are never written.
--   * Grid penalties (M4), the prediction form (M3), the notification screen (M5) and admin corrections (M6) are not part of it.
--
-- CORRECTION TO 030 (found while designing the revert)
--   After a substitution A -> B is reverted, B is no longer in the lineup but a player may have saved picks with B.
--   030 only treated the OUTGOING driver of an effective substitution as "withdrawn". Without this fix, such a player
--   could not re-save his prediction after a revert. The replacement of a reverted substitution is now withdrawn too, and
--   maps back to the outgoing driver (chains included). Nothing changes while no substitution exists.
--
-- ROLLBACK: supabase/maintenance/rollback_031_substitutions_database.sql
-- Run the whole file once in the Supabase SQL Editor (one transaction).

begin;

-- ---------------------------------------------------------------------------
-- 0. session_lineup_state, corrected (same signature, same permissions)
-- ---------------------------------------------------------------------------
create or replace function public.session_lineup_state(p_session_id text)
returns table (o_use boolean, o_lineup text[], o_stand_ins jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_season    integer;
  v_event     text;
  v_line      text[];
  v_succ      jsonb := '{}'::jsonb;
  v_cand      text[] := '{}'::text[];
  v_map       jsonb := '{}'::jsonb;
  v_has       boolean := false;
  v_inactive  boolean;
  r           record;
  w           text;
  cur         text;
  i           integer;
begin
  select e.season, e.id into v_season, v_event
  from public.sessions s
  join public.events e on e.id = s.event_id
  where s.id = p_session_id;

  if v_season is null then
    return query select false, '{}'::text[], '{}'::jsonb;
    return;
  end if;

  v_line := coalesce(
    array(select d.id from public.drivers d where d.season = v_season and d.is_active order by d.code),
    '{}'::text[]);

  select exists (select 1 from public.drivers d where d.season = v_season and not d.is_active)
    into v_inactive;

  -- Pass 1: substitutions whose latest action for this session is 'revert'.
  -- The replacement is withdrawn again and maps back to the outgoing driver.
  for r in
    select ds.out_driver_id as out_id, ds.in_driver_id as in_id
    from public.driver_substitutions ds
    join lateral (
      select x.action
      from public.driver_substitution_sessions x
      where x.substitution_id = ds.id and x.session_id = p_session_id
      order by x.seq desc
      limit 1
    ) l on true
    where ds.event_id = v_event and l.action = 'revert'
    order by ds.registered_at, ds.id
  loop
    v_has := true;
    v_succ := v_succ || jsonb_build_object(r.in_id, r.out_id);
    v_cand := v_cand || r.in_id;
  end loop;

  -- Pass 2: substitutions whose latest action for this session is 'apply', in registration order.
  for r in
    select ds.out_driver_id as out_id, ds.in_driver_id as in_id
    from public.driver_substitutions ds
    join lateral (
      select x.action
      from public.driver_substitution_sessions x
      where x.substitution_id = ds.id and x.session_id = p_session_id
      order by x.seq desc
      limit 1
    ) l on true
    where ds.event_id = v_event and l.action = 'apply'
    order by ds.registered_at, ds.id
  loop
    v_has := true;
    v_line := array_remove(v_line, r.out_id);
    if not (r.in_id = any (v_line)) then
      v_line := v_line || r.in_id;
    end if;
    v_succ := v_succ || jsonb_build_object(r.out_id, r.in_id);
    v_cand := v_cand || r.out_id;
  end loop;

  -- Resolve every withdrawn driver to the lineup driver who finally took his place (chains A -> B -> C).
  foreach w in array v_cand loop
    if w = any (v_line) then
      continue;
    end if;
    cur := w;
    i := 0;
    while not (cur = any (v_line)) and (v_succ ? cur) and i < 50 loop
      cur := v_succ ->> cur;
      i := i + 1;
    end loop;
    if cur = any (v_line) then
      v_map := v_map || jsonb_build_object(w, cur);
    end if;
  end loop;

  return query select (v_has or v_inactive), v_line, v_map;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Batch id: all rows written by one admin action share it (also the notification source)
-- ---------------------------------------------------------------------------
alter table public.driver_substitution_sessions add column batch_id uuid not null;

-- ---------------------------------------------------------------------------
-- 2. In-app notifications (informational only)
-- ---------------------------------------------------------------------------
create table public.player_notifications (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users (id) on delete cascade,
  kind        text        not null check (kind in (
                'substitution', 'substitution_reverted',
                'grid_penalty', 'grid_penalty_revoked', 'grid_penalty_updated',
                'prediction_corrected')),
  source_id   uuid        not null,          -- the batch (or later penalty / correction) the notification is about
  event_id    text,                          -- no foreign key: a notification must outlive calendar maintenance
  payload     jsonb       not null,
  created_at  timestamptz not null default now(),
  read_at     timestamptz,
  constraint player_notifications_once unique (user_id, kind, source_id)
);

create index player_notifications_user_idx on public.player_notifications (user_id, created_at desc);

alter table public.player_notifications enable row level security;

create policy "players read their own notifications"
  on public.player_notifications for select to authenticated
  using (user_id = auth.uid());

revoke all on public.player_notifications from anon, authenticated;
grant select on public.player_notifications to authenticated;

-- Internal: one notification per player (never more) for everyone who has a saved prediction in any of the given sessions.
-- The notification lists only the sessions in which THAT player saved a prediction. Re-running it for the same
-- (kind, source) creates nothing new.
create function public.lo_notify_change(
  p_kind        text,
  p_source      uuid,
  p_event_id    text,
  p_session_ids text[],
  p_payload     jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into public.player_notifications (user_id, kind, source_id, event_id, payload)
  select g.user_id, p_kind, p_source, p_event_id,
         p_payload || jsonb_build_object('your_sessions', g.session_types)
  from (
    select pr.user_id,
           jsonb_agg(s.session_type order by case s.session_type
                       when 'sprint_qualifying' then 1 when 'sprint' then 2 when 'qualifying' then 3 else 4 end) as session_types
    from public.predictions pr
    join public.sessions s on s.id = pr.session_id
    where pr.session_id = any (p_session_ids)
    group by pr.user_id
  ) g
  on conflict (user_id, kind, source_id) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Admin functions
-- ---------------------------------------------------------------------------

-- Review step: the sessions of the event, whether each has taken place, whether the substitution can apply to it,
-- and how many players saved a prediction. Read-only. p_in_driver NULL = the replacement will be a new driver.
create function public.admin_preview_substitution(p_event_id text, p_out_driver text, p_in_driver text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ev   record;
  v_out  record;
  v_in   record;
begin
  if not public.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;

  select e.id, e.name, e.season, e.status into v_ev from public.events e where e.id = p_event_id;
  if v_ev.id is null then
    raise exception 'Unknown event';
  end if;

  select d.id, d.code, d.full_name, d.team_name, d.car_number into v_out
  from public.drivers d where d.id = p_out_driver and d.season = v_ev.season;
  if v_out.id is null then
    raise exception 'Unknown outgoing driver for this season';
  end if;

  if p_in_driver is not null then
    select d.id, d.code, d.full_name, d.team_name, d.car_number into v_in
    from public.drivers d where d.id = p_in_driver and d.season = v_ev.season;
    if v_in.id is null then
      raise exception 'Unknown replacement driver for this season';
    end if;
  end if;

  return jsonb_build_object(
    'event', jsonb_build_object('id', v_ev.id, 'name', v_ev.name, 'season', v_ev.season, 'status', v_ev.status),
    'out', jsonb_build_object('id', v_out.id, 'code', v_out.code, 'name', v_out.full_name, 'team', v_out.team_name, 'number', v_out.car_number),
    'in', case when v_in.id is null then null
               else jsonb_build_object('id', v_in.id, 'code', v_in.code, 'name', v_in.full_name, 'team', v_in.team_name, 'number', v_in.car_number) end,
    'sessions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'session_id', t.id,
               'session_type', t.session_type,
               'start_utc', t.start_utc,
               'timing', t.timing,
               'out_in_lineup', t.out_in,
               'in_in_lineup', t.in_in,
               'predictions', t.preds,
               'eligible', (t.timing <> 'taken_place' and t.out_in and not t.in_in),
               'default_selected', (t.timing = 'remaining' and t.out_in and not t.in_in),
               'needs_confirmation', (t.timing = 'unknown' and t.out_in and not t.in_in),
               'reason', case
                           when t.timing = 'taken_place' then 'Already taken place'
                           when not t.out_in then 'The outgoing driver is not in the lineup for this session'
                           when t.in_in then 'The replacement is already in the lineup for this session'
                           when t.timing = 'unknown' then 'Start time unknown: tick it to include it'
                           else null end
             ) order by t.sort)
      from (
        select s.id, s.session_type, s.start_utc,
               case s.session_type when 'sprint_qualifying' then 1 when 'sprint' then 2 when 'qualifying' then 3 else 4 end as sort,
               case
                 when exists (select 1 from public.results r where r.session_id = s.id and r.status in ('pending', 'approved'))
                      or (s.start_utc is not null and s.start_utc <= now()) then 'taken_place'
                 when s.start_utc is null then 'unknown'
                 else 'remaining'
               end as timing,
               (p_out_driver = any (ls.o_lineup)) as out_in,
               (p_in_driver is not null and p_in_driver = any (ls.o_lineup)) as in_in,
               (select count(*) from public.predictions pr where pr.session_id = s.id) as preds
        from public.sessions s, lateral public.session_lineup_state(s.id) as ls
        where s.event_id = p_event_id
      ) t
    ), '[]'::jsonb)
  );
end;
$$;

-- Confirm step. Either an existing replacement (p_in_driver) or a new one (p_new_driver:
-- {code, full_name, team_name, car_number, external_id}); the new driver row is created INACTIVE, so season
-- eligibility is unchanged. A session whose start time is unknown is included only if listed in p_confirm_unknown.
create function public.admin_register_substitution(
  p_event_id        text,
  p_out_driver      text,
  p_in_driver       text,
  p_new_driver      jsonb,
  p_session_ids     text[],
  p_confirm_unknown text[] default '{}'::text[],
  p_note            text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ev        record;
  v_out       record;
  v_in        record;
  v_sess      record;
  v_in_id     text;
  v_new_id    text;
  v_code      text;
  v_ext       text;
  v_num       integer;
  v_sub       uuid;
  v_batch     uuid := gen_random_uuid();
  v_notified  integer;
begin
  if not public.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;

  -- Serialise registrations for this event.
  select e.id, e.name, e.season, e.status into v_ev from public.events e where e.id = p_event_id for update;
  if v_ev.id is null then
    raise exception 'Unknown event';
  end if;
  if v_ev.status <> 'scheduled' then
    raise exception 'Substitutions can only be registered for a scheduled event';
  end if;

  select d.id, d.code, d.full_name, d.team_name, d.car_number into v_out
  from public.drivers d where d.id = p_out_driver and d.season = v_ev.season;
  if v_out.id is null then
    raise exception 'Unknown outgoing driver for this season';
  end if;

  if (p_in_driver is null) = (p_new_driver is null) then
    raise exception 'Choose either an existing replacement driver or enter a new one';
  end if;

  if p_session_ids is null or cardinality(p_session_ids) = 0 then
    raise exception 'Select at least one session';
  end if;
  if (select count(distinct x) from unnest(p_session_ids) as x) <> cardinality(p_session_ids) then
    raise exception 'Each session can be selected only once';
  end if;
  if (select count(*) from public.sessions s where s.event_id = p_event_id and s.id = any (p_session_ids))
       <> cardinality(p_session_ids) then
    raise exception 'A selected session does not belong to this event';
  end if;

  -- The replacement.
  if p_in_driver is not null then
    select d.id, d.code, d.full_name, d.team_name, d.car_number into v_in
    from public.drivers d where d.id = p_in_driver and d.season = v_ev.season;
    if v_in.id is null then
      raise exception 'Unknown replacement driver for this season';
    end if;
    if v_in.id = v_out.id then
      raise exception 'The replacement must be a different driver';
    end if;
  else
    v_code := upper(btrim(coalesce(p_new_driver ->> 'code', '')));
    v_ext  := btrim(coalesce(p_new_driver ->> 'external_id', ''));
    if v_code !~ '^[A-Z]{3}$' then
      raise exception 'The driver code must be three letters';
    end if;
    if btrim(coalesce(p_new_driver ->> 'full_name', '')) = '' then
      raise exception 'Enter the driver''s name';
    end if;
    if btrim(coalesce(p_new_driver ->> 'team_name', '')) = '' then
      raise exception 'Enter the driver''s team';
    end if;
    if v_ext = '' then
      raise exception 'The results-API driver id is required, otherwise results cannot be imported';
    end if;
    if btrim(coalesce(p_new_driver ->> 'car_number', '')) <> '' then
      if btrim(p_new_driver ->> 'car_number') !~ '^[0-9]{1,2}$' or btrim(p_new_driver ->> 'car_number')::integer < 1 then
        raise exception 'The car number must be between 1 and 99';
      end if;
      v_num := btrim(p_new_driver ->> 'car_number')::integer;
    end if;
    if exists (select 1 from public.drivers d where d.season = v_ev.season and d.code = v_code) then
      raise exception 'A driver with code % already exists for this season: choose that driver instead', v_code;
    end if;
    if exists (select 1 from public.drivers d where d.season = v_ev.season and d.external_id = v_ext) then
      raise exception 'A driver with the API id % already exists for this season: choose that driver instead', v_ext;
    end if;
    v_new_id := v_ev.season::text || '-' || lower(v_code);
    if exists (select 1 from public.drivers d where d.id = v_new_id) then
      raise exception 'A driver with id % already exists', v_new_id;
    end if;
  end if;

  -- Every selected session: not taken place, time known or explicitly confirmed, outgoing driver in the lineup,
  -- replacement not in it.
  for v_sess in
    select s.id, s.session_type, s.start_utc, ls.o_lineup,
           (exists (select 1 from public.results r where r.session_id = s.id and r.status in ('pending', 'approved'))
            or (s.start_utc is not null and s.start_utc <= now())) as taken
    from public.sessions s, lateral public.session_lineup_state(s.id) as ls
    where s.event_id = p_event_id and s.id = any (p_session_ids)
    order by s.id
  loop
    if v_sess.taken then
      raise exception 'The % session has already taken place and cannot be changed', v_sess.session_type;
    end if;
    if v_sess.start_utc is null and not (v_sess.id = any (coalesce(p_confirm_unknown, '{}'::text[]))) then
      raise exception 'The % session has no confirmed start time: confirm it explicitly to include it', v_sess.session_type;
    end if;
    if not (p_out_driver = any (v_sess.o_lineup)) then
      raise exception 'The outgoing driver is not in the lineup for the % session', v_sess.session_type;
    end if;
    if p_in_driver is not null and p_in_driver = any (v_sess.o_lineup) then
      raise exception 'The replacement is already in the lineup for the % session', v_sess.session_type;
    end if;
  end loop;

  -- Everything is valid: write.
  if p_in_driver is null then
    insert into public.drivers (id, season, code, full_name, team_name, car_number, external_id, is_active)
    values (v_new_id, v_ev.season, v_code, btrim(p_new_driver ->> 'full_name'), btrim(p_new_driver ->> 'team_name'),
            v_num, v_ext, false);
    v_in_id := v_new_id;
  else
    v_in_id := p_in_driver;
  end if;

  select d.id, d.code, d.full_name, d.team_name, d.car_number into v_in
  from public.drivers d where d.id = v_in_id;

  insert into public.driver_substitutions (event_id, out_driver_id, in_driver_id, out_info, in_info, note, registered_by)
  values (
    p_event_id, p_out_driver, v_in_id,
    jsonb_build_object('code', v_out.code, 'name', v_out.full_name, 'team', v_out.team_name, 'number', v_out.car_number),
    jsonb_build_object('code', v_in.code, 'name', v_in.full_name, 'team', v_in.team_name, 'number', v_in.car_number),
    nullif(btrim(coalesce(p_note, '')), ''),
    auth.uid())
  returning id into v_sub;

  insert into public.driver_substitution_sessions (substitution_id, session_id, action, reason, acted_by, batch_id)
  select v_sub, s.id, 'apply',
         case when s.start_utc is null then 'Start time unknown; included after explicit admin confirmation' end,
         auth.uid(), v_batch
  from public.sessions s
  where s.id = any (p_session_ids);

  v_notified := public.lo_notify_change(
    'substitution', v_batch, p_event_id, p_session_ids,
    jsonb_build_object(
      'grand_prix', v_ev.name,
      'event_id', p_event_id,
      'out', jsonb_build_object('id', v_out.id, 'code', v_out.code, 'name', v_out.full_name),
      'in', jsonb_build_object('id', v_in.id, 'code', v_in.code, 'name', v_in.full_name),
      'sessions', (select jsonb_agg(s.session_type order by case s.session_type
                     when 'sprint_qualifying' then 1 when 'sprint' then 2 when 'qualifying' then 3 else 4 end)
                   from public.sessions s where s.id = any (p_session_ids)),
      'registered_at', now()));

  return jsonb_build_object(
    'substitution_id', v_sub,
    'batch_id', v_batch,
    'new_driver_id', v_new_id,
    'sessions', to_jsonb(p_session_ids),
    'notified', v_notified);
end;
$$;

-- Revert: only sessions that have not taken place, never a session while a LATER substitution still applies to it,
-- never anything else. The revert is appended as new rows; nothing is updated or deleted.
create function public.admin_revert_substitution(
  p_substitution_id uuid,
  p_reason          text,
  p_session_ids     text[] default null,
  p_confirm_unknown text[] default '{}'::text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub       record;
  v_ev        record;
  r           record;
  v_batch     uuid := gen_random_uuid();
  v_done      text[] := '{}'::text[];
  v_skipped   jsonb := '[]'::jsonb;
  v_notified  integer;
begin
  if not public.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'A reason is required';
  end if;

  select ds.id, ds.event_id, ds.out_driver_id, ds.in_driver_id, ds.out_info, ds.in_info, ds.registered_at
    into v_sub
  from public.driver_substitutions ds where ds.id = p_substitution_id;
  if v_sub.id is null then
    raise exception 'Unknown substitution';
  end if;

  select e.id, e.name, e.status into v_ev from public.events e where e.id = v_sub.event_id for update;
  if v_ev.status <> 'scheduled' then
    raise exception 'Substitutions can only be reverted for a scheduled event';
  end if;

  for r in
    select s.id as session_id, s.session_type, s.start_utc,
           (exists (select 1 from public.results rs where rs.session_id = s.id and rs.status in ('pending', 'approved'))
            or (s.start_utc is not null and s.start_utc <= now())) as taken
    from public.sessions s
    join lateral (
      select x.action
      from public.driver_substitution_sessions x
      where x.substitution_id = p_substitution_id and x.session_id = s.id
      order by x.seq desc
      limit 1
    ) l on true
    where l.action = 'apply'
      and (p_session_ids is null or s.id = any (p_session_ids))
    order by s.id
  loop
    if r.taken then
      v_skipped := v_skipped || jsonb_build_object('session_id', r.session_id, 'why', 'Already taken place: left unchanged');
      continue;
    end if;
    if r.start_utc is null and not (r.session_id = any (coalesce(p_confirm_unknown, '{}'::text[]))) then
      raise exception 'The % session has no confirmed start time: confirm it explicitly to revert it', r.session_type;
    end if;
    -- Last in, first out: a later substitution that still applies to this session must be reverted first.
    if exists (
      select 1
      from public.driver_substitutions d2
      join lateral (
        select x2.action
        from public.driver_substitution_sessions x2
        where x2.substitution_id = d2.id and x2.session_id = r.session_id
        order by x2.seq desc
        limit 1
      ) l2 on true
      where d2.event_id = v_sub.event_id
        and l2.action = 'apply'
        and (d2.registered_at, d2.id) > (v_sub.registered_at, v_sub.id)
    ) then
      raise exception 'A later substitution still applies to the % session: revert that one first', r.session_type;
    end if;
    v_done := v_done || r.session_id;
  end loop;

  if cardinality(v_done) = 0 then
    raise exception 'Nothing to revert: this substitution no longer applies to any session that has not taken place';
  end if;

  insert into public.driver_substitution_sessions (substitution_id, session_id, action, reason, acted_by, batch_id)
  select p_substitution_id, x, 'revert', btrim(p_reason), auth.uid(), v_batch
  from unnest(v_done) as x;

  v_notified := public.lo_notify_change(
    'substitution_reverted', v_batch, v_sub.event_id, v_done,
    jsonb_build_object(
      'grand_prix', v_ev.name,
      'event_id', v_sub.event_id,
      'out', jsonb_build_object('id', v_sub.out_driver_id) || v_sub.out_info,
      'in', jsonb_build_object('id', v_sub.in_driver_id) || v_sub.in_info,
      'sessions', (select jsonb_agg(s.session_type order by case s.session_type
                     when 'sprint_qualifying' then 1 when 'sprint' then 2 when 'qualifying' then 3 else 4 end)
                   from public.sessions s where s.id = any (v_done)),
      'reason', btrim(p_reason),
      'registered_at', now()));

  return jsonb_build_object(
    'batch_id', v_batch,
    'reverted_sessions', to_jsonb(v_done),
    'skipped', v_skipped,
    'notified', v_notified);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Permissions (explicit)
-- ---------------------------------------------------------------------------
revoke all on function public.session_lineup_state(text) from public, anon, authenticated;
grant execute on function public.session_lineup_state(text) to service_role;

revoke all on function public.lo_notify_change(text, uuid, text, text[], jsonb) from public, anon, authenticated;
grant execute on function public.lo_notify_change(text, uuid, text, text[], jsonb) to service_role;

revoke all on function public.admin_preview_substitution(text, text, text)                              from public, anon;
revoke all on function public.admin_register_substitution(text, text, text, jsonb, text[], text[], text) from public, anon;
revoke all on function public.admin_revert_substitution(uuid, text, text[], text[])                      from public, anon;
grant execute on function public.admin_preview_substitution(text, text, text)                              to authenticated;
grant execute on function public.admin_register_substitution(text, text, text, jsonb, text[], text[], text) to authenticated;
grant execute on function public.admin_revert_substitution(uuid, text, text[], text[])                      to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Safety check: the whole migration is rolled back if any function has unexpected EXECUTE rights
-- ---------------------------------------------------------------------------
do $$
declare
  r      record;
  v_bad  text := '';
begin
  for r in
    select p.oid::regprocedure::text as fn
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('session_lineup_state', 'session_lineup_external', 'picks_driver_ids', 'check_pick_drivers',
                        'validate_session_data', 'check_drivers', 'picks_array', 'jarr', 'calc_points',
                        'recalculate_scores', 'enter_result', 'prediction_dnf_ok', 'result_dnf_ok', 'lo_block_change',
                        'lo_notify_change')
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

  for r in
    select p.oid::regprocedure::text as fn
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('session_lineup', 'submit_prediction', 'admin_enter_manual_result', 'admin_save_result_edit',
                        'admin_preview_substitution', 'admin_register_substitution', 'admin_revert_substitution')
      and (not has_function_privilege('authenticated', p.oid, 'EXECUTE')
           or has_function_privilege('anon', p.oid, 'EXECUTE')
           or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                      where a.grantee = 0 and a.privilege_type = 'EXECUTE'))
  loop
    v_bad := v_bad || r.fn || '; ';
  end loop;
  if v_bad <> '' then
    raise exception 'Unexpected function permissions on: %', v_bad;
  end if;
end;
$$;

commit;