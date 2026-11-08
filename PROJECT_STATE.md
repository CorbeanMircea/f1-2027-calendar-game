# Lights Out (F1 2027 friends league): project state

Plain HTML, CSS and JavaScript on GitHub Pages. Backend: Supabase (Postgres, Auth, Realtime, Edge Functions, pg_cron).
Live site: https://corbeanmircea.github.io/f1-2027-calendar-game/
Last reviewed against the code: 6 Nov 2026 (files and schema read; items under "Unverified" were not confirmed).

## Working rules
- The owner runs every command and every SQL script. Nothing is deployed or changed remotely by the assistant.
- Do not change authentication, prediction saving, deadlines, locking, scoring or the importer without an agreed plan.
- Every milestone leaves the site working, and ends by updating this file.
- Design: dark charcoal and white, restrained red, yellow for primary actions, team colours only for racing data. No gradients, glows or glassmorphism.

## Database (public schema)
Tables: drivers, events, sessions, groups, group_members, profiles (includes avatar), predictions (picks jsonb),
results (versioned, status, data, source, api_snapshot, approved_by), scores (breakdown jsonb), import_log,
push_subscriptions, push_log.
Views: leaderboard (per season), player_xp (lifetime, all seasons), prediction_windows (lock times).
Drivers are one row per driver per season (team_name is plain text), so team changes between seasons already work.
There is no teams table and no season-long prediction table.
Migrations are in supabase/001 to 022; tests exist for 005, 007, 009, 010, 016 and 017 only.

## Scoring (database function calc_points, mirrored in scorecard-engine.js)
Qualifying and sprint qualifying: 1 point per driver in the right group (Q1 out, Q2 out, Q3), +3 for an exact Q3 slot,
+10 if all ten Q3 slots are exact. Maximum 62.
Sprint: top 8, 3 exact, 1 in the top 8 but wrong place, +8 if all eight exact. Maximum 32.
Race: top 8, 5 exact, 2 wrong place, +15 if all eight exact; fastest lap 3; any DNF right 2; number of DNFs exact 5,
off by one 2; DNF drivers (below).
Race maximum: 65 plus 8 per DNF driver picked (73 with one driver, 105 with five).
All predictions are optional. Results are scored only after an admin approves them.

## DNF rules
- A prediction states whether anyone retires, how many (0 to 5 in the new format) and one driver per predicted DNF.
- Each picked DNF driver who really retired scores 4, or 8 if he started in the real top 8 (result field grid_top8).
- A driver cannot be both in your top 8 and a DNF pick. Enforced by validation and by prediction_dnf_ok (migrations 010 and 020).
- Older predictions with the single dnf_driver field stay valid and score as before.
- What counts as a DNF in the importer: status Retired or equivalent. Did not start, disqualified and lapped finishers do not count.

## Deadlines and reveal
- Qualifying and sprint qualifying lock at their own start. Race predictions lock at qualifying start.
  Sprint predictions lock at sprint qualifying start. A session with no known start time stays closed.
- Others' picks become visible only after the lock. Rules are in the predictions read policy (migration 005).
  picks.js and picks-engine.js render the reveal. scorecard.js and scorecard-engine.js explain each score.

## Results pipeline
- Edge function import-results reads the Jolpica API (dry run, pending results, session-time sync). Sprint qualifying
  is derived from the sprint grid and labelled "derived".
- Admin panel (admin.html) approves, rejects, edits, corrects and enters results manually. Edited results keep an api_snapshot.
- pg_cron jobs (all active): import-session-times-daily (06:15 UTC), import-results-every-30-min,
  cleanup-cron-history (03:30 UTC), send-push-reminders-every-15-min.
- A GitHub Actions workflow keeps the Supabase project awake.

## Push reminders
- push_subscriptions: one row per device (endpoint, keys, user, last_ok_at). push_log: one row per device, session and
  kind, so the same reminder is not sent twice.
