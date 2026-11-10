-- 029: Title Caller achievement (the 14th), added as a separate read-only view on top of player_achievements.
-- player_achievements (migration 024, 13 achievements) is NOT changed. The new view player_achievements_all returns
-- exactly the same columns: the 13 existing rows plus one row per player for title_caller.
--
-- Title Caller: every time a player's Drivers' champion pick or Constructors' champion pick finished 1st in an approved
-- season result, that is one call. Calls add up over seasons; half-value (late) picks count too.
-- Levels: 1 call (badge step II), 2 calls (step III), 4 calls (step IV).
-- Where it was earned: the season, with the season's last round and the label "Season picks".
-- Run once in the Supabase SQL Editor, after 028.
--
-- To undo: drop view if exists public.player_achievements_all;

create or replace view public.player_achievements_all
with (security_invoker = true) as
with calls as (
  select
    ss.user_id,
    ss.season,
    ((sp.drivers_pick = r.drivers_top3[1])::integer + (sp.constructors_pick = r.constructors_top3[1])::integer) as n
  from public.season_scores ss
  join public.season_results r      on r.id = ss.result_id and r.status = 'approved'
  join public.season_predictions sp on sp.user_id = ss.user_id and sp.season = ss.season
),
calls_run as (
  select c.user_id, c.season, sum(c.n) over (partition by c.user_id order by c.season) as running
  from calls c
),
tiers(tier_no, target, step) as (
  values (1, 1, 2), (2, 2, 3), (3, 4, 4)
),
plist as (
  select distinct user_id, display_name from public.player_session_stats
),
tot as (
  select p.user_id, p.display_name, coalesce(sum(c.n), 0)::integer as progress
  from plist p
  left join calls c on c.user_id = p.user_id
  group by p.user_id, p.display_name
),
graded as (
  select t.*,
    (select count(*) from tiers x where t.progress >= x.target)                                         as level,
    (select count(*) from tiers)                                                                          as max_level,
    (select coalesce(max(x.step), 0) from tiers x where t.progress >= x.target)                           as step,
    (select min(x.target) from tiers x where x.target > t.progress)                                       as next_target,
    (select x.step from tiers x where x.target > t.progress order by x.target limit 1)                    as next_step,
    (select max(x.target) from tiers x where t.progress >= x.target)                                      as top_target
  from tot t
)
select
  g.user_id,
  g.display_name,
  'title_caller'::text as achievement,
  14                   as sort_order,
  g.progress           as progress,
  g.level::integer     as level,
  g.max_level::integer as max_level,
  g.step::integer      as step,
  g.next_target::integer as next_target,
  g.next_step::integer   as next_step,
  e.season             as earned_season,
  e.round              as earned_round,
  e.event_name         as earned_event
from graded g
left join lateral (
  select cr.season,
         (select max(ev.round) from public.events ev where ev.season = cr.season) as round,
         'Season picks'::text as event_name
  from calls_run cr
  where g.top_target is not null and cr.user_id = g.user_id and cr.running >= g.top_target
  order by cr.season
  limit 1
) e on true

union all

select a.user_id, a.display_name, a.achievement, a.sort_order, a.progress, a.level, a.max_level, a.step,
       a.next_target, a.next_step, a.earned_season, a.earned_round, a.earned_event
from public.player_achievements a;

revoke all on public.player_achievements_all from anon, authenticated;
grant select on public.player_achievements_all to authenticated;

notify pgrst, 'reload schema';