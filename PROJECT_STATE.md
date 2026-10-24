# Lights Out (F1 2027 friends league): project state

Plain HTML, CSS and JavaScript on GitHub Pages. Backend: Supabase (database, auth, realtime, edge function).
Live site: https://corbeanmircea.github.io/f1-2027-calendar-game/

## Working (confirmed by the owner in testing)
- Accounts, friends group with invite code, display names.
- Predictions for qualifying, sprint qualifying, race and sprint, with server-side deadlines and scoring v2.
- Results import (edge function + scheduled jobs), admin panel (approve, reject, edit, correct, manual entry).
- Live leaderboard. Daily session-time sync. Keep-alive workflow.

## Rehearsal
Real United States GP 2026 (event `united-states-2026`) is the dry run. Remove afterwards with
`supabase/maintenance/remove_rehearsal_weekend.sql`.

## Delivered, awaiting confirmation
- Lights Out theme (charcoal, white, yellow actions, red accents) and home-page start-light gantry:
  `styles.css`, `home.css`, `home.js`, `index.html`.

## Not done yet
- Predictions page: compact deadline lights and driver tiles with placeholder portraits.
- Leaderboard and race pages in the new design; calendar overview; A3 printed calendar.
- Team colours in the database; real 2027 drivers and session times (not published yet).
- Unused old files: `next-race.js`, `next-race.css`, `site-nav.css`.

## Rules
- Do not change scoring, deadlines, lock logic, authentication or predictions without a plan.
- Predictions page stays untouched during the live rehearsal weekend.

## Next task
Confirm the home-page design, then add the compact deadline lights and driver tiles to the predictions page.