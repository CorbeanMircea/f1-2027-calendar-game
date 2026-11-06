-- 024: Achievements (read-only views). No tables, no scoring and no scores are changed.
-- 1) player_session_stats gets two extra columns at the end: session_players and won.
-- 2) player_season_stats: session_wins now follows the same win rule (a win needs 2+ scoring players).
-- 3) New view player_achievements: progress, level, badge step and where each level was earned.
-- Run once in the Supabase SQL Editor.
--
-- To undo completely:
--   drop view if exists public.player_achievements;
--   drop view if exists public.player_event_progress;
--   drop view if exists public.player_season_stats;
--   drop view if exists public.player_session_stats;
-- then run 023_player_stats.sql again.

-- ---------- 1) Session stats, now with session_players and won ----------

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
),
scored as (
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
    rank() over (partition by c.session_id order by c.points desc)::int as session_rank,
    (count(*) over (partition by c.session_id))::int as session_players
  from calc c
  join public.profiles p on p.id = c.user_id
)
select
  s.user_id,
  s.display_name,
  s.session_id,
  s.season,
  s.round,
  s.event_id,
  s.event_name,
  s.session_type,
  s.start_utc,
  s.points,
  s.exact_hits,
  s.exact_slots,
  s.placed_hits,
  s.placed_slots,
  s.perfect,
  s.fastest_lap_hit,
  s.dnf_points,
  s.session_rank,
  s.session_players,
  (s.session_rank = 1 and s.points > 0 and s.session_players >= 2) as won
from scored s;

revoke all on public.player_session_stats from anon, authenticated;
grant select on public.player_session_stats to authenticated;


-- ---------- 2) Season stats: session_wins follows the agreed win rule ----------

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
  (count(*) filter (where ps.won))::int                                      as session_wins,
  (count(*) filter (where ps.fastest_lap_hit))::int                          as fastest_lap_hits,
  coalesce(sum(ps.dnf_points), 0)::int                                       as dnf_points
from public.player_session_stats ps
group by ps.season, ps.user_id, ps.display_name;

revoke all on public.player_season_stats from anon, authenticated;
grant select on public.player_season_stats to authenticated;


-- ---------- 3) Achievements ----------
-- kind 'sum': progress is a running total over rounds (lifetime).
-- kind 'max': progress is the best single value (one race, one weekend, one season, one streak).
-- level = number of levels reached, step = badge step (1 to 4) of the highest level reached.

create or replace view public.player_achievements
with (security_invoker = true) as
with
defs(ach, sort_order, kind) as (
  values
    ('session_winner'::text,     1, 'sum'::text),
    ('weekend_double',           2, 'sum'),
    ('perfect_order',            3, 'sum'),
    ('sharp_eye',                4, 'max'),
    ('fastest_lap_caller',       5, 'sum'),
    ('dnf_oracle',               6, 'max'),
    ('big_weekend',              7, 'max'),
    ('season_points',            8, 'max'),
    ('regular',                  9, 'sum'),
    ('ever_present',            10, 'max'),
    ('leader',                  11, 'sum'),
    ('comeback',                12, 'sum'),
    ('sharp_shooter',           13, 'sum')
),
tiers(ach, tier_no, target, step) as (
  values
    ('session_winner'::text, 1,    1, 1), ('session_winner', 2,    5, 2), ('session_winner', 3,   15, 3), ('session_winner', 4,   40, 4),
    ('weekend_double',       1,    1, 2), ('weekend_double', 2,    3, 3), ('weekend_double', 3,    8, 4),
    ('perfect_order',        1,    1, 3), ('perfect_order',  2,    3, 4),
    ('sharp_eye',            1,    3, 2), ('sharp_eye',      2,    5, 3), ('sharp_eye',      3,    7, 4),
    ('fastest_lap_caller',   1,    1, 1), ('fastest_lap_caller', 2, 5, 2), ('fastest_lap_caller', 3, 10, 3), ('fastest_lap_caller', 4, 20, 4),
    ('dnf_oracle',           1,    8, 2), ('dnf_oracle',     2,   16, 3), ('dnf_oracle',     3,   24, 4),
    ('big_weekend',          1,   50, 2), ('big_weekend',    2,   80, 3), ('big_weekend',    3,  110, 4),
    ('season_points',        1,  250, 1), ('season_points',  2,  500, 2), ('season_points',  3, 1000, 3), ('season_points', 4, 1500, 4),
    ('regular',              1,   10, 1), ('regular',        2,   30, 2), ('regular',        3,   60, 3), ('regular',       4,  120, 4),
    ('ever_present',         1,   10, 2), ('ever_present',   2,   20, 3), ('ever_present',   3,   40, 4),
    ('leader',               1,    1, 2), ('leader',         2,    5, 3), ('leader',         3,   12, 4),
    ('comeback',             1,    1, 2), ('comeback',       2,    3, 3), ('comeback',       3,    6, 4),
    ('sharp_shooter',        1,    1, 2), ('sharp_shooter',  2,    5, 3), ('sharp_shooter',  3,   15, 4)
),

