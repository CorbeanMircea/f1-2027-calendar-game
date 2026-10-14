-- 009: Scoring v2.
-- Replaces predictions / results / scores with a JSON-based model for all four session types.
-- WARNING: deletes existing practice predictions, results and scores (test data only).

-- Remove the old model ----------------------------------------------------

drop view if exists public.leaderboard;
drop table if exists public.scores;
drop table if exists public.results;
drop table if exists public.predictions;

drop function if exists public.submit_prediction(text, text, text, text, text, text, text, text);
drop function if exists public.enter_result(text, text, text, text, text, text, text, text, text);
drop function if exists public.calc_points(text, text[], text, text, text[], text, text);

-- New tables ---------------------------------------------------------------

create table public.predictions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  session_id  text not null references public.sessions (id) on delete cascade,
  picks       jsonb not null check (jsonb_typeof(picks) = 'object'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, session_id)
);
create index predictions_session_idx on public.predictions (session_id);

create table public.results (
  id           uuid primary key default gen_random_uuid(),
  session_id   text not null references public.sessions (id) on delete cascade,
  version      integer not null,
  status       text not null default 'pending'
               check (status in ('pending', 'approved', 'superseded')),
  data         jsonb not null check (jsonb_typeof(data) = 'object'),
  source       text not null default 'manual',
  entered_at   timestamptz not null default now(),
  approved_at  timestamptz,
  approved_by  uuid references auth.users (id),
  unique (session_id, version)
);
create unique index results_one_approved_per_session
  on public.results (session_id) where status = 'approved';

create table public.scores (
  user_id      uuid not null references auth.users (id) on delete cascade,
  session_id   text not null references public.sessions (id) on delete cascade,
  result_id    uuid not null references public.results (id) on delete cascade,
  points       integer not null,
  breakdown    jsonb not null,
  computed_at  timestamptz not null default now(),
  primary key (user_id, session_id)
);
create index scores_session_idx on public.scores (session_id);

alter table public.predictions enable row level security;
alter table public.results     enable row level security;
alter table public.scores      enable row level security;

-- Helpers ---------------------------------------------------------------------

-- JSON array of strings -> text[] (keeps order); a missing key gives an empty array.
create function public.jarr(p_j jsonb, p_key text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(e.x order by e.n), '{}'::text[])
  from jsonb_array_elements_text(coalesce(p_j -> p_key, '[]'::jsonb)) with ordinality as e(x, n);
$$;

-- Read a list from the picks, checking type and (optionally) size.
create function public.picks_array(p_data jsonb, p_key text, p_size integer)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v jsonb := p_data -> p_key;
begin
  if v is null or jsonb_typeof(v) <> 'array' then
    raise exception 'Missing list: %', p_key using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(v) as el where jsonb_typeof(el) <> 'string') then
    raise exception 'List % must contain driver ids only', p_key using errcode = '22023';
  end if;
  if p_size is not null and jsonb_array_length(v) <> p_size then
    raise exception 'List % must contain % drivers', p_key, p_size using errcode = '22023';
  end if;
  return public.jarr(p_data, p_key);
end;
$$;

-- No duplicates, and every driver must exist (and be active, for predictions).
create function public.check_drivers(p_ids text[], p_season integer, p_only_active boolean)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if (select count(distinct x) from unnest(p_ids) as x) <> cardinality(p_ids) then
    raise exception 'Each driver can appear only once' using errcode = '22023';
  end if;
  if (select count(*) from public.drivers d
      where d.id = any (p_ids)
        and d.season = p_season
        and (not p_only_active or d.is_active)) <> cardinality(p_ids) then
    raise exception 'Unknown or inactive driver in your picks' using errcode = '22023';
  end if;
end;
$$;

