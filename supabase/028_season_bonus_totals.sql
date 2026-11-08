-- 028: Season bonus in the league totals (database part).
-- Two views are re-created with extra columns at the END, so every page that reads them keeps working:
--   leaderboard: total_points now = session points + season bonus. New columns: session_points, bonus_points.
--   player_xp:   xp now = session XP + season bonus XP (lifetime, all seasons). New columns: session_xp, bonus_xp.
-- Until a season result is approved (migration 026) there are no season scores, so every number stays exactly
-- as it is today. Session statistics, achievements and Season Points are NOT changed: they stay session-based.
-- A player needs at least one scored session in a season to appear on that season's leaderboard.
-- Run once in the Supabase SQL Editor, after 027.
--
-- To undo: run the leaderboard part of 007 and the player_xp part of 019 again
-- (drop view public.leaderboard / public.player_xp first, because the columns change).

create or replace view public.leaderboard
with (security_invoker = true) as
with sess as (
  select
    e.season,
    sc.user_id,
    p.display_name,
    sum(sc.points)::integer as session_points,
    count(*)::integer       as sessions_scored
  from public.scores sc
  join public.sessions s on s.id = sc.session_id
  join public.events   e on e.id = s.event_id
  join public.profiles p on p.id = sc.user_id
  group by e.season, sc.user_id, p.display_name
)
select
  sess.season,
  sess.user_id,
  sess.display_name,
  (sess.session_points + coalesce(b.points, 0))::integer as total_points,
  sess.sessions_scored,
  sess.session_points,
  coalesce(b.points, 0)::integer as bonus_points
from sess
left join public.season_scores b on b.season = sess.season and b.user_id = sess.user_id;

revoke all on public.leaderboard from anon, authenticated;
grant select on public.leaderboard to authenticated;

create or replace view public.player_xp
with (security_invoker = true) as
with s as (
  select
    p.id as user_id,
    p.display_name,
    p.avatar,
    coalesce(sum(sc.points), 0)::integer as session_xp,
    count(sc.session_id)::integer        as sessions_scored,
    coalesce(max(sc.points), 0)::integer as best_session
  from public.profiles p
  left join public.scores sc on sc.user_id = p.id
  group by p.id, p.display_name, p.avatar
),
b as (
  select ss.user_id, sum(ss.points)::integer as bonus_xp
  from public.season_scores ss
  group by ss.user_id
)
select
  s.user_id,
  s.display_name,
  s.avatar,
  (s.session_xp + coalesce(b.bonus_xp, 0))::integer as xp,
  s.sessions_scored,
  s.best_session,
  s.session_xp,
  coalesce(b.bonus_xp, 0)::integer as bonus_xp
from s
left join b on b.user_id = s.user_id;

revoke all on public.player_xp from anon, authenticated;
grant select on public.player_xp to authenticated;

notify pgrst, 'reload schema';