-- Ever-present: the complete sequence of approved sessions in each season.
appr as (
  select
    e.season, e.round, e.name as event_name, s.id as session_id,
    row_number() over (
      partition by e.season
      order by e.round,
        case s.session_type when 'sprint_qualifying' then 1 when 'sprint' then 2 when 'qualifying' then 3 else 4 end
    ) as seq_no
  from public.sessions s
  join public.events e on e.id = s.event_id
  where exists (
    select 1 from public.results r where r.session_id = s.id and r.status = 'approved'
  )
),
ep_players as (
  select distinct season, user_id from public.player_session_stats
),
ep_grid as (
  select a.season, a.round, a.event_name, a.seq_no, p.user_id,
         (ps.session_id is not null) as scored
  from appr a
  join ep_players p on p.season = a.season
  left join public.player_session_stats ps
         on ps.session_id = a.session_id and ps.user_id = p.user_id
),
ep_runs as (
  select g.*,
         sum(case when g.scored then 0 else 1 end)
           over (partition by g.season, g.user_id order by g.seq_no) as brk
  from ep_grid g
),
ep_streak as (
  select r.season, r.round, r.event_name, r.user_id,
         case when r.scored
              then count(*) filter (where r.scored)
                     over (partition by r.season, r.user_id, r.brk order by r.seq_no)
              else 0 end as streak
  from ep_runs r
),

-- One row per player, achievement and round with the value that round contributes.
facts as (
  select ps.user_id, 'session_winner'::text as ach, ps.season, ps.round, ps.event_name, count(*)::int as v
  from public.player_session_stats ps
  where ps.won
  group by ps.user_id, ps.season, ps.round, ps.event_name

  union all
  select ps.user_id, 'weekend_double', ps.season, ps.round, ps.event_name, 1
  from public.player_session_stats ps
  where ps.won and ps.session_type in ('qualifying', 'race')
  group by ps.user_id, ps.season, ps.round, ps.event_name
  having count(distinct ps.session_type) = 2

  union all
  select ps.user_id, 'perfect_order', ps.season, ps.round, ps.event_name, count(*)::int
  from public.player_session_stats ps
  where ps.perfect
  group by ps.user_id, ps.season, ps.round, ps.event_name

  union all
  select ps.user_id, 'sharp_eye', ps.season, ps.round, ps.event_name, max(ps.exact_hits)::int
  from public.player_session_stats ps
  where ps.session_type in ('race', 'sprint')
  group by ps.user_id, ps.season, ps.round, ps.event_name

  union all
  select ps.user_id, 'fastest_lap_caller', ps.season, ps.round, ps.event_name, count(*)::int
  from public.player_session_stats ps
  where ps.fastest_lap_hit
  group by ps.user_id, ps.season, ps.round, ps.event_name

  union all
  select ps.user_id, 'dnf_oracle', ps.season, ps.round, ps.event_name, max(ps.dnf_points)::int
  from public.player_session_stats ps
  where ps.session_type = 'race'
  group by ps.user_id, ps.season, ps.round, ps.event_name

  union all
  select ps.user_id, 'big_weekend', ps.season, ps.round, ps.event_name, sum(ps.points)::int
  from public.player_session_stats ps
  where ps.session_type in ('qualifying', 'race')
  group by ps.user_id, ps.season, ps.round, ps.event_name

  union all
  select pr.user_id, 'season_points', pr.season, pr.round, pr.event_name, pr.cumulative_points
  from public.player_event_progress pr

  union all
  select ps.user_id, 'regular', ps.season, ps.round, ps.event_name, count(*)::int
  from public.player_session_stats ps
  group by ps.user_id, ps.season, ps.round, ps.event_name

  union all
  select es.user_id, 'ever_present', es.season, es.round, es.event_name, max(es.streak)::int
  from ep_streak es
  group by es.user_id, es.season, es.round, es.event_name

  union all
  select x.user_id, 'leader', x.season, x.round, x.event_name, 1
  from (
    select pr.user_id, pr.season, pr.round, pr.event_name, pr.season_rank, pr.cumulative_points,
           count(*) over (partition by pr.season, pr.round) as players
    from public.player_event_progress pr
  ) x
  where x.season_rank = 1 and x.cumulative_points > 0 and x.players >= 3

  union all
  select y.user_id, 'comeback', y.season, y.round, y.event_name, 1
  from (
    select pr.user_id, pr.season, pr.round, pr.event_name, pr.season_rank, pr.sessions_scored,
           lag(pr.season_rank)        over w as prev_rank,
           lag(pr.cumulative_points)  over w as prev_points,
           count(*) over (partition by pr.season, pr.round) as players
    from public.player_event_progress pr
    window w as (partition by pr.season, pr.user_id order by pr.round)
  ) y
  where y.players >= 3
    and y.prev_points > 0
    and y.sessions_scored > 0
    and y.prev_rank - y.season_rank >= 2

  union all
  select ps.user_id, 'sharp_shooter', ps.season, ps.round, ps.event_name, count(*)::int
  from public.player_session_stats ps
  where ps.placed_slots >= 8
    and ps.placed_hits * 100 >= 85 * ps.placed_slots
  group by ps.user_id, ps.season, ps.round, ps.event_name
),

