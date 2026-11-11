-- ROLLBACK for 030_lineup_foundation.sql
-- Restores the previous (live, pre-030) definitions and permissions of validate_session_data, submit_prediction,
-- enter_result, admin_enter_manual_result and admin_save_result_edit, then removes the objects 030 added.
-- No predictions, results, scores, drivers or season data are touched.
-- The two substitution tables are dropped ONLY if they are empty. If they contain rows (M2 or later was used) they are kept.
-- Run the whole file once in the Supabase SQL Editor (one transaction).

begin;

-- 1. Callers first (their previous bodies call validate_session_data with four arguments).
CREATE OR REPLACE FUNCTION public.submit_prediction(p_session_id text, p_picks jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user    uuid := auth.uid();
  v_type    text;
  v_season  integer;
  v_status  text;
  v_lock    timestamptz;
  v_id      uuid;
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

  perform public.validate_session_data(v_type, p_picks, v_season, false);

  insert into public.predictions (user_id, session_id, picks)
  values (v_user, p_session_id, p_picks)
  on conflict (user_id, session_id) do update
    set picks = excluded.picks, updated_at = now()
  returning id into v_id;

  return v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.enter_result(p_session_id text, p_data jsonb, p_source text DEFAULT 'manual'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_type     text;
  v_season   integer;
  v_version  integer;
  v_id       uuid;
begin
  select s.session_type, e.season into v_type, v_season
  from public.sessions s
  join public.events e on e.id = s.event_id
  where s.id = p_session_id;

  if v_type is null then
    raise exception 'Unknown session';
  end if;

  perform public.validate_session_data(v_type, p_data, v_season, true);

  select coalesce(max(version), 0) + 1 into v_version
  from public.results where session_id = p_session_id;

  insert into public.results (session_id, version, status, data, source)
  values (p_session_id, v_version, 'pending', p_data, p_source)
  returning id into v_id;

  return v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_enter_manual_result(p_session_id text, p_data jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_type     text;
  v_season   integer;
  v_version  integer;
  v_id       uuid;
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

  perform public.validate_session_data(v_type, p_data, v_season, true);

  select coalesce(max(version), 0) + 1 into v_version
  from public.results where session_id = p_session_id;

  insert into public.results (session_id, version, status, data, source)
  values (p_session_id, v_version, 'pending', p_data, 'manual')
  returning id into v_id;

  return v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_save_result_edit(p_result_id uuid, p_data jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_session   text;
  v_status    text;
  v_snapshot  jsonb;
  v_type      text;
  v_season    integer;
  v_version   integer;
  v_id        uuid;
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

  perform public.validate_session_data(v_type, p_data, v_season, true);

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

-- 2. Replace the lineup-aware validate_session_data by the original four-argument version.
drop function public.validate_session_data(text, jsonb, integer, boolean, text[], jsonb);

CREATE OR REPLACE FUNCTION public.validate_session_data(p_type text, p_data jsonb, p_season integer, p_is_result boolean)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  v_n        integer;
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

  select count(*) into v_n
  from public.drivers d
  where d.season = p_season and (p_is_result or d.is_active);

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
    perform public.check_drivers(v_q1 || v_q2 || v_q3, p_season, not p_is_result);

  elsif p_type = 'sprint' then
    v_top := public.picks_array(p_data, 'top8', 8);
    perform public.check_drivers(v_top, p_season, not p_is_result);

  else -- race
    v_top := public.picks_array(p_data, 'top8', 8);
    perform public.check_drivers(v_top, p_season, not p_is_result);

    if coalesce(jsonb_typeof(p_data -> 'fastest_lap'), '') <> 'string' then
      raise exception 'Pick a driver for fastest lap' using errcode = '22023';
    end if;
    v_fl := p_data ->> 'fastest_lap';
    perform public.check_drivers(array[v_fl], p_season, not p_is_result);

    if p_is_result then
      v_dnf  := public.picks_array(p_data, 'dnf_drivers', null);
      perform public.check_drivers(v_dnf, p_season, true);
      v_grid := public.picks_array(p_data, 'grid_top8', 8);
      perform public.check_drivers(v_grid, p_season, true);
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
        perform public.check_drivers(array[v_drv], p_season, true);
      end if;

      -- New format: one driver for every DNF you predict.
      if p_data ? 'dnf_drivers' then
        if v_drv is not null then
          raise exception 'Use either dnf_driver or dnf_drivers, not both' using errcode = '22023';
        end if;
        v_list := public.picks_array(p_data, 'dnf_drivers', v_count::integer);
        perform public.check_drivers(v_list, p_season, true);
        if exists (select 1 from unnest(v_list) as d where d = any (v_top)) then
          raise exception 'A driver who retires cannot also finish in your top 8' using errcode = '22023';
        end if;
      end if;
    end if;
  end if;
end;
$function$;

-- 3. Permissions exactly as in 007, 009, 016 and 017.
revoke all on function public.validate_session_data(text, jsonb, integer, boolean) from public, anon, authenticated;
revoke all on function public.enter_result(text, jsonb, text)                      from public, anon, authenticated;
revoke all on function public.submit_prediction(text, jsonb)                       from public, anon;
revoke all on function public.admin_enter_manual_result(text, jsonb)               from public, anon;
revoke all on function public.admin_save_result_edit(uuid, jsonb)                  from public, anon;

grant execute on function public.validate_session_data(text, jsonb, integer, boolean) to service_role;
grant execute on function public.enter_result(text, jsonb, text)                      to service_role;
grant execute on function public.submit_prediction(text, jsonb)                       to authenticated;
grant execute on function public.admin_enter_manual_result(text, jsonb)               to authenticated;
grant execute on function public.admin_save_result_edit(uuid, jsonb)                  to authenticated;

-- 4. Remove the helper functions added by 030 (nothing calls them any more).
drop function public.session_lineup(text);
drop function public.session_lineup_external(text);
drop function public.session_lineup_state(text);
drop function public.check_pick_drivers(text[], integer, boolean, text[]);
drop function public.picks_driver_ids(jsonb);

-- 5. Drop the substitution tables only if they are empty (never lose data).
do $$
begin
  if (select count(*) from public.driver_substitutions) = 0
     and (select count(*) from public.driver_substitution_sessions) = 0 then
    drop table public.driver_substitution_sessions;
    drop table public.driver_substitutions;
    drop function public.lo_block_change();
    raise notice 'Substitution tables were empty and have been removed.';
  else
    raise notice 'Substitution tables contain rows and were KEPT (no data was removed).';
  end if;
end;
$$;

-- 6. Safety check: exactly one validate_session_data, with its original permissions.
do $$
begin
  if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'validate_session_data') <> 1 then
    raise exception 'validate_session_data must exist exactly once';
  end if;
  if has_function_privilege('anon', 'public.validate_session_data(text, jsonb, integer, boolean)'::regprocedure, 'EXECUTE')
     or has_function_privilege('authenticated', 'public.validate_session_data(text, jsonb, integer, boolean)'::regprocedure, 'EXECUTE') then
    raise exception 'validate_session_data must not be executable by anon or authenticated';
  end if;
end;
$$;

commit;