# Local test database (Docker only)

Everything in this folder runs against a **local** Supabase stack in Docker. Nothing here uses a production URL, key or password.

| Command (from the repo root) | What it does |
|---|---|
| `npm run db:plan`   | Shows which migrations would be applied and which are excluded. Needs no Docker. |
| `npm run db:start`  | Starts the local stack (first run downloads several GB of images). |
| `npm run db:status` | Shows local URLs and keys (they are throw-away local keys). |
| `npm run db:replay` | Applies the migrations to an empty local database. |
| `npm run db:seed`   | Loads the test seed (`seed.sql`) into a replayed database. |
| `npm run db:fresh`  | Rebuilds the local database from scratch, replays the migrations and seeds it. |
| `npm run db:reset`  | Rebuilds the local database and replays the migrations (no seed). |
| `npm run test:sql`  | Runs the SQL regression tests (`supabase/tests/*.sql`) against the seeded local database. |
| `npm run db:stop`   | Stops the local stack. |

## Migrations excluded from the replay (approved)

| File | Why |
|---|---|
| `supabase/015_schedule.sql` | Schedules `pg_cron` jobs that call the production importer. |
| `supabase/022_push_schedule.sql` | Schedules a `pg_cron` job that calls the production reminder function. |

The other 37 files are applied unchanged. The original files are never modified. `apply-migrations.ps1` also refuses to apply any
file containing `cron.schedule`, `net.http_` or a `.supabase.co` address that is not on the exclusion list.

## The seed

`seed.sql` creates one group (invite code `LO-SEED-CODE-1`), one admin and three players (made-up users, no password), then predictions
and approved results for four 2026 test sessions through the application's own functions, so the leaderboard, statistics and
title-caller tests have scored data. Browser tests create their own sign-in users later.

## SQL tests

`npm run test:sql` copies each file into the local container and runs it. It reports PASS / FAIL / NO RESULTS per file, and LEAK if a test
left data behind. It exits with code 1 if anything is not passing.

Three legacy tests are **retired** (listed in `run-sql-tests.ps1`, never deleted): `005`, `007` and `009` were written for a schema that later
migrations replaced, so they cannot pass any more. Run them anyway with `-IncludeRetired`. Replacement tests are planned.

Never run `supabase link`, `supabase db push` or any `--remote` command in this project.
