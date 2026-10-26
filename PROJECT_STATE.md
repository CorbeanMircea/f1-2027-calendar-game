# Lights Out (F1 2027 friends league): project state

Plain HTML, CSS and JavaScript on GitHub Pages. Backend: Supabase (database, auth, realtime, edge function).
Live site: https://corbeanmircea.github.io/f1-2027-calendar-game/

## Working (confirmed by the owner)
- Accounts, friends group with invite code, display names.
- Predictions for all four session types, server-side deadlines, scoring v2.
- Importer (edge function and scheduled jobs), admin panel (approve, reject, edit, correct, manual entry).
- Live leaderboard, daily session-time sync, keep-alive workflow.
- Lights Out theme, home page with start-light gantry and lock board.
- Predictions page: compact deadline lights and driver tiles (placeholder portraits).
- Rehearsal 1 (US GP 2026) completed: results imported and approved.

## Rehearsal 2
Mexico City GP 2026 (`mexico-city-2026`, 30 Oct to 1 Nov). Remove both rehearsals afterwards with
`supabase/maintenance/remove_rehearsal_weekend.sql`.

## Delivered, awaiting confirmation
- New leaderboard: `leaderboard.html`, `standings.css`, `standings.js` (`leaderboard.js` is the old fallback).

## Not done yet
- Home overview strip; race page; calendar overview; A3 printed calendar.
- Team colours in the database; verified portraits; real 2027 drivers and session times (not published yet).
- Unused old files: `next-race.js`, `next-race.css`, `site-nav.css`, `predict.js`, `leaderboard.js` (kept as fallbacks).

## Rules
- Do not change scoring, deadlines, lock logic, authentication or prediction saving without a plan.

## Next task
Confirm the leaderboard, then run Mexico City as the second rehearsal to see movement.