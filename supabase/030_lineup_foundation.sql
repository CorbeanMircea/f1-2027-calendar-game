-- 030: Lineup foundation (Milestone M1 of driver substitutions, grid penalties and admin corrections).
--
-- WHAT THIS DOES
--   * Creates two EMPTY, append-only tables for driver substitutions (nothing writes to them yet).
--   * Adds session_lineup_state() / session_lineup() / session_lineup_external(): the effective driver lineup of a session.
--   * Makes validate_session_data() lineup-aware through two OPTIONAL trailing parameters (one function, one source of truth).
--   * Makes the four callers (submit_prediction, enter_result, admin_save_result_edit, admin_enter_manual_result) pass the lineup.
--
-- WHAT IT DOES NOT DO
--   * No driver rows, no substitutions, no scores, no predictions, no results are created or changed.
--   * Season picks, season scoring, bonus points, XP, achievements, deadlines and locking are not touched.
--   * Scoring (calc_points, recalculate_scores, approve_result) is not touched.
--
-- BEHAVIOUR TODAY
--   session_lineup_state() reports o_use = false unless (a) a substitution applies to the session or (b) the season has an
--   inactive driver row. Today neither is true (22 of 22 drivers of 2026 are active, no substitution rows exist), so every
--   caller passes NULL and validate_session_data() runs its original code path, line for line.
--
-- ONE INTENTIONAL DIFFERENCE (dormant today): when a season has an inactive driver row and no substitution, RESULT validation
--   counts the active lineup instead of all driver rows. The importer already counts active drivers, so this removes a
--   mismatch that would otherwise appear as soon as any inactive driver row exists.
--
-- ROLLBACK: supabase/maintenance/rollback_030_lineup_foundation.sql
-- Run the whole file once in the Supabase SQL Editor. It is one transaction: it either applies completely or not at all.

begin;

-- ---------------------------------------------------------------------------
-- 1. Append-only substitution tables (empty in this milestone)
-- ---------------------------------------------------------------------------

create function public.lo_block_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'This table is append-only' using errcode = '55000';
end;
$$;

create table public.driver_substitutions (
  id             uuid        primary key default gen_random_uuid(),
  event_id       text        not null references public.events (id),
  out_driver_id  text        not null references public.drivers (id),
  in_driver_id   text        not null references public.drivers (id),
  out_info       jsonb       not null default '{}'::jsonb,   -- code, team, number of the outgoing driver at registration
  in_info        jsonb       not null default '{}'::jsonb,   -- code, team, number of the replacement at registration
  note           text,
  registered_by  uuid,                                       -- no foreign key: the audit identity must outlive the account
  registered_at  timestamptz not null default now(),
  constraint driver_substitutions_distinct check (out_driver_id <> in_driver_id)
);

-- One row per (substitution, session, action). The effective state is the latest action row.
create table public.driver_substitution_sessions (
  seq              bigint      generated always as identity primary key,
  substitution_id  uuid        not null references public.driver_substitutions (id),
  session_id       text        not null references public.sessions (id),
  action           text        not null check (action in ('apply', 'revert')),
  reason           text,
  acted_by         uuid,
  acted_at         timestamptz not null default now(),
  constraint driver_substitution_sessions_revert_reason
    check (action = 'apply' or char_length(btrim(coalesce(reason, ''))) >= 3)
);

create index driver_substitutions_event_idx on public.driver_substitutions (event_id);
create index driver_substitution_sessions_session_idx on public.driver_substitution_sessions (session_id, substitution_id, seq);

create trigger driver_substitutions_append_only
  before update or delete on public.driver_substitutions
  for each row execute function public.lo_block_change();

create trigger driver_substitution_sessions_append_only
  before update or delete on public.driver_substitution_sessions
  for each row execute function public.lo_block_change();

alter table public.driver_substitutions enable row level security;
alter table public.driver_substitution_sessions enable row level security;

