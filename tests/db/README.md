# Local test database (Docker only)

Everything in this folder runs against a **local** Supabase stack in Docker. Nothing here uses a production URL, key or password.

| Command (from the repo root) | What it does |
|---|---|
| `npm run db:plan`   | Shows which migrations would be applied and which are excluded. Needs no Docker. |
| `npm run db:start`  | Starts the local stack (first run downloads several GB of images). |
| `npm run db:status` | Shows local URLs and keys (they are throw-away local keys). |
| `npm run db:replay` | Applies the migrations to an empty local database. |
| `npm run db:reset`  | Rebuilds the local database from scratch, then replays the migrations. |
| `npm run db:stop`   | Stops the local stack. |

## Migrations excluded from the replay (approved)

| File | Why |
|---|---|
| `supabase/015_schedule.sql` | Schedules `pg_cron` jobs that call the production importer. |
| `supabase/022_push_schedule.sql` | Schedules a `pg_cron` job that calls the production reminder function. |

The other 37 files are applied unchanged. The original files are never modified. `apply-migrations.ps1` also refuses to apply any
file containing `cron.schedule`, `net.http_` or a `.supabase.co` address that is not on the exclusion list, and `tests/unit/migration-plan.spec.js`
checks the same rule on every test run.

Never run `supabase link`, `supabase db push` or any `--remote` command in this project.
