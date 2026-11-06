-- 023: Player statistics (read-only views). Additive: no tables, no scoring, no existing view is changed.
-- Everything is derived from scores + predictions + sessions + events + profiles.
-- Run once in the Supabase SQL Editor.
--
-- To undo:
--   drop view if exists public.player_event_progress;
--   drop view if exists public.player_season_stats;
--   drop view if exists public.player_session_stats;

create or replace view public.player_session_stats
with (security_invoker = true) as
with base as (
  select
    sc.user_id,
    sc.session_id,
    e.season,
    e.round,
    e.id   as event_id,
    e.name as event_name,
    s.session_type,
    s.start_utc,
    sc.points,
    coalesce((sc.breakdown ->> 'exact')::int, 0)       as b_exact,
    coalesce((sc.breakdown ->> 'in_top8')::int, 0)     as b_near,
    coalesce((sc.breakdown ->> 'group')::int, 0)       as b_group,
    coalesce((sc.breakdown ->> 'bonus')::int, 0)       as b_bonus,
    coalesce((sc.breakdown ->> 'fastest_lap')::int, 0) as b_fl,
    coalesce((sc.breakdown ->> 'dnf_driver')::int, 0)  as b_dnf,
    pd.picks
  from public.scores sc
  join public.sessions s on s.id = sc.session_id
  join public.events e   on e.id = s.event_id
  left join public.predictions pd
         on pd.user_id = sc.user_id and pd.session_id = sc.session_id
),
calc as (
  select
    b.*,
    -- slots the player actually predicted
    case when b.session_type in ('qualifying', 'sprint_qualifying')
      then coalesce(jsonb_array_length(case when jsonb_typeof(b.picks -> 'q3_order') = 'array' then b.picks -> 'q3_order' end), 0)
      else coalesce(jsonb_array_length(case when jsonb_typeof(b.picks -> 'top8') = 'array' then b.picks -> 'top8' end), 0)
    end as exact_slots,
    case when b.session_type in ('qualifying', 'sprint_qualifying')
      then coalesce(jsonb_array_length(case when jsonb_typeof(b.picks -> 'q1_out') = 'array' then b.picks -> 'q1_out' end), 0)
         + coalesce(jsonb_array_length(case when jsonb_typeof(b.picks -> 'q2_out') = 'array' then b.picks -> 'q2_out' end), 0)
         + coalesce(jsonb_array_length(case when jsonb_typeof(b.picks -> 'q3_order') = 'array' then b.picks -> 'q3_order' end), 0)
      else coalesce(jsonb_array_length(case when jsonb_typeof(b.picks -> 'top8') = 'array' then b.picks -> 'top8' end), 0)
    end as placed_slots,
    case b.session_type
      when 'race'   then b.b_exact / 5
      else b.b_exact / 3
    end as exact_hits,
    case b.session_type
      when 'race'   then b.b_exact / 5 + b.b_near / 2
      when 'sprint' then b.b_exact / 3 + b.b_near
      else b.b_group
    end as placed_hits
  from base b
)
select
  c.user_id,
  p.display_name,
  c.session_id,
  c.season,
  c.round,
  c.event_id,
  c.event_name,
  c.session_type,
  c.start_utc,
  c.points,
  c.exact_hits,
  c.exact_slots,
  c.placed_hits,
  c.placed_slots,
  (c.b_bonus > 0) as perfect,
  case when c.session_type = 'race' then (c.b_fl > 0) end as fastest_lap_hit,
  c.b_dnf as dnf_points,
  rank() over (partition by c.session_id order by c.points desc)::int as session_rank
from calc c
join public.profiles p on p.id = c.user_id;

revoke all on public.player_session_stats from anon, authenticated;
grant select on public.player_session_stats to authenticated;