create policy "group members read substitutions"
  on public.driver_substitutions for select to authenticated
  using (exists (select 1 from public.group_members gm where gm.user_id = auth.uid()));

create policy "group members read substitution sessions"
  on public.driver_substitution_sessions for select to authenticated
  using (exists (select 1 from public.group_members gm where gm.user_id = auth.uid()));

revoke all on public.driver_substitutions, public.driver_substitution_sessions from anon, authenticated;
grant select on public.driver_substitutions, public.driver_substitution_sessions to authenticated;

revoke all on function public.lo_block_change() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Lineup functions
-- ---------------------------------------------------------------------------

-- Internal. o_use      : true when a substitution applies to the session OR the season has an inactive driver row.
--           o_lineup   : the effective lineup (driver ids): active drivers, with every effective substitution applied in
--                        registration order.
--           o_stand_ins: {withdrawn driver id: the lineup driver who replaced him (following chains)}.
-- A substitution row is effective for a session when the latest action row for (substitution, session) is 'apply'.
create function public.session_lineup_state(p_session_id text)
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
  v_outs      text[] := '{}'::text[];
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

  for r in
    select ds.out_driver_id as out_id, ds.in_driver_id as in_id
    from public.driver_substitutions ds
    where ds.event_id = v_event
      and exists (
        select 1
        from public.driver_substitution_sessions x
        where x.substitution_id = ds.id
          and x.session_id = p_session_id
          and x.action = 'apply'
          and not exists (
            select 1
            from public.driver_substitution_sessions y
            where y.substitution_id = x.substitution_id
              and y.session_id = x.session_id
              and y.seq > x.seq))
    order by ds.registered_at, ds.id
  loop
    v_has := true;
    v_line := array_remove(v_line, r.out_id);
    if not (r.in_id = any (v_line)) then
      v_line := v_line || r.in_id;
    end if;
    v_succ := v_succ || jsonb_build_object(r.out_id, r.in_id);
    v_outs := v_outs || r.out_id;
  end loop;

  -- Resolve every withdrawn driver to the lineup driver who finally took his place (chains A -> B -> C).
  foreach w in array v_outs loop
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

-- For the admin editors and, later, the prediction form: the effective lineup of a session (driver ids).
create function public.session_lineup(p_session_id text)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select ls.o_lineup from public.session_lineup_state(p_session_id) as ls;
$$;

-- For the importer (service role only): the same lineup as Jolpica driver ids.
create function public.session_lineup_external(p_session_id text)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(d.external_id order by d.code), '{}'::text[])
  from public.session_lineup_state(p_session_id) as ls
  join public.drivers d on d.id = any (ls.o_lineup)
  where d.external_id is not null;
$$;

-- Internal: every driver id in a saved picks object (used to find which withdrawn drivers a player already saved).
create function public.picks_driver_ids(p_picks jsonb)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select public.jarr(p_picks, 'q1_out')
      || public.jarr(p_picks, 'q2_out')
      || public.jarr(p_picks, 'q3_order')
      || public.jarr(p_picks, 'top8')
      || public.jarr(p_picks, 'dnf_drivers')
      || array_remove(array[p_picks ->> 'fastest_lap', p_picks ->> 'dnf_driver'], null);
$$;

-- Internal: the single driver check used by validate_session_data.
-- p_pool NULL  -> exactly the original check_drivers() (unchanged).
-- p_pool given -> the same duplicate and season checks, but membership is the given pool instead of "active driver".
create function public.check_pick_drivers(p_ids text[], p_season integer, p_only_active boolean, p_pool text[])
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_pool is null then
    perform public.check_drivers(p_ids, p_season, p_only_active);
    return;
  end if;
  if (select count(distinct x) from unnest(p_ids) as x) <> cardinality(p_ids) then
    raise exception 'Each driver can appear only once' using errcode = '22023';
  end if;
  if (select count(*) from public.drivers d
      where d.id = any (p_ids)
        and d.season = p_season
        and d.id = any (p_pool)) <> cardinality(p_ids) then
    raise exception 'Unknown or inactive driver in your picks' using errcode = '22023';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. validate_session_data: one function, two optional trailing parameters