-- Running value after each round: a running total for 'sum', the best so far for 'max'.
run as (
  select f.user_id, f.ach, f.season, f.round, f.event_name,
         case d.kind when 'sum' then sum(f.v) over w else max(f.v) over w end as running
  from facts f
  join defs d on d.ach = f.ach
  window w as (partition by f.user_id, f.ach order by f.season, f.round
               rows between unbounded preceding and current row)
),
plist as (
  select distinct user_id, display_name from public.player_session_stats
),
vals as (
  select f.user_id, f.ach,
         case d.kind when 'sum' then sum(f.v) else max(f.v) end as progress
  from facts f
  join defs d on d.ach = f.ach
  group by f.user_id, f.ach, d.kind
),
cur as (
  select p.user_id, p.display_name, d.ach, d.sort_order, coalesce(v.progress, 0) as progress
  from plist p
  cross join defs d
  left join vals v on v.user_id = p.user_id and v.ach = d.ach
),
graded as (
  select c.*,
    (select count(*) from tiers t where t.ach = c.ach and c.progress >= t.target) as level,
    (select count(*) from tiers t where t.ach = c.ach)                            as max_level,
    (select coalesce(max(t.step), 0) from tiers t where t.ach = c.ach and c.progress >= t.target) as step,
    (select min(t.target) from tiers t where t.ach = c.ach and t.target > c.progress)             as next_target,
    (select t.step from tiers t where t.ach = c.ach and t.target > c.progress order by t.target limit 1) as next_step,
    (select max(t.target) from tiers t where t.ach = c.ach and c.progress >= t.target)            as top_target
  from cur c
)
select
  g.user_id,
  g.display_name,
  g.ach          as achievement,
  g.sort_order,
  g.progress::int as progress,
  g.level::int    as level,
  g.max_level::int as max_level,
  g.step::int     as step,
  g.next_target::int as next_target,
  g.next_step::int   as next_step,
  e.season       as earned_season,
  e.round        as earned_round,
  e.event_name   as earned_event
from graded g
left join lateral (
  select r.season, r.round, r.event_name
  from run r
  where g.top_target is not null
    and r.user_id = g.user_id
    and r.ach = g.ach
    and r.running >= g.top_target
  order by r.season, r.round
  limit 1
) e on true;

revoke all on public.player_achievements from anon, authenticated;
grant select on public.player_achievements to authenticated;

notify pgrst, 'reload schema';