# Lights Out (F1 2027 friends league): project state

Plain HTML, CSS and JavaScript on GitHub Pages. Backend: Supabase (Postgres, Auth, Realtime, Edge Functions, pg_cron).
Live site: https://corbeanmircea.github.io/f1-2027-calendar-game/
Last reviewed against the code: 19 Nov 2026, commit dae9122 (files, migrations and edge functions read; nothing was run).
Owner-verified: the owner reports checking all features manually on 19 Nov 2026. There are no automated tests for
migrations 018 to 022 and 030 to 037. Live database definitions were not re-read for this review.

## Working rules
- The owner runs every command and every SQL script. Nothing is deployed or changed remotely by the assistant.
- Do not change authentication, prediction saving, deadlines, locking, scoring or the importer without an agreed plan.
- Every milestone leaves the site working, and ends by updating this file.
- Design: dark charcoal and white, restrained red, yellow for primary actions, team colours only for racing data. No gradients, glows or glassmorphism.
- Deliver complete files with exact paths; small milestones; wait for confirmation after each.

## Phase names used in commits (they overlap, read the date)
- Milestones 1 to 18: the original build (site, Supabase, predictions, scoring, importer, admin, design).
- A1, A2, A3.x (6 Nov): player statistics and achievements.
- B1, B2.1 to B2.5 (6 to 10 Nov): season-long predictions and Title Caller.
- M1 to M6 (11 to 15 Nov): driver lineup, substitutions, prediction form, grid penalties, notices, prediction corrections.
- R1 (16 Nov): predictions page shell, event theming, access gate.
- "Redesign phase A1 / A3" (18 Nov): Account page layout. Not the same as the statistics A1 and A3 above.
- H1 onwards (19 Nov): housekeeping.

## Database (public schema), migrations 001 to 037 in supabase/
Core tables: drivers, events, sessions, groups, group_members, profiles (includes avatar), predictions (picks jsonb),
results (versioned, status, data, source, api_snapshot, approved_by), scores (breakdown jsonb), import_log,
push_subscriptions, push_log.
Season tables (025, 026): season_predictions, season_prediction_log, season_results, season_scores.
Change tables (030 to 037): driver_substitutions, driver_substitution_sessions, grid_penalties, prediction_corrections
(all four append-only: a trigger blocks update and delete), player_notifications, push_notice_log.
Views: leaderboard (per season, includes the season bonus), player_xp (lifetime, includes the bonus), prediction_windows,
season_prediction_windows, player_session_stats, player_season_stats, player_event_progress, player_achievements,
player_achievements_all.
Drivers are one row per driver per season (team_name is plain text). There is no teams table.
Tests exist in supabase/tests for 005, 007, 009, 010, 016, 017 and 023 to 029. None for 018 to 022 or 030 to 037.
Rollback scripts for 030, 031, 033, 034, 035, 036 and 037 are in supabase/maintenance; they must be run in reverse order
(037 first). maintenance/test_031_rollback_only.sql and test_037_rollback_only.sql are optional scenario checks that end
with an intentional error so nothing is saved.
Every function listed below for 030 to 037 is SECURITY DEFINER with an empty search_path; the admin functions check is_admin().

## Scoring (database function calc_points, mirrored in scorecard-engine.js)
Qualifying and sprint qualifying: 1 point per driver in the right group (Q1 out, Q2 out, Q3), +3 for an exact Q3 slot,
+10 if all ten Q3 slots are exact. Maximum 62.
Sprint: top 8, 3 exact, 1 in the top 8 but wrong place, +8 if all eight exact. Maximum 32.
Race: top 8, 5 exact, 2 wrong place, +15 if all eight exact; fastest lap 3; any DNF right 2; number of DNFs exact 5,
off by one 2; DNF drivers (below).
Race maximum: 65 plus 8 per DNF driver picked (73 with one driver, 105 with five).
All predictions are optional. Results are scored only after an admin approves them.

## DNF rules
- A prediction states whether anyone retires, how many (0 to 5) and one driver per predicted DNF.
- Each picked DNF driver who really retired scores 4, or 8 if he started in the real top 8 (result field grid_top8).
- A driver cannot be both in your top 8 and a DNF pick (validation and prediction_dnf_ok, migrations 010 and 020).
- Older predictions with the single dnf_driver field stay valid and score as before.
- Importer: status Retired or equivalent counts. Did not start, disqualified and lapped finishers do not.