-- Full validation of a prediction (p_is_result = false) or a result (true).
create function public.validate_session_data(
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
                      else array['top8', 'fastest_lap', 'any_dnf', 'dnf_count', 'dnf_driver'] end;
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
      if v_count <> floor(v_count) or v_count < 0 or v_count > v_n then
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
    end if;
  end if;
end;
$$;

-- Scoring: pure function ---------------------------------------------------------
--   qualifying types: 1 per driver in the right group, +3 per exact Q3 slot, +10 perfect  (max 62)
--   race: top 8 exact 5 / wrong slot 2 / +15 perfect, fastest lap 3, any DNF 2,
--         DNF count exact 5 / off by one 2, DNF driver 4 (8 if on the real top-8 grid)  (max 73)
--   sprint: top 8 exact 3 / wrong slot 1 / +8 perfect                                    (max 32)

create function public.calc_points(p_type text, p_picks jsonb, p_actual jsonb)
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

  drv := p_picks ->> 'dnf_driver';
  if drv is not null and drv = any (dnfs) then
    if drv = any (public.jarr(p_actual, 'grid_top8')) then drv_pts := 8; else drv_pts := 4; end if;
  end if;

  return jsonb_build_object(
    'exact', exact_pts, 'in_top8', near_pts, 'bonus', bonus,
    'fastest_lap', fl_pts, 'any_dnf', any_pts, 'dnf_count', count_pts, 'dnf_driver', drv_pts,
    'total', exact_pts + near_pts + bonus + fl_pts + any_pts + count_pts + drv_pts);
end;
$$;

-- Lock logic for all four session types -------------------------------------------
--   qualifying / sprint_qualifying lock at their own start,
--   race locks at qualifying start, sprint locks at sprint qualifying start.

create or replace function public.is_prediction_locked(p_session_id text)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select coalesce((
    select l.start_utc is not null and now() >= l.start_utc
    from public.sessions s
    join public.sessions l
      on l.event_id = s.event_id
     and l.session_type = case s.session_type
                            when 'race'   then 'qualifying'
                            when 'sprint' then 'sprint_qualifying'
                            else s.session_type
                          end
    where s.id = p_session_id
  ), false);
$$;

create or replace view public.prediction_windows
with (security_invoker = true) as
select
  s.id           as session_id,
  s.event_id     as event_id,
  s.session_type as target_type,
  l.id           as lock_session_id,
  l.start_utc    as lock_at,
  (l.start_utc is not null and now() < l.start_utc and e.status = 'scheduled') as is_open
from public.sessions s
join public.events e on e.id = s.event_id
join public.sessions l
  on l.event_id = s.event_id
 and l.session_type = case s.session_type
                        when 'race'   then 'qualifying'
                        when 'sprint' then 'sprint_qualifying'
                        else s.session_type
                      end;

-- The only write path for players ----------------------------------------------------

create function public.submit_prediction(p_session_id text, p_picks jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- Admin functions (SQL Editor / future importer only) --------------------------------------

create function public.enter_result(p_session_id text, p_data jsonb, p_source text default 'manual')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- approve_result(uuid, uuid) from migration 007 is unchanged and keeps working.

create or replace function public.recalculate_scores(p_session_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.scores where session_id = p_session_id;

  insert into public.scores (user_id, session_id, result_id, points, breakdown)
  select p.user_id, p.session_id, r.id, (c.j ->> 'total')::integer, c.j
  from public.predictions p
  join public.sessions s on s.id = p.session_id
  join public.results r on r.session_id = p.session_id and r.status = 'approved'
  cross join lateral (
    select public.calc_points(s.session_type, p.picks, r.data) as j
  ) c
  where p.session_id = p_session_id;
end;
$$;

-- Read policies ------------------------------------------------------------------------

create policy "read own predictions, or group-mates after lock"
  on public.predictions for select to authenticated
  using (
    user_id = auth.uid()
    or (public.shares_group_with(user_id) and public.is_prediction_locked(session_id))
  );

create policy "group members read approved results"
  on public.results for select to authenticated
  using (
    status = 'approved'
    and exists (select 1 from public.group_members gm where gm.user_id = auth.uid())
  );

create policy "read own and group-mates scores"
  on public.scores for select to authenticated
  using (user_id = auth.uid() or public.shares_group_with(user_id));

-- Leaderboard view -----------------------------------------------------------------------

create view public.leaderboard
with (security_invoker = true) as
select
  e.season,
  sc.user_id,
  p.display_name,
  sum(sc.points)::integer as total_points,
  count(*)::integer       as sessions_scored
from public.scores sc
join public.sessions s on s.id = sc.session_id
join public.events   e on e.id = s.event_id
join public.profiles p on p.id = sc.user_id
group by e.season, sc.user_id, p.display_name;

-- Privileges -------------------------------------------------------------------------------

revoke all on public.predictions, public.results, public.scores from anon, authenticated;
grant select on public.predictions, public.results, public.scores to authenticated;

revoke all on public.leaderboard from anon, authenticated;
grant select on public.leaderboard to authenticated;

revoke all on function public.jarr(jsonb, text)                                from public, anon, authenticated;
revoke all on function public.picks_array(jsonb, text, integer)                from public, anon, authenticated;
revoke all on function public.check_drivers(text[], integer, boolean)          from public, anon, authenticated;
revoke all on function public.validate_session_data(text, jsonb, integer, boolean) from public, anon, authenticated;
revoke all on function public.calc_points(text, jsonb, jsonb)                  from public, anon, authenticated;
revoke all on function public.enter_result(text, jsonb, text)                  from public, anon, authenticated;
revoke all on function public.submit_prediction(text, jsonb)                   from public, anon;

grant execute on function public.jarr(jsonb, text)                                to service_role;
grant execute on function public.picks_array(jsonb, text, integer)                to service_role;
grant execute on function public.check_drivers(text[], integer, boolean)          to service_role;
grant execute on function public.validate_session_data(text, jsonb, integer, boolean) to service_role;
grant execute on function public.calc_points(text, jsonb, jsonb)                  to service_role;
grant execute on function public.enter_result(text, jsonb, text)                  to service_role;
grant execute on function public.submit_prediction(text, jsonb)                   to authenticated;

-- Realtime: the dropped table must be re-added.
alter publication supabase_realtime add table public.scores;

-- Practice data: a full 22-driver grid and fresh session times ----------------------------------

insert into public.drivers (id, season, code, full_name, team_name) values
  ('practice-i', 9999, 'PRI', 'Practice Driver I', 'Practice Team 5'),
  ('practice-j', 9999, 'PRJ', 'Practice Driver J', 'Practice Team 5'),
  ('practice-k', 9999, 'PRK', 'Practice Driver K', 'Practice Team 6'),
  ('practice-l', 9999, 'PRL', 'Practice Driver L', 'Practice Team 6'),
  ('practice-m', 9999, 'PRM', 'Practice Driver M', 'Practice Team 7'),
  ('practice-n', 9999, 'PRN', 'Practice Driver N', 'Practice Team 7'),
  ('practice-o', 9999, 'PRO', 'Practice Driver O', 'Practice Team 8'),
  ('practice-p', 9999, 'PRP', 'Practice Driver P', 'Practice Team 8'),
  ('practice-q', 9999, 'PRQ', 'Practice Driver Q', 'Practice Team 9'),
  ('practice-r', 9999, 'PRR', 'Practice Driver R', 'Practice Team 9'),
  ('practice-s', 9999, 'PRS', 'Practice Driver S', 'Practice Team 10'),
  ('practice-t', 9999, 'PRT', 'Practice Driver T', 'Practice Team 10'),
  ('practice-u', 9999, 'PRU', 'Practice Driver U', 'Practice Team 11'),
  ('practice-v', 9999, 'PRV', 'Practice Driver V', 'Practice Team 11')
on conflict (id) do nothing;

update public.sessions set start_utc = now() + interval '7 days'
  where id = 'practice-event-qualifying';
update public.sessions set start_utc = now() + interval '6 days'
  where id = 'practice-event-sprint_qualifying';
