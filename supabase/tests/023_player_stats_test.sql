-- Read-only checks for migration 023. Every row should say ok = true.
select 'season totals match the leaderboard' as check_name,
  count(*) = 0 as ok
from public.player_season_stats s
full join public.leaderboard l on l.season = s.season and l.user_id = s.user_id
where s.total_points is distinct from l.total_points
   or s.sessions_scored is distinct from l.sessions_scored
union all
select 'one stats row per score row',
  (select count(*) from public.player_session_stats) = (select count(*) from public.scores)
union all
select 'final running total equals season total',
  count(*) = 0
from (
  select distinct on (p.season, p.user_id) p.season, p.user_id, p.cumulative_points
  from public.player_event_progress p
  order by p.season, p.user_id, p.round desc
) last
join public.player_season_stats s on s.season = last.season and s.user_id = last.user_id
where s.total_points <> last.cumulative_points
union all
select 'exact hits never exceed slots',
  count(*) = 0 from public.player_session_stats where exact_hits > exact_slots
union all
select 'placed hits never exceed slots',
  count(*) = 0 from public.player_session_stats where placed_hits > placed_slots
union all
select 'accuracy is between 0 and 100',
  count(*) = 0 from public.player_season_stats
  where exact_accuracy not between 0 and 100 or placed_accuracy not between 0 and 100
union all
select 'anon cannot read the views',
  not has_table_privilege('anon', 'public.player_season_stats', 'select')
  and not has_table_privilege('anon', 'public.player_session_stats', 'select')
  and not has_table_privilege('anon', 'public.player_event_progress', 'select')
union all
select 'signed-in players can read the views',
  has_table_privilege('authenticated', 'public.player_season_stats', 'select')
  and has_table_privilege('authenticated', 'public.player_session_stats', 'select')
  and has_table_privilege('authenticated', 'public.player_event_progress', 'select');