- RPCs save_push_subscription and remove_push_subscription (authenticated). due_push_reminders is service_role only.
- Edge function send-reminders (cron every 15 minutes, plus task=test for the Send a test button). sw.js shows the
  notification. The public VAPID key is in config.js.
- Messages go about 3 hours and 1 hour before a deadline to players who have not predicted.
- Account page (account-app.js) has the install button, the push switch and the calendar subscription links.
  Signing out removes the device subscription first.
- Calendar feed: edge function calendar-feed (webcal link on the Account page). It has no migration.

## Profile, XP and levels
- profiles.avatar (helmet code) is set only through set_avatar. XP is lifetime points over all seasons (player_xp).
- Level n needs 40 x (n-1)^1.6 XP, cap 50. Seven ranks with badges (lo-profile.js). Level-up banner uses localStorage.
- Account page driver card: avatar picker, XP bar, four numbers (total XP, sessions scored, best session, average),
  rank ladder, last five XP gains. Home standings show avatar and rank badge.
- Statistics views (migration 023, read-only): player_session_stats, player_season_stats, player_event_progress.
  Accuracy is derived from scores.breakdown and the stored pick counts. The Account page does not use them yet (A2).
- Account page Season section (account-stats.js, account-stats.css): points, position, accuracy, points progression
  chart (inline SVG, you vs other players), points and accuracy by session type, highlights, round-by-round table.
  It wraps AccountProfile.render/clear, so account.js and account-profile.js are unchanged.
- Achievements (migration 024, read-only, computed not stored): view player_achievements (13 achievements per player:
  progress, level, badge step, next target, and where the current level was earned). player_session_stats gained
  session_players and won (a win needs rank 1, points above 0 and 2+ scoring players; ties share it) and
  player_season_stats.session_wins follows it. Ever-present uses the full approved session sequence from results
  (status approved), Sharp Shooter needs 8+ predicted slots and 85%+ placed accuracy, Leader and Comeback compare
  positions within a season and accumulate across seasons, Sharp Eye counts exact positions, DNF Oracle uses only
  the dnf_driver points.
- Badge system (A3.2a): lo-achievements.js (13 emblems, steps I to IV, locked outline, plus display definitions),
  achievements.css, and the unlinked design-review page badges.html with badge-sheet.js. No database use.
  The thresholds in lo-achievements.js are for the sheet only; player_achievements is the source of truth.
- Account page Achievements section (A3.2b): account-achievements.js reads player_achievements and draws one card per
  achievement (badge, level, progress bar to the next level, round where the current level was earned) under the Season
  section. A red NEW marker shows for levels gained since the last visit on this device (localStorage key lo-ach-<user id>;
  the first visit on a device stores the current levels silently). It wraps AccountProfile.render like account-stats.js.

## Weekend recap
- recap-engine.js (pure functions) and recap.js render a "Weekend recap" on the home page (index.html, recap.css):
  winner, podium, climber, best score, notable calls, level-ups. Hidden when the last weekend has no points.

## Front end
Pages: index, account, predict (predict-tiles.js, predict-lights.js), leaderboard (standings.js), admin, picks/scorecard pages.
Old files kept as fallbacks: predict.js, leaderboard.js, next-race.js/css, site-nav.css.
Driver portraits and team logos: placeholders only, no asset pipeline yet.

## Data in the database now
2026 season rehearsal data: 22 real 2026 drivers and events united-states-2026 (18), mexico-city-2026 (19),
brazil-2026 (20), las-vegas-2026 (21), qatar-2026 (22), abu-dhabi-2026 (23), each with a qualifying and a race session.
Only qualifying and race sessions exist for these events. Las Vegas, Qatar and Abu Dhabi session times are null until
the daily time sync fills them. Event status is still 'scheduled' for every one, including finished weekends.
Remove all rehearsal data with supabase/maintenance/remove_rehearsal_weekend.sql (check that it covers the four new
events) before the 2027 season. 2027: 24 events and 68 sessions, times null until published. No 2027 drivers yet.

