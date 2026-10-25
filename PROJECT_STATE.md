# Lights Out (F1 2027 friends league): project state

Plain HTML, CSS and JavaScript on GitHub Pages. Backend: Supabase (database, auth, realtime, edge function).
Live site: https://corbeanmircea.github.io/f1-2027-calendar-game/

## Working (confirmed by the owner)
- Accounts, friends group with invite code, display names.
- Predictions for qualifying, sprint qualifying, race and sprint, with server-side deadlines and scoring v2.
- Results import (edge function + scheduled jobs), admin panel (approve, reject, edit, correct, manual entry).
- Live leaderboard. Daily session-time sync. Keep-alive workflow.
- Lights Out theme and home page: charcoal/white, yellow actions, start-light gantry, lock board.

## Rehearsal
Real United States GP 2026 (event `united-states-2026`) is the dry run. Remove afterwards with
`supabase/maintenance/remove_rehearsal_weekend.sql`.

## Delivered, awaiting confirmation
- Compact deadline lights on the predictions page: `predict.html`, `predict-lights.css`, `predict-lights.js`.
  (`predict.js` is unchanged.)

## Not done yet
- Driver tiles with placeholder portraits on the predictions page.
- Overview strip on the home page; leaderboard, race page and calendar in the new design; A3 calendar.
- Team colours in the database; real 2027 drivers and session times (not published yet).
- Unused old files: `next-race.js`, `next-race.css`, `site-nav.css`.

## Rules
- Do not change scoring, deadlines, lock logic, authentication or prediction saving without a plan.
- Temporary test data (event `ui-test-2026`) must be deleted after testing.

## Next task
Confirm the deadline lights, then replace the pick controls with driver tiles.