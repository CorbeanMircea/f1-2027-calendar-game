-- 007: Results (with admin approval), scoring, scores, and the leaderboard view.

-- Tables ---------------------------------------------------------------

create table public.results (
  id           uuid primary key default gen_random_uuid(),
  session_id   text not null references public.sessions (id) on delete cascade,
  version      integer not null,
  status       text not null default 'pending'
               check (status in ('pending', 'approved', 'superseded')),
  p1           text not null references public.drivers (id),
  p2           text not null references public.drivers (id),
  p3           text not null references public.drivers (id),
  p4           text references public.drivers (id),
  p5           text references public.drivers (id),
  pole         text references public.drivers (id),
  fastest_lap  text references public.drivers (id),
  source       text not null default 'manual',
  entered_at   timestamptz not null default now(),
  approved_at  timestamptz,
  approved_by  uuid references auth.users (id),
  unique (session_id, version)
);
-- Only one approved result per session at any time.
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

alter table public.results enable row level security;
alter table public.scores  enable row level security;

-- Pure scoring function -------------------------------------------------------

create function public.calc_points(
  p_type          text,
  p_pred          text[],
  p_pole          text,
  p_fastest_lap   text,
  p_actual        text[],
  p_actual_pole   text,
  p_actual_fl     text
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  n          integer := cardinality(p_actual);
  exact_pts  integer;
  near_pts   integer;
  bonus_pts  integer;
  exact_n    integer := 0;
  near_n     integer := 0;
  pole_pts   integer := 0;
  fl_pts     integer := 0;
  bonus      integer := 0;
  i          integer;
begin
  if p_type = 'race' then
    exact_pts := 5; near_pts := 2; bonus_pts := 10;
  else
    exact_pts := 3; near_pts := 1; bonus_pts := 3;
  end if;

  for i in 1 .. n loop
    if p_pred[i] = p_actual[i] then
      exact_n := exact_n + 1;
    elsif p_pred[i] = any (p_actual) then
      near_n := near_n + 1;
    end if;
  end loop;

  if exact_n = n then
    bonus := bonus_pts;
  end if;

  if p_type = 'race' then
    if p_pole is not null and p_pole = p_actual_pole then pole_pts := 3; end if;
    if p_fastest_lap is not null and p_fastest_lap = p_actual_fl then fl_pts := 3; end if;
  end if;

  return jsonb_build_object(
    'exact',       exact_n * exact_pts,
    'in_top',      near_n * near_pts,
    'pole',        pole_pts,
    'fastest_lap', fl_pts,
    'bonus',       bonus,
    'total',       exact_n * exact_pts + near_n * near_pts + pole_pts + fl_pts + bonus
  );
end;
$$;

-- Recalculate every score for one session from its approved result ------------

create function public.recalculate_scores(p_session_id text)
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
    select public.calc_points(
      s.session_type,
      case when s.session_type = 'race'
           then array[p.p1, p.p2, p.p3, p.p4, p.p5]
           else array[p.p1, p.p2, p.p3] end,
      p.pole,
      p.fastest_lap,
      case when s.session_type = 'race'
           then array[r.p1, r.p2, r.p3, r.p4, r.p5]
           else array[r.p1, r.p2, r.p3] end,
      r.pole,
      r.fastest_lap
    ) as j
  ) c
  where p.session_id = p_session_id;
end;
$$;

-- Admin function: enter a new (pending) result version ---------------------------

create function public.enter_result(
  p_session_id   text,
  p_p1           text,
  p_p2           text,
  p_p3           text,
  p_p4           text default null,
  p_p5           text default null,
  p_pole         text default null,
  p_fastest_lap  text default null,
  p_source       text default 'manual'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type     text;
  v_version  integer;
  v_id       uuid;
  v_top      text[];
begin
  select session_type into v_type
  from public.sessions
  where id = p_session_id and session_type in ('race', 'sprint');

  if v_type is null then
    raise exception 'Unknown session';
  end if;

  if v_type = 'sprint' then
    if p_p4 is not null or p_p5 is not null or p_pole is not null or p_fastest_lap is not null then
      raise exception 'A sprint result has only three positions';
    end if;
    v_top := array[p_p1, p_p2, p_p3];
  else
    if p_p4 is null or p_p5 is null or p_pole is null or p_fastest_lap is null then
      raise exception 'A race result needs five positions, pole and fastest lap';
    end if;
    v_top := array[p_p1, p_p2, p_p3, p_p4, p_p5];
  end if;

  if array_position(v_top, null) is not null then
    raise exception 'Missing finishing position';
  end if;
  if (select count(distinct x) from unnest(v_top) as x) <> cardinality(v_top) then
    raise exception 'Each position needs a different driver';
  end if;

  select coalesce(max(version), 0) + 1 into v_version
  from public.results where session_id = p_session_id;

  insert into public.results
    (session_id, version, status, p1, p2, p3, p4, p5, pole, fastest_lap, source)
  values
    (p_session_id, v_version, 'pending', p_p1, p_p2, p_p3, p_p4, p_p5, p_pole, p_fastest_lap, p_source)
  returning id into v_id;

  return v_id;
end;
$$;

-- Admin function: approve a pending result and recalculate scores -------------------

create function public.approve_result(p_result_id uuid, p_approved_by uuid default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session  text;
  v_version  integer;
begin
  select session_id, version into v_session, v_version
  from public.results
  where id = p_result_id and status = 'pending';

  if v_session is null then
    raise exception 'Result not found or not pending';
  end if;

  if not public.is_prediction_locked(v_session) then
    raise exception 'Cannot approve: predictions are still open for this session';
  end if;

  -- Retire the previously approved result (and older pending ones), then approve this one.
  update public.results
     set status = 'superseded'
   where session_id = v_session
     and id <> p_result_id
     and status in ('approved', 'pending')
     and version < v_version;

  update public.results
     set status = 'approved', approved_at = now(), approved_by = p_approved_by
   where id = p_result_id;

  perform public.recalculate_scores(v_session);
end;
$$;

-- Read policies ---------------------------------------------------------------

create policy "group members read approved results"
  on public.results for select to authenticated
  using (
    status = 'approved'
    and exists (select 1 from public.group_members gm where gm.user_id = auth.uid())
  );

create policy "read own and group-mates scores"
  on public.scores for select to authenticated
  using (user_id = auth.uid() or public.shares_group_with(user_id));

-- Leaderboard view (uses the caller's access, so it only shows group-mates) ---------

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

-- Privileges ---------------------------------------------------------------

revoke all on public.results, public.scores from anon, authenticated;
grant select on public.results, public.scores to authenticated;

revoke all on public.leaderboard from anon, authenticated;
grant select on public.leaderboard to authenticated;

revoke all on function public.calc_points(text, text[], text, text, text[], text, text)
  from public, anon, authenticated;
revoke all on function public.recalculate_scores(text) from public, anon, authenticated;
revoke all on function public.enter_result(text, text, text, text, text, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.approve_result(uuid, uuid) from public, anon, authenticated;

grant execute on function public.calc_points(text, text[], text, text, text[], text, text) to service_role;
grant execute on function public.recalculate_scores(text) to service_role;
grant execute on function public.enter_result(text, text, text, text, text, text, text, text, text) to service_role;
grant execute on function public.approve_result(uuid, uuid) to service_role;
