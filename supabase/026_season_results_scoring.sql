-- 026: Season-long predictions, part 2: official season results, scoring, rescoring and admin tools.
-- Additive, plus one change: admin_set_season_prediction (from 025) now also rescores when a season
-- result is already approved. Nothing here touches scores, leaderboard, player_xp or session scoring:
-- season points live in season_scores and are NOT in any total yet (that is a later step).
-- Run once in the Supabase SQL Editor, after 025.
--
-- To undo (re-run 025's version of admin_set_season_prediction afterwards if you want the old body):
--   drop function if exists public.admin_season_overview();
--   drop function if exists public.admin_reject_season_result(uuid);
--   drop function if exists public.admin_approve_season_result(uuid);
--   drop function if exists public.admin_save_season_result(integer, text[], text[]);
--   drop function if exists public.recalculate_season_scores(integer);
--   drop function if exists public.calc_season_points(text, text, boolean, text[], text[]);
--   drop table if exists public.season_scores;
--   drop table if exists public.season_results;

-- 1) The official final standings of a season (top 3 drivers and top 3 constructors), versioned like results.
create table public.season_results (
  id                uuid primary key default gen_random_uuid(),
  season            integer not null,
  version           integer not null,
  status            text not null default 'pending'
                    check (status in ('pending', 'approved', 'superseded', 'rejected')),
  drivers_top3      text[] not null check (cardinality(drivers_top3) = 3),
  constructors_top3 text[] not null check (cardinality(constructors_top3) = 3),
  source            text not null default 'manual',
  entered_by        uuid references auth.users (id) on delete set null,
  entered_at        timestamptz not null default now(),
  approved_at       timestamptz,
  approved_by       uuid references auth.users (id) on delete set null,
  unique (season, version)
);
-- Only one approved result per season at any time.
create unique index season_results_one_approved on public.season_results (season) where status = 'approved';

alter table public.season_results enable row level security;

create policy "group members read approved season results"
  on public.season_results for select to authenticated
  using (
    status = 'approved'
    and exists (select 1 from public.group_members gm where gm.user_id = auth.uid())
  );

revoke all on public.season_results from anon, authenticated;
grant select on public.season_results to authenticated;

-- 2) Season points per player. Rebuilt from the approved result and the picks by recalculate_season_scores().
create table public.season_scores (
  user_id      uuid not null references auth.users (id) on delete cascade,
  season       integer not null,
  result_id    uuid not null references public.season_results (id) on delete cascade,
  points       integer not null check (points >= 0),
  breakdown    jsonb not null,
  computed_at  timestamptz not null default now(),
  primary key (user_id, season)
);
create index season_scores_season_idx on public.season_scores (season);

alter table public.season_scores enable row level security;

create policy "read own and group-mates season scores"
  on public.season_scores for select to authenticated
  using (user_id = auth.uid() or public.shares_group_with(user_id));

revoke all on public.season_scores from anon, authenticated;
grant select on public.season_scores to authenticated;

