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
- Not built: achievements, season statistics, accuracy statistics, points progression.

## Weekend recap
- recap-engine.js (pure functions) and recap.js render a "Weekend recap" on the home page (index.html, recap.css):
  winner, podium, climber, best score, notable calls, level-ups. Hidden when the last weekend has no points.

## Front end
Pages: index, account, predict (predict-tiles.js, predict-lights.js), leaderboard (standings.js), admin, picks/scorecard pages.
Old files kept as fallbacks: predict.js, leaderboard.js, next-race.js/css, site-nav.css.
Driver portraits and team logos: placeholders only, no asset pipeline yet.

## Data in the database now
Rehearsal data: season 2026 drivers, event united-states-2026 (completed), mexico-city-2026 (planned),
and any related predictions, results and scores. Remove with supabase/maintenance/remove_rehearsal_weekend.sql
before the 2027 season. 2027: 24 events and 68 sessions, session times null until published. No 2027 drivers yet.

## Unverified (owner to confirm or correct)
- Recap shows correctly on the home page after a real weekend.
- Push reminders arrive on a phone, including iOS installed-app mode.
- Reveal after lock works for every session type in the live site.
- Whether tests exist for migrations 018 to 022 (none found).
- Whether node_modules is ignored by git.

## Outstanding
1. Achievements and season statistics on the profile (next).
2. Season-long predictions: Drivers' and Constructors' champion (plan first, scoring untouched until agreed).
3. Driver photo and team logo asset pipeline (owner supplies the images).
4. Mexico City rehearsal, then run remove_rehearsal_weekend.sql.
5. Real 2027 drivers and session times when published. Check the Gulf races and any calendar change.
6. Tests for migrations 018 to 022. Update this file after each milestone.