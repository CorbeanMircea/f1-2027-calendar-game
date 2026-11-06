-- Read-only checks for migration 024. Every row should say ok = true.

select 'every player has all 13 achievements' as check_name,
  not exists (select 1 from public.player_achievements group by user_id having count(*) <> 13) as ok

union all
select 'level never exceeds max_level, and next_target is empty only at max level',
  not exists (
    select 1 from public.player_achievements
    where level > max_level
       or (level = max_level) <> (next_target is null)
  )

union all
select 'next_target is always above progress; step is 0 only when level is 0',
  not exists (
    select 1 from public.player_achievements
    where (next_target is not null and next_target <= progress)
       or (level = 0) <> (step = 0)
  )

union all
select 'earned info exists exactly when a level is unlocked',
  not exists (
    select 1 from public.player_achievements
    where (level > 0) <> (earned_round is not null)
  )

union all
select 'wins only count in sessions with 2 or more scoring players',
  not exists (select 1 from public.player_session_stats where won and session_players < 2)

union all
select 'season session_wins matches an independent count of the win rule',
  not exists (
    select 1
    from (
      select sc.user_id, e.season,
             count(*) filter (where sc.points > 0 and sc.points = m.top and m.n >= 2) as wins
      from public.scores sc
      join public.sessions s on s.id = sc.session_id
      join public.events e on e.id = s.event_id
      join (select session_id, max(points) as top, count(*) as n from public.scores group by session_id) m
        on m.session_id = sc.session_id
      group by sc.user_id, e.season
    ) x
    join public.player_season_stats st on st.user_id = x.user_id and st.season = x.season
    where st.session_wins <> x.wins
  )

union all
select 'session_winner equals the number of won sessions',
  not exists (
    select 1 from public.player_achievements a
    left join (select user_id, count(*) filter (where won) as v from public.player_session_stats group by user_id) x
      on x.user_id = a.user_id
    where a.achievement = 'session_winner' and a.progress <> coalesce(x.v, 0)
  )

union all
select 'regular equals the number of scored sessions',
  not exists (
    select 1 from public.player_achievements a
    left join (select user_id, count(*) as v from public.player_session_stats group by user_id) x
      on x.user_id = a.user_id
    where a.achievement = 'regular' and a.progress <> coalesce(x.v, 0)
  )

union all
select 'fastest_lap_caller equals the fastest-lap hits',
  not exists (
    select 1 from public.player_achievements a
    left join (select user_id, count(*) filter (where fastest_lap_hit) as v from public.player_session_stats group by user_id) x
      on x.user_id = a.user_id
    where a.achievement = 'fastest_lap_caller' and a.progress <> coalesce(x.v, 0)
  )

union all
select 'perfect_order equals the number of perfect sessions',
  not exists (
    select 1 from public.player_achievements a
    left join (select user_id, count(*) filter (where perfect) as v from public.player_session_stats group by user_id) x
      on x.user_id = a.user_id
    where a.achievement = 'perfect_order' and a.progress <> coalesce(x.v, 0)
  )

union all
select 'season_points equals the best season total',
  not exists (
    select 1 from public.player_achievements a
    left join (select user_id, max(total_points) as v from public.player_season_stats group by user_id) x
      on x.user_id = a.user_id
    where a.achievement = 'season_points' and a.progress <> coalesce(x.v, 0)
  )

union all
select 'sharp_eye is the best exact-position count in one race or sprint',
  not exists (
    select 1 from public.player_achievements a
    left join (
      select user_id, max(exact_hits) as v from public.player_session_stats
      where session_type in ('race', 'sprint') group by user_id
    ) x on x.user_id = a.user_id
    where a.achievement = 'sharp_eye' and a.progress <> coalesce(x.v, 0)
  )

union all
select 'dnf_oracle uses only the DNF-driver points straight from the score breakdown',
  not exists (
    select 1 from public.player_achievements a
    left join (
      select sc.user_id, max(coalesce((sc.breakdown ->> 'dnf_driver')::int, 0)) as v
      from public.scores sc
      join public.sessions s on s.id = sc.session_id
      where s.session_type = 'race'
      group by sc.user_id
    ) x on x.user_id = a.user_id
    where a.achievement = 'dnf_oracle' and a.progress <> coalesce(x.v, 0)
  )

union all
select 'ever_present never exceeds the sessions a player scored or the approved sessions in a season',
  not exists (
    select 1 from public.player_achievements a
    where a.achievement = 'ever_present'
      and (
        a.progress > (select count(*) from public.player_session_stats ps where ps.user_id = a.user_id)
        or a.progress > coalesce((
             select max(c) from (
               select count(*) as c
               from public.sessions s
               join public.events e on e.id = s.event_id
               where exists (select 1 from public.results r where r.session_id = s.id and r.status = 'approved')
               group by e.season
             ) t), 0)
      )
  )

union all
select 'a player who scored every approved session of a season has ever_present at least that long',
  not exists (
    select 1
    from (
      select ps.user_id, ps.season, count(*) as scored_n
      from public.player_session_stats ps group by ps.user_id, ps.season
    ) p
    join (
      select e.season, count(*) as n
      from public.sessions s
      join public.events e on e.id = s.event_id
      where exists (select 1 from public.results r where r.session_id = s.id and r.status = 'approved')
      group by e.season
    ) q on q.season = p.season and q.n = p.scored_n
    join public.player_achievements a on a.user_id = p.user_id and a.achievement = 'ever_present'
    where a.progress < q.n
  )

union all
select 'sharp_shooter never counts a session with fewer than 8 predicted slots or under 85 percent',
  not exists (
    select 1 from public.player_achievements a
    left join (
      select user_id, count(*) as v from public.player_session_stats
      where placed_slots >= 8 and placed_hits * 100 >= 85 * placed_slots group by user_id
    ) x on x.user_id = a.user_id
    where a.achievement = 'sharp_shooter' and a.progress <> coalesce(x.v, 0)
  )

union all
select 'anon cannot read the achievement views',
  not has_table_privilege('anon', 'public.player_achievements', 'select')
  and not has_table_privilege('anon', 'public.player_session_stats', 'select')
  and not has_table_privilege('anon', 'public.player_season_stats', 'select')

union all
select 'signed-in players can read the achievement views',
  has_table_privilege('authenticated', 'public.player_achievements', 'select')
  and has_table_privilege('authenticated', 'public.player_session_stats', 'select')
  and has_table_privilege('authenticated', 'public.player_season_stats', 'select');