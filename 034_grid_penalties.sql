-- 034: Grid penalties (Milestone M4, database part).
--
-- A grid penalty is an INFORMATIONAL record: it changes a driver's starting position, not his qualifying result and not
-- the final classification. Nothing here writes to results, scores, predictions, deadlines, locking or season data.
--
-- WHAT THIS DOES
--   1. grid_penalties: append-only. A row is either a penalty or a revocation of an earlier penalty (never updated, never deleted).
--   2. admin_preview_grid_penalty, admin_register_grid_penalty, admin_revoke_grid_penalty (a revoke can carry a corrected
--      replacement). Players with a saved prediction for the session get one informational notification per change.
--   3. session_has_grid_penalty (service role only), used by the importer so a derived Sprint Qualifying is never built
--      from a penalty-affected sprint grid.
--   4. prediction_form_lineup now also returns the penalties in force for the session (for the Predictions page notice).
--
-- ROLLBACK: supabase/maintenance/rollback_034_grid_penalties.sql
-- Run the whole file once in the Supabase SQL Editor (one transaction).

begin;

create table public.grid_penalties (
  id                 uuid        primary key default gen_random_uuid(),
  entry_type         text        not null check (entry_type in ('penalty', 'revocation')),
  session_id         text        not null references public.sessions (id),
  driver_id          text        not null references public.drivers (id),
  penalty_type       text        check (penalty_type in ('places', 'back_of_grid', 'pit_lane')),
  places             integer,
  original_position  integer,                         -- where he qualified / started before the penalty, if known
  adjusted_position  integer,                         -- where he starts after the penalty, if known
  reason             text        not null,            -- the reason or the official information
  reference          text,                            -- optional source, for example a link
  revokes_id         uuid        references public.grid_penalties (id),
  registered_by      uuid,                            -- no foreign key: the audit identity must outlive the account
  registered_at      timestamptz not null default now(),
  constraint grid_penalties_shape check (
    (entry_type = 'penalty' and revokes_id is null and penalty_type is not null
       and ((penalty_type = 'places' and places is not null and places between 1 and 22)
            or (penalty_type in ('back_of_grid', 'pit_lane') and places is null)))
    or
    (entry_type = 'revocation' and revokes_id is not null and penalty_type is null and places is null
       and original_position is null and adjusted_position is null)),
  constraint grid_penalties_positions check (
    (original_position is null or original_position between 1 and 30)
    and (adjusted_position is null or adjusted_position between 1 and 30)),
  constraint grid_penalties_reason check (char_length(btrim(reason)) >= 3)
);

create unique index grid_penalties_one_revocation on public.grid_penalties (revokes_id) where revokes_id is not null;
create index grid_penalties_session_idx on public.grid_penalties (session_id, registered_at);

create trigger grid_penalties_append_only
  before update or delete on public.grid_penalties
  for each row execute function public.lo_block_change();

alter table public.grid_penalties enable row level security;

create policy "group members read grid penalties"
  on public.grid_penalties for select to authenticated
  using (exists (select 1 from public.group_members gm where gm.user_id = auth.uid()));

revoke all on public.grid_penalties from anon, authenticated;
grant select on public.grid_penalties to authenticated;

-- Importer helper (service role only): is a penalty still in force for this session?
create function public.session_has_grid_penalty(p_session_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.grid_penalties p
    where p.session_id = p_session_id
      and p.entry_type = 'penalty'
      and not exists (select 1 from public.grid_penalties r where r.revokes_id = p.id));
$$;

-- Review step: timing, saved predictions and the penalties already in force for the session. Read-only.
create function public.admin_preview_grid_penalty(p_session_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_s       record;
  v_timing  text;
  v_preds   integer;
  v_reason  text;
begin
  if not public.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;

  select s.id, s.session_type, s.start_utc, e.id as event_id, e.name as event_name, e.season, e.status
    into v_s
  from public.sessions s
  join public.events e on e.id = s.event_id
  where s.id = p_session_id;
  if v_s.id is null then
    raise exception 'Unknown session';
  end if;

  v_timing := case
    when exists (select 1 from public.results r where r.session_id = p_session_id and r.status in ('pending', 'approved'))
         or (v_s.start_utc is not null and v_s.start_utc <= now()) then 'taken_place'
    when v_s.start_utc is null then 'unknown'
    else 'remaining' end;
  select count(*) into v_preds from public.predictions pr where pr.session_id = p_session_id;

  v_reason := case
    when v_s.session_type not in ('sprint', 'race') then 'A grid penalty applies to a Sprint or a Race'
    when v_s.status <> 'scheduled' then 'The event is not scheduled'
    when v_timing = 'taken_place' then 'The session has already taken place'
    else null end;

  return jsonb_build_object(
    'event', jsonb_build_object('id', v_s.event_id, 'name', v_s.event_name, 'season', v_s.season, 'status', v_s.status),
    'session', jsonb_build_object('id', v_s.id, 'session_type', v_s.session_type, 'start_utc', v_s.start_utc, 'timing', v_timing),
    'predictions', v_preds,
    'eligible', v_reason is null,
    'needs_confirmation', (v_reason is null and v_timing = 'unknown'),
    'reason', v_reason,
    'penalties', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'driver', jsonb_build_object('id', d.id, 'code', d.code, 'name', d.full_name),
               'penalty_type', p.penalty_type, 'places', p.places,
               'original_position', p.original_position, 'adjusted_position', p.adjusted_position,
               'reason', p.reason, 'registered_at', p.registered_at) order by p.registered_at, p.id)
      from public.grid_penalties p
      join public.drivers d on d.id = p.driver_id
      where p.session_id = p_session_id and p.entry_type = 'penalty'
        and not exists (select 1 from public.grid_penalties r where r.revokes_id = p.id)), '[]'::jsonb));
