-- 025: Season-long predictions, part 1: tables, window view, save function, admin override.
-- Additive only. Nothing here touches scoring, scores, leaderboard, player_xp or any existing function.
-- Season picks give no points yet: points arrive with the season result in a later migration.
-- Run once in the Supabase SQL Editor.
--
-- To undo:
--   drop function if exists public.admin_set_season_prediction(uuid, integer, text, text, text);
--   drop function if exists public.submit_season_prediction(integer, text, text);
--   drop table if exists public.season_prediction_log;
--   drop table if exists public.season_predictions;
--   drop function if exists public.season_picks_closed(integer, boolean);
--   drop view if exists public.season_prediction_windows;

-- 1) When season picks open and close, per season (the single source for every rule below).
--    lock_at       = start of the earliest Round 1 session. Picks close then.
--    late_lock_at  = start of the earliest Round 5 session. Players who joined the group AFTER lock_at
--                    may pick until then, at half value.
--    A time counts only when EVERY session of that round has a start time, so a missing qualifying
--    time can never make the window last longer than it should.
create or replace view public.season_prediction_windows
with (security_invoker = true) as
with seasons as (
  select distinct e.season from public.events e
),
r1 as (
  select e.season,
         case when bool_and(s.start_utc is not null) then min(s.start_utc) end as at
  from public.events e
  join public.sessions s on s.event_id = e.id
  where e.round = 1
  group by e.season
),
r5 as (
  select e.season,
         case when bool_and(s.start_utc is not null) then min(s.start_utc) end as at
  from public.events e
  join public.sessions s on s.event_id = e.id
  where e.round = 5
  group by e.season
),
base as (
  select
    se.season,
    r1.at as lock_at,
    r5.at as late_lock_at,
    exists (select 1 from public.drivers d where d.season = se.season and d.is_active) as drivers_loaded
  from seasons se
  left join r1 on r1.season = se.season
  left join r5 on r5.season = se.season
)
select
  b.season,
  b.lock_at,
  b.late_lock_at,
  b.drivers_loaded,
  (b.drivers_loaded and b.lock_at is not null and now() < b.lock_at) as is_open,
  (b.drivers_loaded and b.lock_at is not null and now() >= b.lock_at
     and b.late_lock_at is not null and now() < b.late_lock_at) as late_open
from base b;

revoke all on public.season_prediction_windows from anon, authenticated;
grant select on public.season_prediction_windows to authenticated;

-- 2) Have the picks of a season closed? A normal pick closes at lock_at, a half-value pick at late_lock_at.
create or replace function public.season_picks_closed(p_season integer, p_half boolean)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select coalesce((
    select now() >= case when p_half then w.late_lock_at else w.lock_at end
    from public.season_prediction_windows w
    where w.season = p_season
  ), false);
$$;

revoke all on function public.season_picks_closed(integer, boolean) from public, anon;
grant execute on function public.season_picks_closed(integer, boolean) to authenticated;

-- 3) The picks. Written only through the functions below.
create table public.season_predictions (
  user_id            uuid not null references auth.users (id) on delete cascade,
  season             integer not null,
  drivers_pick       text not null references public.drivers (id),
  constructors_pick  text not null check (char_length(constructors_pick) between 1 and 80),
  half_value         boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (user_id, season)
);
create index season_predictions_season_idx on public.season_predictions (season);

alter table public.season_predictions enable row level security;

-- You always see your own picks. Group-mates' picks appear only after THAT player's window has closed.
create policy "read own season picks, or group-mates after the window closes"
  on public.season_predictions for select to authenticated
  using (
    user_id = auth.uid()
    or (public.shares_group_with(user_id) and public.season_picks_closed(season, half_value))
  );

revoke all on public.season_predictions from anon, authenticated;
grant select on public.season_predictions to authenticated;

-- 4) Audit trail for administrator changes to a player's picks.
create table public.season_prediction_log (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  season      integer not null,
  user_id     uuid not null references auth.users (id) on delete cascade,
  admin_id    uuid references auth.users (id) on delete set null,
  action      text not null check (action in ('set')),
  old_pick    jsonb,
  new_pick    jsonb not null,
  reason      text not null check (char_length(reason) >= 3)
);

alter table public.season_prediction_log enable row level security;

create policy "admins read the season pick log"
  on public.season_prediction_log for select to authenticated
  using (public.is_admin());

revoke all on public.season_prediction_log from anon, authenticated;
grant select on public.season_prediction_log to authenticated;