## Unverified (owner to confirm or correct)
- Recap shows correctly on the home page after a real weekend.
- Push reminders arrive on a phone, including iOS installed-app mode.
- Reveal after lock works for every session type in the live site.
- Whether tests exist for migrations 018 to 022 (none found).
- Whether node_modules is ignored by git.

## Season-long predictions (agreed plan, 6 Nov 2026)
- Picks: Drivers' champion and Constructors' champion, one pair per player per season.
- Points (added only after an admin approves the official final standings):
  Drivers' champion: pick finishes 1st 60, 2nd 20, 3rd 10. Constructors' champion: 1st 40, 2nd 15, 3rd 8.
  +10 if both champion picks finish 1st. Maximum 110. A late joiner's points are halved, rounded down.
- Opens when the season's drivers are loaded and every Round 1 session has a start time.
  Closes at the start of the earliest Round 1 session (same UTC rule as session locks).
- Late joiners: a player who joined the group after that lock may pick until the earliest Round 5 session, at half value.
- Group-mates see a player's picks only after that player's own window has closed.
- Season bonus lives in its own tables (never in scores), is added to the leaderboard total and to XP, and does not
  change session statistics, Season Points or the other achievements.
- Admin: can set a player's pick with a written reason (logged), and enters/approves the official season result.
- Milestones: B2.1 tables, save function, window view, RLS, tests (migration 025). B2.2 Season picks card on the
  Predictions page. B2.3 admin entry and approval of the season result, scoring and rescoring. B2.4 leaderboard, XP
  and Season section integration. B2.5 optional Title Caller achievement and picks reveal.
- B2.1 done: migration 025 (season_prediction_windows view, season_predictions and season_prediction_log tables,
  submit_season_prediction and admin_set_season_prediction); behaviour test supabase/tests/025_season_predictions_test.sql
  (ends with an intentional error that rolls back; report ALL OK). Season picks give no points yet.
- B2.2 done: season-picks.js and season-picks.css add a Season picks card to predict.html (waiting, open, late-entry and
  locked states). It reuses the chip styles of predict-ui.css and duplicates the TEAM_COLORS list of predict-tiles.js.
  The form shows only when 2027 drivers and every Round 1 session time exist, so test it with the temporary-data recipe.
- B2.3a done: migration 026 adds season_results (versioned top 3 drivers and top 3 constructors, one approved per season,
  players see only the approved row), season_scores, calc_season_points (60/20/10, 40/15/8, +10 double, half value for
  late entries rounded down), recalculate_season_scores, and admin functions: admin_save_season_result (every save is a
  new pending version), admin_approve_season_result (only once the main and the late pick windows are closed; rescores),
  admin_reject_season_result, admin_season_overview. admin_set_season_prediction now rescores when a result is approved.
  Test: supabase/tests/026_season_results_scoring_test.sql (intentional error, report ALL OK). Season points are NOT in
  the leaderboard, XP or any total yet (B2.4). The admin screen is B2.3b.
  - B2.3b done: admin screen "Season results" in admin.html (admin-season.js, admin-season.css; admin.js untouched).
  Per season with picks or a result: lock status, approved and pending result, points preview, Approve (only once all
  pick windows are closed), Edit, Reject, Enter final standings, players' picks with points, pick override with a
  required reason, and the log of admin pick changes. Migration 027 makes admin_season_overview list players without
  picks as {user_id, name}. Test: supabase/tests/027_admin_season_overview_missing_test.sql.
- Season bonus is still not in the leaderboard, XP or Season section: that is B2.4.

## Outstanding
1. B2.3b admin screen for season results and pick overrides; then B2.4 (leaderboard, XP and Season section include the
   season bonus) and B2.5 (Title Caller achievement, picks reveal).
2. Driver photo and team logo asset pipeline (owner supplies the images).
3. Real 2027 drivers and session times when published. Check the Gulf races and any calendar change.
4. Remove the 2026 rehearsal data with remove_rehearsal_weekend.sql before the 2027 season (check it covers all six events).
5. Tests for migrations 018 to 022. Update this file after each milestone.