## Deadlines and reveal
- Late entries (P13, 22 Nov 2026, migration 039): Qualifying and Sprint Qualifying lock at their own start. Race and Sprint predictions stay open until their own start; one saved or changed after Qualifying (Race) or Sprint Qualifying (Sprint) started counts at 70% (lo_late_factor(), rounded down; scores.breakdown gets late, late_factor, raw_total). Saving identical picks changes nothing (updated_at is what decides lateness; admin corrections keep it). prediction_windows: lock_at is the session's own start, plus full_value_until and is_late. Every session reveals its picks at its own start. tools/apply-late-entry-edits.mjs made the page edits. Previously:
- (Old rule, before P13) Qualifying and sprint qualifying lock at their own start. Race predictions lock at qualifying start.
  Sprint predictions lock at sprint qualifying start. A session with no known start time stays closed.
- Others' picks become visible only after the lock (predictions read policy, migration 005). picks.js and picks-engine.js
  render the reveal. scorecard.js and scorecard-engine.js explain each score.

## Results pipeline
- Race matching (P11, 21 Nov 2026): the API gives race dates in UTC while events use local dates, so a race belongs to an event when its date is within one day of the event's dates (Las Vegas starts Saturday 20:00 local = Sunday 04:00 UTC). Events are at least 5 days apart, so this still matches exactly one race.
- Edge function import-results reads the Jolpica API (dry run, pending results, session-time sync). Sprint qualifying
  is derived from the sprint grid and labelled "derived". It accepts the secret in the x-import-secret header (and still
  in a ?key= query parameter).
- Lineup (030): qualifying and derived sprint qualifying are built from the session's effective lineup
  (session_lineup_external) instead of all active drivers. A driver in the feed who is not in the lineup is logged as an error.
- Grid penalties (034): if a penalty is registered for the Sprint, or the sprint grid shows a pit-lane start or a missing
  slot, no derived Sprint Qualifying is created. It is logged as skipped and an admin enters it.
- Admin panel (admin.html) approves, rejects, edits, corrects and enters results manually. Edited results keep an api_snapshot.
- pg_cron jobs as last documented: import-session-times-daily (06:15 UTC), import-results-every-30-min,
  cleanup-cron-history (03:30 UTC), send-push-reminders-every-15-min. Change notices ride on the same send-reminders run.
- A GitHub Actions workflow (.github/workflows/keepalive.yml) keeps the Supabase project awake.

## Driver changes, penalties, notices and corrections (M1 to M6)
- Lineup (030, 031): session_lineup_state (service role), session_lineup (signed-in), session_lineup_external (service role),
  check_pick_drivers, validate_session_data with optional lineup parameters. With no substitution and no inactive driver
  row, behaviour is the original. If a season has an inactive driver row, result validation counts the active lineup.
- Substitutions (031, 032): admin_preview_substitution, admin_register_substitution, admin_revert_substitution. A new
  replacement driver row is created inactive. A session with an unknown start time is included only if the admin confirms it.
  A revert is appended as new rows, only for sessions that have not taken place, never while a later substitution applies.
- Prediction form (033, 034): prediction_form_lineup(session) returns the effective lineup, stand-ins for withdrawn drivers
  the player already saved, the changes for the "Weekend changes" strip, and (034) the grid penalties in force.
  predict-tiles.js shows a withdrawn driver as a flagged tile. A saved withdrawn pick stays valid and re-saveable; new picks use the lineup.
- Grid penalties (034): admin_preview_grid_penalty, admin_register_grid_penalty, admin_revoke_grid_penalty (a revoke can carry a
  corrected replacement), session_has_grid_penalty (service role). Informational: results and scores are not touched.
- Notices (031, 035, 036): one in-app notice per player with a saved prediction for an affected session
  (player_notifications, mark_notifications_read). Push delivery through send-reminders using due_push_notices
  (notices created in the last 3 hours, once per device via push_notice_log). An admin can trigger delivery with ?task=notices.
  Front end: notices.js and notices.css on the Predictions page, nav-badge.js for the unread badge.