-- 3) The scoring rule (pure function).
--    Drivers' champion pick: 60 if 1st, 20 if 2nd, 10 if 3rd.
--    Constructors' champion pick: 40 if 1st, 15 if 2nd, 8 if 3rd.
--    +10 if both picks finished 1st. A half-value (late) entry gets half of the total, rounded down.
create function public.calc_season_points(
  p_driver text, p_team text, p_half boolean, p_drivers text[], p_teams text[]
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_dpos    integer := array_position(p_drivers, p_driver);
  v_cpos    integer := array_position(p_teams, p_team);
  v_d       integer;
  v_c       integer;
  v_bonus   integer;
  v_sub     integer;
begin
  v_d := case v_dpos when 1 then 60 when 2 then 20 when 3 then 10 else 0 end;
  v_c := case v_cpos when 1 then 40 when 2 then 15 when 3 then 8 else 0 end;
  v_bonus := case when v_dpos = 1 and v_cpos = 1 then 10 else 0 end;
  v_sub := v_d + v_c + v_bonus;
  return jsonb_build_object(
    'drivers', v_d,
    'constructors', v_c,
    'double', v_bonus,
    'subtotal', v_sub,
    'half', coalesce(p_half, false),
    'total', case when coalesce(p_half, false) then v_sub / 2 else v_sub end
  );
end;
$$;

revoke all on function public.calc_season_points(text, text, boolean, text[], text[]) from public, anon, authenticated;
grant execute on function public.calc_season_points(text, text, boolean, text[], text[]) to service_role;

-- 4) Rebuild every season score of one season from its approved result and the picks.
create function public.recalculate_season_scores(p_season integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.season_scores where season = p_season;

  insert into public.season_scores (user_id, season, result_id, points, breakdown)
  select sp.user_id, sp.season, r.id, (c.j ->> 'total')::integer, c.j
  from public.season_predictions sp
  join public.season_results r on r.season = sp.season and r.status = 'approved'
  cross join lateral (
    select public.calc_season_points(sp.drivers_pick, sp.constructors_pick, sp.half_value,
                                     r.drivers_top3, r.constructors_top3) as j
  ) c
  where sp.season = p_season;
end;
$$;

revoke all on function public.recalculate_season_scores(integer) from public, anon, authenticated;
grant execute on function public.recalculate_season_scores(integer) to service_role;

-- 5) Admin: enter or edit the season result. Always saves a NEW pending version; nothing is lost.
create function public.admin_save_season_result(p_season integer, p_drivers text[], p_teams text[])
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version integer;
  v_id      uuid;
begin
  if not public.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  if not exists (select 1 from public.events e where e.season = p_season) then
    raise exception 'Unknown season' using errcode = '22023';
  end if;
  if p_drivers is null or p_teams is null or cardinality(p_drivers) <> 3 or cardinality(p_teams) <> 3
     or exists (select 1 from unnest(p_drivers) x where x is null)
     or exists (select 1 from unnest(p_teams) x where x is null) then
    raise exception 'Give exactly three drivers and three teams' using errcode = '22023';
  end if;
  if (select count(distinct x) from unnest(p_drivers) x) <> 3
     or (select count(distinct x) from unnest(p_teams) x) <> 3 then
    raise exception 'Each position needs a different driver and a different team' using errcode = '22023';
  end if;
  if (select count(*) from public.drivers d where d.season = p_season and d.id = any (p_drivers)) <> 3 then
    raise exception 'Unknown driver for this season' using errcode = '22023';
  end if;
  if (select count(distinct d.team_name) from public.drivers d where d.season = p_season and d.team_name = any (p_teams)) <> 3 then
    raise exception 'Unknown team for this season' using errcode = '22023';
  end if;

  select coalesce(max(r.version), 0) + 1 into v_version from public.season_results r where r.season = p_season;

  insert into public.season_results (season, version, status, drivers_top3, constructors_top3, entered_by)
  values (p_season, v_version, 'pending', p_drivers, p_teams, auth.uid())
  returning id into v_id;

  -- An older pending version is replaced by this one.
  update public.season_results set status = 'superseded'
   where season = p_season and status = 'pending' and id <> v_id;

  return v_id;
end;
$$;