create or replace view public.player_season_stats
with (security_invoker = true) as
select
  ps.season,
  ps.user_id,
  ps.display_name,
  sum(ps.points)::int                                         as total_points,
  count(*)::int                                               as sessions_scored,
  max(ps.points)::int                                         as best_session,
  round(avg(ps.points), 1)                                    as avg_points,
  rank() over (partition by ps.season order by sum(ps.points) desc)::int as season_rank,

  coalesce(sum(ps.points) filter (where ps.session_type in ('qualifying', 'sprint_qualifying')), 0)::int as points_qualifying,
  coalesce(sum(ps.points) filter (where ps.session_type = 'race'), 0)::int   as points_race,
  coalesce(sum(ps.points) filter (where ps.session_type = 'sprint'), 0)::int as points_sprint,
  (count(*) filter (where ps.session_type in ('qualifying', 'sprint_qualifying')))::int as sessions_qualifying,
  (count(*) filter (where ps.session_type = 'race'))::int   as sessions_race,
  (count(*) filter (where ps.session_type = 'sprint'))::int as sessions_sprint,

  coalesce(sum(ps.exact_hits), 0)::int  as exact_hits,
  coalesce(sum(ps.exact_slots), 0)::int as exact_slots,
  round(100.0 * sum(ps.exact_hits) / nullif(sum(ps.exact_slots), 0), 1) as exact_accuracy,
  coalesce(sum(ps.placed_hits), 0)::int  as placed_hits,
  coalesce(sum(ps.placed_slots), 0)::int as placed_slots,
  round(100.0 * sum(ps.placed_hits) / nullif(sum(ps.placed_slots), 0), 1) as placed_accuracy,
  round(100.0 * sum(ps.placed_hits) filter (where ps.session_type in ('qualifying', 'sprint_qualifying'))
        / nullif(sum(ps.placed_slots) filter (where ps.session_type in ('qualifying', 'sprint_qualifying')), 0), 1) as accuracy_qualifying,
  round(100.0 * sum(ps.placed_hits) filter (where ps.session_type = 'race')
        / nullif(sum(ps.placed_slots) filter (where ps.session_type = 'race'), 0), 1) as accuracy_race,
  round(100.0 * sum(ps.placed_hits) filter (where ps.session_type = 'sprint')
        / nullif(sum(ps.placed_slots) filter (where ps.session_type = 'sprint'), 0), 1) as accuracy_sprint,

  (count(*) filter (where ps.perfect))::int                                  as perfect_orders,
  (count(*) filter (where ps.session_rank = 1 and ps.points > 0))::int       as session_wins,
  (count(*) filter (where ps.fastest_lap_hit))::int                          as fastest_lap_hits,
  coalesce(sum(ps.dnf_points), 0)::int                                       as dnf_points
from public.player_session_stats ps
group by ps.season, ps.user_id, ps.display_name;

revoke all on public.player_season_stats from anon, authenticated;
grant select on public.player_season_stats to authenticated;


create or replace view public.player_event_progress
with (security_invoker = true) as
with ev as (
  select ps.season, ps.round, ps.event_id, ps.event_name, ps.user_id,
         sum(ps.points)::int as event_points,
         count(*)::int       as sessions
  from public.player_session_stats ps
  group by ps.season, ps.round, ps.event_id, ps.event_name, ps.user_id
),
players as (select distinct season, user_id from ev),
rounds  as (select distinct season, round, event_id, event_name from ev),
grid as (
  select r.season, r.round, r.event_id, r.event_name, pl.user_id,
         coalesce(ev.event_points, 0) as event_points,
         coalesce(ev.sessions, 0)     as sessions
  from rounds r
  join players pl on pl.season = r.season
  left join ev on ev.season = r.season and ev.round = r.round and ev.user_id = pl.user_id
),
cum as (
  select g.*,
         sum(g.event_points) over (partition by g.season, g.user_id order by g.round)::int as cumulative_points
  from grid g
)
select
  c.season, c.round, c.event_id, c.event_name, c.user_id, p.display_name,
  c.event_points, c.sessions as sessions_scored, c.cumulative_points,
  rank() over (partition by c.season, c.round order by c.cumulative_points desc)::int as season_rank
from cum c
join public.profiles p on p.id = c.user_id;

revoke all on public.player_event_progress from anon, authenticated;
grant select on public.player_event_progress to authenticated;

notify pgrst, 'reload schema';