-- ---------------------------------------------------------------------------
-- p_lineup NULL (the default) = original behaviour. p_stand_ins is only used for predictions:
-- {withdrawn driver id: replacement id} for withdrawn drivers the player ALREADY saved for this session.

drop function public.validate_session_data(text, jsonb, integer, boolean);

create function public.validate_session_data(
  p_type       text,
  p_data       jsonb,
  p_season     integer,
  p_is_result  boolean,
  p_lineup     text[] default null,
  p_stand_ins  jsonb  default null
)
returns void
language plpgsql
stable
set search_path to ''
as $function$
declare
  v_n        integer;
  v_pool     text[];
  v_picked   text[];
  v_allowed  text[];
  v_q1       text[];
  v_q2       text[];
  v_q3       text[];
  v_top      text[];
  v_dnf      text[];
  v_grid     text[];
  v_fl       text;
  v_drv      text;
  v_any      boolean;
  v_count    numeric;
  v_list     text[];
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'Picks must be a JSON object' using errcode = '22023';
  end if;

  if p_lineup is null then
    select count(*) into v_n
    from public.drivers d
    where d.season = p_season and (p_is_result or d.is_active);
  else
    v_n := cardinality(p_lineup);
    v_pool := p_lineup;
    if not p_is_result then
      -- Withdrawn drivers the player already saved stay valid; nobody else can be added.
      v_pool := v_pool || coalesce(
        array(select k from jsonb_object_keys(coalesce(p_stand_ins, '{}'::jsonb)) as k),
        '{}'::text[]);
    end if;
  end if;

  if p_type in ('qualifying', 'sprint_qualifying') then
    v_allowed := array['q1_out', 'q2_out', 'q3_order'];
  elsif p_type = 'race' then
    v_allowed := case when p_is_result
                      then array['top8', 'fastest_lap', 'dnf_drivers', 'grid_top8']
                      else array['top8', 'fastest_lap', 'any_dnf', 'dnf_count', 'dnf_driver', 'dnf_drivers'] end;
  elsif p_type = 'sprint' then
    v_allowed := array['top8'];
  else
    raise exception 'Unknown session type' using errcode = '22023';
  end if;

  if exists (select 1 from jsonb_object_keys(p_data) as k where k <> all (v_allowed)) then
    raise exception 'Unexpected field in picks' using errcode = '22023';
  end if;

  if p_type in ('qualifying', 'sprint_qualifying') then
    if v_n < 17 then
      raise exception 'Not enough drivers loaded for this season' using errcode = '22023';
    end if;
    v_q1 := public.picks_array(p_data, 'q1_out', v_n - 16);
    v_q2 := public.picks_array(p_data, 'q2_out', 6);
    v_q3 := public.picks_array(p_data, 'q3_order', 10);
    v_picked := v_q1 || v_q2 || v_q3;
    perform public.check_pick_drivers(v_picked, p_season, not p_is_result, v_pool);

    -- Complete ranking: every lineup driver must be ranked, except a driver whose withdrawn predecessor
    -- (already in this player's saved picks) is ranked in his place. Results are complete by size and membership.
    if p_lineup is not null and not p_is_result then
      if exists (
        select 1
        from unnest(p_lineup) as l(id)
        where l.id <> all (v_picked)
          and l.id <> all (coalesce(array(
                select s.value
                from jsonb_each_text(coalesce(p_stand_ins, '{}'::jsonb)) as s
                where s.key = any (v_picked)), '{}'::text[]))
      ) then
        raise exception 'Your ranking must include every driver in the current lineup' using errcode = '22023';
      end if;
    end if;

  elsif p_type = 'sprint' then
    v_top := public.picks_array(p_data, 'top8', 8);
    perform public.check_pick_drivers(v_top, p_season, not p_is_result, v_pool);

  else -- race
    v_top := public.picks_array(p_data, 'top8', 8);
    perform public.check_pick_drivers(v_top, p_season, not p_is_result, v_pool);

    if coalesce(jsonb_typeof(p_data -> 'fastest_lap'), '') <> 'string' then
      raise exception 'Pick a driver for fastest lap' using errcode = '22023';
    end if;
    v_fl := p_data ->> 'fastest_lap';
    perform public.check_pick_drivers(array[v_fl], p_season, not p_is_result, v_pool);

    if p_is_result then
      v_dnf  := public.picks_array(p_data, 'dnf_drivers', null);
      perform public.check_pick_drivers(v_dnf, p_season, true, v_pool);
      v_grid := public.picks_array(p_data, 'grid_top8', 8);
      perform public.check_pick_drivers(v_grid, p_season, true, v_pool);
    else
      if coalesce(jsonb_typeof(p_data -> 'any_dnf'), '') <> 'boolean' then
        raise exception 'Answer whether there will be a DNF' using errcode = '22023';
      end if;
      v_any := (p_data ->> 'any_dnf')::boolean;

      if coalesce(jsonb_typeof(p_data -> 'dnf_count'), '') <> 'number' then
        raise exception 'Give the number of DNFs' using errcode = '22023';
      end if;
      v_count := (p_data ->> 'dnf_count')::numeric;
      if v_count <> floor(v_count) or v_count < 0 or v_count > v_n
         or (p_data ? 'dnf_drivers' and v_count > 5) then
        raise exception 'The number of DNFs is not valid' using errcode = '22023';
      end if;

      v_drv := p_data ->> 'dnf_driver';   -- NULL when absent or JSON null
      if v_any then
        if v_count < 1 then
          raise exception 'DNF answers must be consistent' using errcode = '22023';
        end if;
      else
        if v_count <> 0 or v_drv is not null then
          raise exception 'DNF answers must be consistent' using errcode = '22023';
        end if;
      end if;
      if v_drv is not null then
        perform public.check_pick_drivers(array[v_drv], p_season, true, v_pool);
      end if;

      -- New format: one driver for every DNF you predict.
      if p_data ? 'dnf_drivers' then
        if v_drv is not null then
          raise exception 'Use either dnf_driver or dnf_drivers, not both' using errcode = '22023';
        end if;
        v_list := public.picks_array(p_data, 'dnf_drivers', v_count::integer);
        perform public.check_pick_drivers(v_list, p_season, true, v_pool);
        if exists (select 1 from unnest(v_list) as d where d = any (v_top)) then
          raise exception 'A driver who retires cannot also finish in your top 8' using errcode = '22023';
        end if;
      end if;
    end if;
  end if;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Callers: pass the lineup (NULL while no substitution or inactive driver exists)
-- ---------------------------------------------------------------------------

create or replace function public.submit_prediction(p_session_id text, p_picks jsonb)
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_user    uuid := auth.uid();
  v_type    text;
  v_season  integer;
  v_status  text;
  v_lock    timestamptz;
  v_id      uuid;
  v_use     boolean;
  v_line    text[];
  v_stand   jsonb;
  v_old     jsonb;
  v_own     jsonb;
begin
  if v_user is null then
    raise exception 'You must be signed in' using errcode = '28000';
  end if;

  if not exists (select 1 from public.group_members where user_id = v_user) then
    raise exception 'Join the friends group before predicting' using errcode = '42501';
  end if;

  select s.session_type, e.season, e.status, l.start_utc
    into v_type, v_season, v_status, v_lock
  from public.sessions s
  join public.events e on e.id = s.event_id
  left join public.sessions l
    on l.event_id = s.event_id
   and l.session_type = case s.session_type
                          when 'race'   then 'qualifying'
                          when 'sprint' then 'sprint_qualifying'
                          else s.session_type
                        end
  where s.id = p_session_id;

  if v_type is null then
    raise exception 'Unknown session' using errcode = '22023';
  end if;

  if v_status <> 'scheduled' or v_lock is null or now() >= v_lock then
    raise exception 'Predictions are closed for this session' using errcode = '55000';
  end if;

  -- Effective lineup, and the withdrawn drivers THIS player already saved for this session (read here, never from the client).
  select ls.o_use, ls.o_lineup, ls.o_stand_ins into v_use, v_line, v_stand
  from public.session_lineup_state(p_session_id) as ls;

  select pr.picks into v_old
  from public.predictions pr
  where pr.user_id = v_user and pr.session_id = p_session_id;

  v_own := coalesce((
    select jsonb_object_agg(k.key, k.value)
    from jsonb_each_text(v_stand) as k
    where k.key = any (public.picks_driver_ids(v_old))), '{}'::jsonb);

  perform public.validate_session_data(
    v_type, p_picks, v_season, false,
    case when v_use then v_line end,
    case when v_use then v_own end);

  insert into public.predictions (user_id, session_id, picks)
  values (v_user, p_session_id, p_picks)
  on conflict (user_id, session_id) do update
    set picks = excluded.picks, updated_at = now()
  returning id into v_id;

  return v_id;
end;
$function$;

create or replace function public.enter_result(p_session_id text, p_data jsonb, p_source text default 'manual'::text)
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_type     text;
  v_season   integer;
  v_version  integer;
  v_id       uuid;
  v_use      boolean;
  v_line     text[];
begin
  select s.session_type, e.season into v_type, v_season
  from public.sessions s
  join public.events e on e.id = s.event_id
  where s.id = p_session_id;

  if v_type is null then
    raise exception 'Unknown session';
  end if;

  select ls.o_use, ls.o_lineup into v_use, v_line
  from public.session_lineup_state(p_session_id) as ls;

  perform public.validate_session_data(v_type, p_data, v_season, true, case when v_use then v_line end);

  select coalesce(max(version), 0) + 1 into v_version
  from public.results where session_id = p_session_id;

  insert into public.results (session_id, version, status, data, source)
  values (p_session_id, v_version, 'pending', p_data, p_source)
  returning id into v_id;

  return v_id;
end;
$function$;

create or replace function public.admin_enter_manual_result(p_session_id text, p_data jsonb)
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_type     text;
  v_season   integer;
  v_version  integer;
  v_id       uuid;
  v_use      boolean;
  v_line     text[];
begin
  if not public.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;

  select s.session_type, e.season into v_type, v_season
  from public.sessions s
  join public.events e on e.id = s.event_id
  where s.id = p_session_id;

  if v_type is null then
    raise exception 'Unknown session';
  end if;
  if exists (
    select 1 from public.results
    where session_id = p_session_id and status in ('pending', 'approved')
  ) then
    raise exception 'A result already exists for this session; edit it instead';
  end if;

  select ls.o_use, ls.o_lineup into v_use, v_line
  from public.session_lineup_state(p_session_id) as ls;

  perform public.validate_session_data(v_type, p_data, v_season, true, case when v_use then v_line end);

  select coalesce(max(version), 0) + 1 into v_version
  from public.results where session_id = p_session_id;

  insert into public.results (session_id, version, status, data, source)
  values (p_session_id, v_version, 'pending', p_data, 'manual')
  returning id into v_id;

  return v_id;
end;
$function$;

create or replace function public.admin_save_result_edit(p_result_id uuid, p_data jsonb)
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_session   text;
  v_status    text;
  v_snapshot  jsonb;
  v_type      text;
  v_season    integer;
  v_version   integer;
  v_id        uuid;
  v_use       boolean;
  v_line      text[];
begin
  if not public.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;

  select r.session_id, r.status, coalesce(r.api_snapshot, r.data)
    into v_session, v_status, v_snapshot
  from public.results r
  where r.id = p_result_id;

  if v_session is null then
    raise exception 'Result not found';
  end if;
  if v_status not in ('pending', 'approved') then
    raise exception 'Only pending or approved results can be edited';
  end if;

  select s.session_type, e.season into v_type, v_season
  from public.sessions s
  join public.events e on e.id = s.event_id
  where s.id = v_session;

  select ls.o_use, ls.o_lineup into v_use, v_line
  from public.session_lineup_state(v_session) as ls;

  perform public.validate_session_data(v_type, p_data, v_season, true, case when v_use then v_line end);

  select coalesce(max(version), 0) + 1 into v_version
  from public.results where session_id = v_session;

  insert into public.results (session_id, version, status, data, source, api_snapshot)
  values (v_session, v_version, 'pending', p_data, 'manual-edit', v_snapshot)
  returning id into v_id;

  -- A pending result that was edited is replaced by the edited version.
  if v_status = 'pending' then
    update public.results set status = 'superseded' where id = p_result_id;
  end if;

  return v_id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Permissions (explicit; the new functions would otherwise get Supabase's default EXECUTE grants)
-- ---------------------------------------------------------------------------

-- Service-role-only (internal / importer). Existing intent from 007, 009 and 010 is re-stated for the replaced signatures.
revoke all on function public.session_lineup_state(text)                                           from public, anon, authenticated;
revoke all on function public.session_lineup_external(text)                                        from public, anon, authenticated;
revoke all on function public.picks_driver_ids(jsonb)                                              from public, anon, authenticated;
revoke all on function public.check_pick_drivers(text[], integer, boolean, text[])                 from public, anon, authenticated;
revoke all on function public.validate_session_data(text, jsonb, integer, boolean, text[], jsonb) from public, anon, authenticated;
revoke all on function public.enter_result(text, jsonb, text)                                      from public, anon, authenticated;

grant execute on function public.session_lineup_state(text)                                           to service_role;
grant execute on function public.session_lineup_external(text)                                        to service_role;
grant execute on function public.picks_driver_ids(jsonb)                                              to service_role;
grant execute on function public.check_pick_drivers(text[], integer, boolean, text[])                 to service_role;
grant execute on function public.validate_session_data(text, jsonb, integer, boolean, text[], jsonb) to service_role;
grant execute on function public.enter_result(text, jsonb, text)                                      to service_role;

-- Signed-in users: the lineup read (admin editors now, prediction form later), predictions, and the admin functions (is_admin() inside).
revoke all on function public.session_lineup(text)                      from public, anon;
revoke all on function public.submit_prediction(text, jsonb)            from public, anon;
revoke all on function public.admin_enter_manual_result(text, jsonb)    from public, anon;
revoke all on function public.admin_save_result_edit(uuid, jsonb)       from public, anon;

grant execute on function public.session_lineup(text)                   to authenticated;
grant execute on function public.submit_prediction(text, jsonb)         to authenticated;
grant execute on function public.admin_enter_manual_result(text, jsonb) to authenticated;
grant execute on function public.admin_save_result_edit(uuid, jsonb)    to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Safety check: the whole migration is rolled back if any function has unexpected EXECUTE rights
-- ---------------------------------------------------------------------------
do $$
declare
  r      record;
  v_bad  text := '';
begin
  -- Must NOT be executable by anon, authenticated or PUBLIC.
  for r in
    select p.oid::regprocedure::text as fn
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('session_lineup_state', 'session_lineup_external', 'picks_driver_ids', 'check_pick_drivers',
                        'validate_session_data', 'check_drivers', 'picks_array', 'jarr', 'calc_points',
                        'recalculate_scores', 'enter_result', 'prediction_dnf_ok', 'result_dnf_ok', 'lo_block_change')
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

  -- Must be executable by authenticated but NOT by anon or PUBLIC.
  for r in
    select p.oid::regprocedure::text as fn
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('session_lineup', 'submit_prediction', 'admin_enter_manual_result', 'admin_save_result_edit')
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

  -- Exactly one validate_session_data must exist (no ambiguous overload).
  if (select count(*) from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.proname = 'validate_session_data') <> 1 then
    raise exception 'validate_session_data must exist exactly once';
  end if;
end;
$$;

commit;