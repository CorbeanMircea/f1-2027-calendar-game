-- 020: One driver for every DNF you predict.
--
-- Before: you gave the number of DNFs and could pick ONE optional DNF driver.
-- Now:    if you predict N DNFs you pick N drivers (N from 0 to 5). Each picked driver who
--         really retires scores 4 points, or 8 if he started in the real top 8.
--         Everything else in the scoring is unchanged.
--
-- Older predictions (with the single "dnf_driver" field) stay valid and score exactly as before.
-- Nothing is deleted. The race maximum is now 65 + 8 per DNF driver (73 with one driver).
--
-- This file replaces three functions with create or replace, so it is safe to run once.
-- Scores that were already calculated are not touched. If you change a result later, the
-- normal recalculation uses these new rules.

create or replace function public.validate_session_data(
  p_type text, p_data jsonb, p_season integer, p_is_result boolean
)
returns void
language plpgsql
stable
set search_path = ''
as $$
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
$$;


create or replace function public.calc_points(p_type text, p_picks jsonb, p_actual jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  pred       text[];
  act        text[];
  dnfs       text[];
  i          integer;
  exact_n    integer := 0;
  near_n     integer := 0;
  grp        integer := 0;
  exact_pts  integer := 0;
  near_pts   integer := 0;
  bonus      integer := 0;
  fl_pts     integer := 0;
  any_pts    integer := 0;
  count_pts  integer := 0;
  drv_pts    integer := 0;
  act_count  integer;
  pred_count integer;
  drv        text;
  picked     text[];
begin
  if p_type in ('qualifying', 'sprint_qualifying') then
    grp := grp + cardinality(array(
      select unnest(public.jarr(p_picks, 'q1_out')) intersect select unnest(public.jarr(p_actual, 'q1_out'))));
    grp := grp + cardinality(array(
      select unnest(public.jarr(p_picks, 'q2_out')) intersect select unnest(public.jarr(p_actual, 'q2_out'))));
    grp := grp + cardinality(array(
      select unnest(public.jarr(p_picks, 'q3_order')) intersect select unnest(public.jarr(p_actual, 'q3_order'))));

    pred := public.jarr(p_picks, 'q3_order');
    act  := public.jarr(p_actual, 'q3_order');
    for i in 1 .. 10 loop
      if pred[i] = act[i] then exact_n := exact_n + 1; end if;
    end loop;
    if exact_n = 10 then bonus := 10; end if;

    return jsonb_build_object(
      'group', grp, 'exact', exact_n * 3, 'bonus', bonus,
      'total', grp + exact_n * 3 + bonus);
  end if;

  -- race and sprint share the top-8 logic
  pred := public.jarr(p_picks, 'top8');
  act  := public.jarr(p_actual, 'top8');
  for i in 1 .. 8 loop
    if pred[i] = act[i] then
      exact_n := exact_n + 1;
    elsif pred[i] = any (act) then
      near_n := near_n + 1;
    end if;
  end loop;

  if p_type = 'sprint' then
    exact_pts := exact_n * 3;
    near_pts  := near_n * 1;
    if exact_n = 8 then bonus := 8; end if;
    return jsonb_build_object(
      'exact', exact_pts, 'in_top8', near_pts, 'bonus', bonus,
      'total', exact_pts + near_pts + bonus);
  end if;

  -- race
  exact_pts := exact_n * 5;
  near_pts  := near_n * 2;
  if exact_n = 8 then bonus := 15; end if;

  if (p_picks ->> 'fastest_lap') = (p_actual ->> 'fastest_lap') then fl_pts := 3; end if;

  dnfs := public.jarr(p_actual, 'dnf_drivers');
  act_count := cardinality(dnfs);
  pred_count := (p_picks ->> 'dnf_count')::integer;

  if (p_picks ->> 'any_dnf')::boolean = (act_count > 0) then any_pts := 2; end if;

  if pred_count = act_count then
    count_pts := 5;
  elsif abs(pred_count - act_count) = 1 then
    count_pts := 2;
  end if;

  -- One DNF driver (older format) or one driver per predicted DNF (new format).
  if p_picks ? 'dnf_drivers' then
    picked := public.jarr(p_picks, 'dnf_drivers');
  elsif (p_picks ->> 'dnf_driver') is not null then
    picked := array[p_picks ->> 'dnf_driver'];
  else
    picked := '{}'::text[];
  end if;
  foreach drv in array picked loop
    if drv = any (dnfs) then
      if drv = any (public.jarr(p_actual, 'grid_top8')) then drv_pts := drv_pts + 8; else drv_pts := drv_pts + 4; end if;
    end if;
  end loop;

  return jsonb_build_object(
    'exact', exact_pts, 'in_top8', near_pts, 'bonus', bonus,
    'fastest_lap', fl_pts, 'any_dnf', any_pts, 'dnf_count', count_pts, 'dnf_driver', drv_pts,
    'total', exact_pts + near_pts + bonus + fl_pts + any_pts + count_pts + drv_pts);
end;
$$;

-- A DNF driver (either format) cannot also be in the same prediction's top 8.
create or replace function public.prediction_dnf_ok(p_picks jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select not exists (
    select 1
    from unnest(public.jarr(p_picks, 'dnf_drivers') || coalesce(array[p_picks ->> 'dnf_driver'], '{}'::text[])) as d
    where d = any (public.jarr(p_picks, 'top8'))
  );
$$;


notify pgrst, 'reload schema';