end;
$$;

-- Confirm step.
create function public.admin_register_grid_penalty(
  p_session_id      text,
  p_driver          text,
  p_penalty_type    text,
  p_places          integer,
  p_original        integer,
  p_adjusted        integer,
  p_reason          text,
  p_reference       text default null,
  p_confirm_unknown boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s        record;
  v_d        record;
  v_lineup   text[];
  v_id       uuid;
  v_notified integer;
begin
  if not public.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;

  select s.id, s.session_type, s.start_utc, s.event_id into v_s from public.sessions s where s.id = p_session_id;
  if v_s.id is null then
    raise exception 'Unknown session';
  end if;
  if v_s.session_type not in ('sprint', 'race') then
    raise exception 'A grid penalty applies to a Sprint or a Race';
  end if;

  declare
    v_ev record;
  begin
    select e.id, e.name, e.status into v_ev from public.events e where e.id = v_s.event_id for update;
    if v_ev.status <> 'scheduled' then
      raise exception 'Grid penalties can only be registered for a scheduled event';
    end if;

    if exists (select 1 from public.results r where r.session_id = p_session_id and r.status in ('pending', 'approved'))
       or (v_s.start_utc is not null and v_s.start_utc <= now()) then
      raise exception 'The % session has already taken place', v_s.session_type;
    end if;
    if v_s.start_utc is null and not coalesce(p_confirm_unknown, false) then
      raise exception 'The % session has no confirmed start time: confirm it explicitly to register a penalty', v_s.session_type;
    end if;

    select d.id, d.code, d.full_name into v_d from public.drivers d where d.id = p_driver;
    select ls.o_lineup into v_lineup from public.session_lineup_state(p_session_id) as ls;
    if v_d.id is null or not (p_driver = any (v_lineup)) then
      raise exception 'The driver is not in the lineup for this session';
    end if;

    if p_penalty_type is null or p_penalty_type not in ('places', 'back_of_grid', 'pit_lane') then
      raise exception 'Choose the penalty type';
    end if;
    if p_penalty_type = 'places' and (p_places is null or p_places < 1 or p_places > 22) then
      raise exception 'Enter the number of grid places (1 to 22)';
    end if;
    if p_penalty_type <> 'places' and p_places is not null then
      raise exception 'The number of places applies only to a places penalty';
    end if;
    if char_length(btrim(coalesce(p_reason, ''))) < 3 then
      raise exception 'The reason or official information is required';
    end if;

    insert into public.grid_penalties
      (entry_type, session_id, driver_id, penalty_type, places, original_position, adjusted_position, reason, reference, registered_by)
    values
      ('penalty', p_session_id, p_driver, p_penalty_type, p_places, p_original, p_adjusted, btrim(p_reason),
       nullif(btrim(coalesce(p_reference, '')), ''), auth.uid())
    returning id into v_id;

    v_notified := public.lo_notify_change(
      'grid_penalty', v_id, v_s.event_id, array[p_session_id],
      jsonb_build_object(
        'grand_prix', v_ev.name,
        'event_id', v_s.event_id,
        'session', v_s.session_type,
        'driver', jsonb_build_object('id', v_d.id, 'code', v_d.code, 'name', v_d.full_name),
        'penalty', jsonb_build_object(
          'type', p_penalty_type, 'places', p_places, 'original_position', p_original, 'adjusted_position', p_adjusted,
          'reason', btrim(p_reason), 'reference', nullif(btrim(coalesce(p_reference, '')), '')),
        'registered_at', now()));
  end;

  return jsonb_build_object('penalty_id', v_id, 'notified', v_notified);
end;
$$;

-- Revoke (overturned by the stewards) or correct (a revocation plus a corrected penalty in one call).
-- p_replacement: {penalty_type, places, original_position, adjusted_position, reason, reference}; NULL = plain revoke.
create function public.admin_revoke_grid_penalty(
  p_penalty_id  uuid,
  p_reason      text,
  p_replacement jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_p         record;
  v_s         record;
  v_ev        record;
  v_d         record;
  v_rev       uuid;
  v_new       uuid;
  v_type      text;
  v_places    integer;
  v_orig      integer;
  v_adj       integer;
  v_rreason   text;
  v_ref       text;
  v_notified  integer;
begin
  if not public.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'A reason is required';
  end if;

  select p.id, p.session_id, p.driver_id, p.penalty_type, p.places, p.original_position, p.adjusted_position, p.reason
    into v_p
  from public.grid_penalties p where p.id = p_penalty_id and p.entry_type = 'penalty';
  if v_p.id is null then
    raise exception 'Unknown penalty';
  end if;
  if exists (select 1 from public.grid_penalties r where r.revokes_id = p_penalty_id) then
    raise exception 'This penalty has already been revoked';
  end if;

  select s.id, s.session_type, s.start_utc, s.event_id into v_s from public.sessions s where s.id = v_p.session_id;
  select e.id, e.name, e.status into v_ev from public.events e where e.id = v_s.event_id for update;
  if v_ev.status <> 'scheduled' then
    raise exception 'Grid penalties can only be changed for a scheduled event';
  end if;
  if exists (select 1 from public.results r where r.session_id = v_s.id and r.status in ('pending', 'approved'))
     or (v_s.start_utc is not null and v_s.start_utc <= now()) then
    raise exception 'The % session has already taken place', v_s.session_type;
  end if;

  select d.id, d.code, d.full_name into v_d from public.drivers d where d.id = v_p.driver_id;

  insert into public.grid_penalties (entry_type, session_id, driver_id, reason, revokes_id, registered_by)
  values ('revocation', v_p.session_id, v_p.driver_id, btrim(p_reason), p_penalty_id, auth.uid())
  returning id into v_rev;

  if p_replacement is null then
    v_notified := public.lo_notify_change(
      'grid_penalty_revoked', v_rev, v_s.event_id, array[v_s.id],
      jsonb_build_object(
        'grand_prix', v_ev.name,
        'event_id', v_s.event_id,
        'session', v_s.session_type,
        'driver', jsonb_build_object('id', v_d.id, 'code', v_d.code, 'name', v_d.full_name),
        'penalty', jsonb_build_object('type', v_p.penalty_type, 'places', v_p.places,
                                      'original_position', v_p.original_position, 'adjusted_position', v_p.adjusted_position,
                                      'reason', v_p.reason),
        'reason', btrim(p_reason),
        'registered_at', now()));
    return jsonb_build_object('revocation_id', v_rev, 'penalty_id', null, 'notified', v_notified);
  end if;

  v_type    := p_replacement ->> 'penalty_type';
  v_rreason := btrim(coalesce(p_replacement ->> 'reason', ''));
  v_ref     := nullif(btrim(coalesce(p_replacement ->> 'reference', '')), '');
  v_places  := nullif(btrim(coalesce(p_replacement ->> 'places', '')), '')::integer;
  v_orig    := nullif(btrim(coalesce(p_replacement ->> 'original_position', '')), '')::integer;
  v_adj     := nullif(btrim(coalesce(p_replacement ->> 'adjusted_position', '')), '')::integer;

  if v_type is null or v_type not in ('places', 'back_of_grid', 'pit_lane') then
    raise exception 'Choose the type of the corrected penalty';
  end if;
  if v_type = 'places' and (v_places is null or v_places < 1 or v_places > 22) then
    raise exception 'Enter the number of grid places (1 to 22)';
  end if;
  if v_type <> 'places' and v_places is not null then
    raise exception 'The number of places applies only to a places penalty';
  end if;
  if char_length(v_rreason) < 3 then
    raise exception 'The corrected penalty needs its own reason or official information';
  end if;

  insert into public.grid_penalties
    (entry_type, session_id, driver_id, penalty_type, places, original_position, adjusted_position, reason, reference, registered_by)
  values
    ('penalty', v_p.session_id, v_p.driver_id, v_type, v_places, v_orig, v_adj, v_rreason, v_ref, auth.uid())
  returning id into v_new;

  v_notified := public.lo_notify_change(
    'grid_penalty_updated', v_new, v_s.event_id, array[v_s.id],
    jsonb_build_object(
      'grand_prix', v_ev.name,
      'event_id', v_s.event_id,
      'session', v_s.session_type,
      'driver', jsonb_build_object('id', v_d.id, 'code', v_d.code, 'name', v_d.full_name),
      'previous', jsonb_build_object('type', v_p.penalty_type, 'places', v_p.places,
                                     'original_position', v_p.original_position, 'adjusted_position', v_p.adjusted_position,
                                     'reason', v_p.reason),
      'penalty', jsonb_build_object('type', v_type, 'places', v_places, 'original_position', v_orig,
                                    'adjusted_position', v_adj, 'reason', v_rreason, 'reference', v_ref),
      'reason', btrim(p_reason),
      'registered_at', now()));

  return jsonb_build_object('revocation_id', v_rev, 'penalty_id', v_new, 'notified', v_notified);
end;
$$;

-- The Predictions page function, now with the penalties in force for the session (same signature and permissions).
create or replace function public.prediction_form_lineup(p_session_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user     uuid := auth.uid();
  v_event    text;
  v_use      boolean;
  v_line     text[];
  v_stand    jsonb;
  v_old      jsonb;
  v_own      jsonb;
  v_changes  jsonb;
  v_pen      jsonb;
begin
  if v_user is null then
    raise exception 'You must be signed in' using errcode = '28000';
  end if;
  if not exists (select 1 from public.group_members where user_id = v_user) then
    raise exception 'Join the friends group first' using errcode = '42501';
  end if;

  select s.event_id into v_event from public.sessions s where s.id = p_session_id;
  if v_event is null then
    raise exception 'Unknown session' using errcode = '22023';
  end if;

  select ls.o_use, ls.o_lineup, ls.o_stand_ins into v_use, v_line, v_stand
  from public.session_lineup_state(p_session_id) as ls;

  select pr.picks into v_old
  from public.predictions pr
  where pr.user_id = v_user and pr.session_id = p_session_id;

  v_own := coalesce((
    select jsonb_object_agg(k.key, k.value)
    from jsonb_each_text(v_stand) as k
    where k.key = any (public.picks_driver_ids(v_old))), '{}'::jsonb);

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'kind', 'substitution',
             'status', case l.action when 'apply' then 'applied' else 'reverted' end,
             'out', jsonb_build_object('id', ds.out_driver_id) || ds.out_info,
             'in', jsonb_build_object('id', ds.in_driver_id) || ds.in_info,
             'registered_at', ds.registered_at,
             'changed_at', l.acted_at)
           order by ds.registered_at, ds.id), '[]'::jsonb)
    into v_changes
  from public.driver_substitutions ds
  join lateral (
    select x.action, x.acted_at
    from public.driver_substitution_sessions x
    where x.substitution_id = ds.id and x.session_id = p_session_id
    order by x.seq desc
    limit 1
  ) l on true
  where ds.event_id = v_event;

  -- Grid penalties still in force for this session (informational only).
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id', p.id,
             'driver', jsonb_build_object('id', d.id, 'code', d.code, 'name', d.full_name),
             'penalty_type', p.penalty_type,
             'places', p.places,
             'original_position', p.original_position,
             'adjusted_position', p.adjusted_position,
             'reason', p.reason,
             'reference', p.reference,
             'registered_at', p.registered_at)
           order by p.registered_at, p.id), '[]'::jsonb)
    into v_pen
  from public.grid_penalties p
  join public.drivers d on d.id = p.driver_id
  where p.session_id = p_session_id
    and p.entry_type = 'penalty'
    and not exists (select 1 from public.grid_penalties r where r.revokes_id = p.id);

  return jsonb_build_object(
    'use', v_use,
    'lineup', to_jsonb(v_line),
    'stand_ins', case when v_use then v_own else '{}'::jsonb end,
    'changes', v_changes,
    'penalties', v_pen);