- Corrections (037): admin_preview_corrections, admin_correct_predictions (one or several players, all or nothing, mandatory
  reason, validated like a player's save), admin_revert_correction (last in, first out), rescore_prediction (service role).
  The player's created_at and updated_at are never written; the picks before and after are kept in prediction_corrections.
  Only scores is written; season picks and the season bonus are untouched.
- Weekend check (P12, 21 Nov 2026): admin-check.js, admin-check.css, migration 038 (admin_weekend_check, read-only, admins only) and supabase/tests/038_admin_weekend_check_test.sql. A seventh Admin tab, "Weekend check", turns the function's facts into ok/warning/problem lines for a chosen weekend (sessions and times, drivers and API ids, substitutions and penalties in force, finished sessions without results, importer errors, the three cron jobs, devices, season picks). Two manual ticks (official entry list, announced penalties) are kept in the browser per weekend. admin-check.js must load before admin-tabs.js.
- Admin page tabs (P8, 19 Nov 2026): admin-tabs.js and admin-tabs.css regroup the sections below into six tabs at load time (Results with a pending count, Driver changes, Grid penalties, Corrections, Season results, Import log; deep links #results, #changes, #penalties, #corrections, #season, #log); the admin scripts are unchanged.
- Admin page tabs (P8, 19 Nov 2026): admin-tabs.js and admin-tabs.css regroup the sections below into six tabs at load time (Results with a pending count, Driver changes, Grid penalties, Corrections, Season results, Import log; deep links #results, #changes, #penalties, #corrections, #season, #log). The three history lists (substitutions, penalties, corrections) show the latest five entries with a "Show all" button. The admin scripts are unchanged.
- Admin screens in admin.html: Pending results, Missing results, Recently approved, Season results, Driver changes
  (admin-changes.js), Grid penalties (admin-penalties.js), Prediction corrections (admin-corrections.js), Import log.

## Season-long predictions (B1 plan agreed 6 Nov 2026, implemented in 025 to 029)
- Picks: Drivers' champion and Constructors' champion, one pair per player per season.
- Points (after an admin approves the official final standings): Drivers' 1st 60, 2nd 20, 3rd 10. Constructors' 1st 40, 2nd 15, 3rd 8.
  +10 if both champion picks finish 1st. Maximum 110. A late joiner's points are halved, rounded down.
- Opens when the season's drivers are loaded and every Round 1 session has a start time. Closes at the start of the earliest Round 1 session.
- Late joiners (joined after that lock) may pick until the earliest Round 5 session, at half value.
- Group-mates can read a player's picks only after that player's own window has closed (policy in 025).
- Bonus lives in season_scores, never in scores. It is added to leaderboard.total_points and player_xp.xp (028; new columns
  session_points, bonus_points, session_xp, bonus_xp). Session statistics, Season Points and the 13 original achievements stay session-only.
- Admin: season results (versioned, approve only after all pick windows are closed, reject, edit), pick override with a written
  reason (logged), points preview (026, 027; admin-season.js).
- Front end: season-picks.js and season-picks.css (Season picks card on predict.html), standings.js (bonus in the final table only),
  account-stats.js (bonus line in the Season section).
- Title Caller (029): the 14th achievement, view player_achievements_all. A call = a Drivers' or Constructors' champion pick that
  finished 1st in an approved season result; levels at 1, 2 and 4 calls.
- NOT built: a page that shows everyone's season picks after the windows close (the database allows it; no page reads it).

## Push reminders and app
- push_subscriptions: one row per device. push_log: one row per device, session and kind (no duplicate reminders).
- RPCs save_push_subscription and remove_push_subscription; due_push_reminders is service role only.
- Edge function send-reminders (cron every 15 minutes, task=test for the Send a test button, task=notices for admins). sw.js shows
  the notification. The public VAPID key is in config.js; the private key and IMPORT_SECRET are Supabase secrets, not in the repo.
- Messages go about 3 hours and 1 hour before a deadline to players who have not predicted.
- sw.js is network-first (cache lights-out-v1) and registered from site-nav.js. manifest.webmanifest makes the site installable.
- Calendar feed: edge function calendar-feed (public, schedule only, no login, no migration).

## Profile, XP and levels
- profiles.avatar (helmet code) is set only through set_avatar. XP is lifetime points over all seasons (player_xp).
- Level n needs 40 x (n-1)^1.6 XP, cap 50. Seven ranks with badges (lo-profile.js). Level-up banner uses localStorage.
- Statistics views (023): player_session_stats, player_season_stats, player_event_progress.
- Achievements (024, 029): computed, not stored. 14 achievements in player_achievements_all. Emblems and display text in
  lo-achievements.js (thresholds there are for the sheet only; the view is the source of truth). Design-review page badges.html (not linked).

## Front end
Pages: index, account, predict, leaderboard, picks, scorecard, admin, reset-password, badges (unlinked).
- Shared: styles.css, site-chrome.css, lights-out.css, pages.css, profile.css, site-nav.js (navigation and service worker), theme.js
  (data-driven event themes: circuit outline, hero photo, accents), admin-link.js, config.js.
- Home: index.html, home.css, home.js, recap-engine.js, recap.js (weekend recap).
- Predictions: predict.html, predict-tiles.js (driver tiles, lineup-aware), predict-lights.js (compact deadline lights),
  predict-ui.js, predict-shell.js (R1 shell: rail, context bar), predict-layout.css, predict-changes.css, tiles.css, season-picks.js, notices.js.
- Leaderboard: leaderboard.html, standings.js, standings.css. Championship tab (P7, 19 Nov 2026): championship.js, championship.css and the edge function championship-standings (deployed with JWT verification off; reads Jolpica standings for the season, 10-minute in-memory cache, needs a signed-in caller). Shows the real Drivers' and Constructors' tables plus the league players who picked each leader (season_predictions, only what the policy returns).
- Welcome flow (P10, 21 Nov 2026): welcome.js and welcome.css. A "Getting started" card on the Home page (steps ticked from the player's own data: member, helmet, rules read, push device, season picks while a window is open, first prediction; hidden for two weeks with Hide) and invite links (account.html?invite=CODE fills the join code and is remembered in localStorage until the player has joined). The invite code itself is not readable by the site (grant on groups excludes it).
- How to play (P3, 19 Nov 2026): how-to-play.html and how-to-play.css, static, no scripts. Linked as "Rules" in the desktop top bar (site-nav.js, topOnly) and from the home page footer. The rules text is hand-written: update it whenever scoring, deadlines or season picks change.
- Account (redesign 18 Nov): account-shell.js (section rail: Overview, Season stats, Achievements, Settings, links like account.html#stats),
  account-layout.css, account-profile.js, account-stats.js (includes the league battle visual), account-achievements.js,
  account-ach-preview.js (preview and All/Earned/Locked filter), account-app.js (install, push, calendar links), access-gate.css.
- Removed in H2 (19 Nov 2026, still in git history): predict.js, leaderboard.js, next-race.js, next-race.css, site-nav.css.
- Assets: assets/circuits (24 SVG), assets/hero (24 JPG, Unsplash), see assets/ATTRIBUTIONS.md. Tools: tools/optimize-hero.mjs,
  tools/generate-vapid.mjs. Driver portraits (P4, 19 Nov 2026): originals from Wikimedia Commons go in assets/portraits-originals/ (git-ignored, named by lower-case driver code) with a credits row in credits.csv (committed); tools/optimize-portraits.mjs (crops around the face position in assets/portraits-originals/focus.csv, set with tools/portrait-focus.html) writes assets/portraits/<code>.webp and portraits.js (window.LO_PORTRAITS); photos show in colour; predict-tiles.js shows the photo by driver code, otherwise the silhouette; credits.html lists the credits. Team logos: none, by decision (team name and colour bar only).

## Data in the database
As last documented (6 Nov 2026), not re-read: 2026 rehearsal data (22 real 2026 drivers; events united-states-2026, mexico-city-2026,
brazil-2026, las-vegas-2026, qatar-2026, abu-dhabi-2026); 2027 calendar of 24 events and 68 sessions with times null until published;
no 2027 drivers yet. The owner reports the database looks correct (19 Nov). The full reset before the 2027 season is deferred, and
its script must be rebuilt first: supabase/maintenance/remove_rehearsal_weekend.sql covers only united-states-2026 and the 2026
drivers, and rows in the append-only change tables (substitutions, penalties, corrections) would block deleting their events,
sessions or drivers.

## Outstanding
1. Housekeeping: done (H1, H2). H3 dropped: FORM_AWARE in admin-changes.js is a deliberate rollback switch (now permanently true), and the importer keeps accepting ?key= for manual browser dry runs while the scheduled jobs use the x-import-secret header.
2. Features: add driver photos for the 2027 grid once the drivers are known.
3. Confirm the "Adapted for this site" wording for portugal.svg on credits.html.
4. Before the 2027 season: rebuild and run the reset (rehearsal data, test season data), load 2027 drivers, check session times
   (Gulf races, calendar changes), re-check live database definitions.
5. Tests for migrations 018 to 022 and 030 to 037; re-run the 005 to 029 tests after any change to the functions they call.
6. Unknown: status of the printed A3 wall calendar (print files are git-ignored and not in the repo).