-- 5) Players save their own picks here (the only player write path).
create function public.submit_season_prediction(p_season integer, p_driver text, p_team text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user    uuid := auth.uid();
  v_joined  timestamptz;
  v_lock    timestamptz;
  v_late    timestamptz;
  v_loaded  boolean;
  v_half    boolean;
begin
  if v_user is null then
    raise exception 'You must be signed in' using errcode = '28000';
  end if;

  select min(gm.joined_at) into v_joined from public.group_members gm where gm.user_id = v_user;
  if v_joined is null then
    raise exception 'Join the friends group before predicting' using errcode = '42501';
  end if;

  if p_driver is null or p_team is null or btrim(p_team) = '' then
    raise exception 'Pick a driver and a team' using errcode = '22023';
  end if;

  select w.lock_at, w.late_lock_at, w.drivers_loaded
    into v_lock, v_late, v_loaded
  from public.season_prediction_windows w
  where w.season = p_season;

  if not found then
    raise exception 'Unknown season' using errcode = '22023';
  end if;
  if not v_loaded or v_lock is null then
    raise exception 'Season predictions are not open yet' using errcode = '55000';
  end if;

  if now() < v_lock then
    v_half := false;
  elsif v_joined >= v_lock and v_late is not null and now() < v_late then
    v_half := true;               -- joined after the main lock: half value until Round 5
  else
    raise exception 'Season predictions are closed' using errcode = '55000';
  end if;

  if not exists (
    select 1 from public.drivers d where d.id = p_driver and d.season = p_season and d.is_active
  ) then
    raise exception 'Unknown or inactive driver for this season' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.drivers d where d.team_name = p_team and d.season = p_season and d.is_active
  ) then
    raise exception 'Unknown team for this season' using errcode = '22023';
  end if;

  insert into public.season_predictions (user_id, season, drivers_pick, constructors_pick, half_value)
  values (v_user, p_season, p_driver, p_team, v_half)
  on conflict (user_id, season) do update set
    drivers_pick      = excluded.drivers_pick,
    constructors_pick = excluded.constructors_pick,
    half_value        = excluded.half_value,
    updated_at        = now();

  return p_season;
end;
$$;

revoke all on function public.submit_season_prediction(integer, text, text) from public, anon;
grant execute on function public.submit_season_prediction(integer, text, text) to authenticated;

-- 6) Administrator override: set a player's picks at any time, with a written reason that is logged.
create function public.admin_set_season_prediction(
  p_user uuid, p_season integer, p_driver text, p_team text, p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lock    timestamptz;
  v_loaded  boolean;
  v_old     public.season_predictions;
  v_half    boolean;
  v_joined  timestamptz;
begin
  if not public.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) < 3 then
    raise exception 'Give a reason for the change' using errcode = '22023';
  end if;

  select min(gm.joined_at) into v_joined from public.group_members gm where gm.user_id = p_user;
  if v_joined is null then
    raise exception 'That player is not in the group' using errcode = '22023';
  end if;

  select w.lock_at, w.drivers_loaded into v_lock, v_loaded
  from public.season_prediction_windows w where w.season = p_season;
  if not found or not v_loaded then
    raise exception 'Unknown season or no drivers loaded' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.drivers d where d.id = p_driver and d.season = p_season and d.is_active
  ) then
    raise exception 'Unknown or inactive driver for this season' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.drivers d where d.team_name = p_team and d.season = p_season and d.is_active
  ) then
    raise exception 'Unknown team for this season' using errcode = '22023';
  end if;

  select * into v_old from public.season_predictions sp where sp.user_id = p_user and sp.season = p_season;

  -- Keep an existing half-value flag; a new row is half value only for a player who joined after the lock.
  v_half := coalesce(v_old.half_value, v_lock is not null and v_joined >= v_lock);

  insert into public.season_predictions (user_id, season, drivers_pick, constructors_pick, half_value)
  values (p_user, p_season, p_driver, p_team, v_half)
  on conflict (user_id, season) do update set
    drivers_pick      = excluded.drivers_pick,
    constructors_pick = excluded.constructors_pick,
    updated_at        = now();

  insert into public.season_prediction_log (season, user_id, admin_id, action, old_pick, new_pick, reason)
  values (
    p_season, p_user, auth.uid(), 'set',
    case when v_old.user_id is null then null
         else jsonb_build_object('drivers_pick', v_old.drivers_pick, 'constructors_pick', v_old.constructors_pick) end,
    jsonb_build_object('drivers_pick', p_driver, 'constructors_pick', p_team),
    btrim(p_reason)
  );
end;
$$;

revoke all on function public.admin_set_season_prediction(uuid, integer, text, text, text) from public, anon;
grant execute on function public.admin_set_season_prediction(uuid, integer, text, text, text) to authenticated;

notify pgrst, 'reload schema';