end;
$$;

-- Permissions
revoke all on function public.session_has_grid_penalty(text) from public, anon, authenticated;
grant execute on function public.session_has_grid_penalty(text) to service_role;

revoke all on function public.admin_preview_grid_penalty(text)                                                      from public, anon;
revoke all on function public.admin_register_grid_penalty(text, text, text, integer, integer, integer, text, text, boolean) from public, anon;
revoke all on function public.admin_revoke_grid_penalty(uuid, text, jsonb)                                          from public, anon;
revoke all on function public.prediction_form_lineup(text)                                                          from public, anon;
grant execute on function public.admin_preview_grid_penalty(text)                                                      to authenticated;
grant execute on function public.admin_register_grid_penalty(text, text, text, integer, integer, integer, text, text, boolean) to authenticated;
grant execute on function public.admin_revoke_grid_penalty(uuid, text, jsonb)                                          to authenticated;
grant execute on function public.prediction_form_lineup(text)                                                          to authenticated;

do $$
declare
  v_bad text := '';
  r     record;
begin
  for r in
    select p.oid::regprocedure::text as fn
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname = 'session_has_grid_penalty'
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
      and p.proname in ('admin_preview_grid_penalty', 'admin_register_grid_penalty', 'admin_revoke_grid_penalty',
                        'prediction_form_lineup')
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