-- 6) Admin: approve a pending season result and rescore. Only once every pick window of the season is closed.
create function public.admin_approve_season_result(p_result_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_season  integer;
  v_version integer;
  v_closed  boolean;
begin
  if not public.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;

  select r.season, r.version into v_season, v_version
  from public.season_results r where r.id = p_result_id and r.status = 'pending';
  if v_season is null then
    raise exception 'Season result not found or not pending' using errcode = '22023';
  end if;

  select (w.lock_at is not null and not w.is_open and not w.late_open) into v_closed
  from public.season_prediction_windows w where w.season = v_season;
  if not coalesce(v_closed, false) then
    raise exception 'Cannot approve: season picks are still open' using errcode = '55000';
  end if;

  update public.season_results set status = 'superseded'
   where season = v_season and id <> p_result_id and status in ('approved', 'pending') and version < v_version;

  update public.season_results set status = 'approved', approved_at = now(), approved_by = auth.uid()
   where id = p_result_id;

  perform public.recalculate_season_scores(v_season);
end;
$$;

-- 7) Admin: reject a pending season result.
create function public.admin_reject_season_result(p_result_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  update public.season_results set status = 'rejected' where id = p_result_id and status = 'pending';
  if not found then
    raise exception 'Season result not found or not pending' using errcode = '22023';
  end if;
end;
$$;

-- 8) Everything the admin screen needs, in one call: per season with picks or a result.
create function public.admin_season_overview()
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.season desc)
    from (
      select
        w.season,
        w.lock_at,
        w.late_lock_at,
        (w.lock_at is not null and not w.is_open and not w.late_open) as closed,
        (select count(*) from public.season_predictions sp where sp.season = w.season) as picks_count,
        coalesce((
          select jsonb_agg(jsonb_build_object(
                   'user_id', sp.user_id, 'name', pf.display_name,
                   'drivers_pick', sp.drivers_pick, 'constructors_pick', sp.constructors_pick,
                   'half_value', sp.half_value, 'points', ss.points)
                 order by pf.display_name)
          from public.season_predictions sp
          join public.profiles pf on pf.id = sp.user_id
          left join public.season_scores ss on ss.user_id = sp.user_id and ss.season = sp.season
          where sp.season = w.season
        ), '[]'::jsonb) as picks,
        coalesce((
          select jsonb_agg(pf.display_name order by pf.display_name)
          from public.group_members gm
          join public.profiles pf on pf.id = gm.user_id
          where not exists (
            select 1 from public.season_predictions sp where sp.user_id = gm.user_id and sp.season = w.season
          )
        ), '[]'::jsonb) as missing,
        (
          select to_jsonb(p) from (
            select r.id, r.version, r.drivers_top3 as drivers, r.constructors_top3 as teams, r.entered_at,
                   coalesce((
                     select jsonb_agg(jsonb_build_object(
                              'name', pf.display_name,
                              'points', (public.calc_season_points(sp.drivers_pick, sp.constructors_pick, sp.half_value,
                                                                   r.drivers_top3, r.constructors_top3) ->> 'total')::integer)
                            order by pf.display_name)
                     from public.season_predictions sp
                     join public.profiles pf on pf.id = sp.user_id
                     where sp.season = w.season
                   ), '[]'::jsonb) as preview
            from public.season_results r
            where r.season = w.season and r.status = 'pending'
            order by r.version desc
            limit 1
          ) p
        ) as pending,
        (
          select to_jsonb(a) from (
            select r.id, r.version, r.drivers_top3 as drivers, r.constructors_top3 as teams, r.approved_at,
                   (select pf.display_name from public.profiles pf where pf.id = r.approved_by) as approved_by_name
            from public.season_results r
            where r.season = w.season and r.status = 'approved'
          ) a
        ) as approved
      from public.season_prediction_windows w
      where exists (select 1 from public.season_predictions sp where sp.season = w.season)
         or exists (select 1 from public.season_results r where r.season = w.season)
    ) x
  ), '[]'::jsonb);
end;
$$;

-- 9) Admin overrides of a player's picks now rescore automatically when a result is already approved.
create or replace function public.admin_set_season_prediction(
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

  -- If the season result is already approved, the change takes effect on the points straight away.
  if exists (select 1 from public.season_results r where r.season = p_season and r.status = 'approved') then
    perform public.recalculate_season_scores(p_season);
  end if;
end;
$$;

-- 10) Privileges: signed-in users can call these; each one checks is_admin() itself.
revoke all on function public.admin_save_season_result(integer, text[], text[]) from public, anon;
revoke all on function public.admin_approve_season_result(uuid) from public, anon;
revoke all on function public.admin_reject_season_result(uuid) from public, anon;
revoke all on function public.admin_season_overview() from public, anon;
grant execute on function public.admin_save_season_result(integer, text[], text[]) to authenticated;
grant execute on function public.admin_approve_season_result(uuid) to authenticated;
grant execute on function public.admin_reject_season_result(uuid) to authenticated;
grant execute on function public.admin_season_overview() to authenticated;

notify pgrst, 'reload schema';