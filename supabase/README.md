# Supabase

The course uses **two** Supabase projects. Both are on the free tier, which caps an account at two
projects, so a fresh install needs either a fresh account or an account with room for two.

| Project | identity key | Holds | Written by |
|---|---|---|---|
| **core** | `supabase_url` / `supabase_anon_key` | Quiz `answers`, `users`, votes, identity claims; `roster`, `item_ledger` and every roster-server table (41 migrations); relay tables `guest_log`, `quiz_reviews`, `park_*` (8 migrations); private storage buckets `pc-figures` and `worksheet-diagnostics`; `answers` in the `supabase_realtime` publication | roster service (service role), relay service (service role), quiz app (anon, allow-all RLS on the quiz tables) |
| **content** | `content_supabase_url` / `content_supabase_anon_key` | `lesson_urls`, `topic_schedule` (the Desk's roadmap and calendar), `students`, `student_progress` (summer self-report), private storage bucket `ti84-trainer-assets` (the teacher-supplied TI-84 ROM) | the Desk (anon: select on the two roadmap tables, insert on the two progress tables); the teacher via the SQL editor |

Nothing in the repo ever contains a service-role key. The anon keys are public by design and live in
`config/identity.json`.

## Fresh install, in order

1. Create the **core** project. SQL Editor → run, in this order:
   1. `core/000_quiz_baseline.sql` (reconstructed; see "Provenance")
   2. `core/001_user_settings.sql`
   3. `core/010_realtime_publication.sql` (adds `answers` to the `supabase_realtime` publication; the relay and the quiz subscribe to it with `postgres_changes`, and without this the subscriptions never fire)
   4. `../services/relay/migrations/0001_*.sql` … `0008_*.sql`, ascending
   5. `../services/roster/migrations/0001_*.sql` … `0041_*.sql`, ascending
   6. `core/900_pc_figures_bucket.sql` (creates the private bucket; upload the figures separately, see `services/roster/data/pc-figures-manifest.json`)
   7. `core/901_worksheet_diagnostics_bucket.sql` (private bucket roster writes worksheet load diagnostics into)
2. Create the **content** project. SQL Editor → run:
   1. `content/000_roadmap_baseline.sql` (reconstructed)
   2. `content/001_summer_2026_progress.sql`
   3. seed `lesson_urls`: `node scripts/build-lesson-urls-seed.mjs > /tmp/lesson_urls.sql` and run it (it reads the quiz curriculum and writes one row per topic with URLs under your `site_base`); then enter `topic_schedule` rows for your sections (the Desk's calendar), one row per topic per period.
   4. `content/900_trainer_assets_bucket.sql` and upload your own TI-84 CE ROM as `ROM.rom`; put its signed URL in `site/ti84-trainer-v2/rom-config.js` (the trainer also accepts a local ROM file at first launch, so this step is optional).
3. Copy each project's URL, anon key and service_role key into `scripts/setup.mjs` when it asks.

## apply.sh: the same lists with psql, tracked

With `psql` and the projects' connection strings (Project Settings → Database → Connection string, URI):

```bash
bash supabase/apply.sh core    "$CORE_DB_URL" --dry-run    # list applied / pending, change nothing
bash supabase/apply.sh core    "$CORE_DB_URL"              # run only the pending files
bash supabase/apply.sh content "$CONTENT_DB_URL"
```

`apply.sh` records every file it runs in a tracking table in that project:

```sql
public.apstat_park_migrations (name text primary key, sha256 text, applied_at timestamptz)
```

`name` is the path from the repo root (`services/roster/migrations/0021_doge_gifting.sql`), `sha256` the
file's checksum with CR stripped. Only files not in the table run. Each file runs in its own
`psql -v ON_ERROR_STOP=1 --single-transaction` together with its tracking row, so a failing file leaves
nothing behind and is retried next time (a few roster migrations carry their own `begin; … commit;`; those
are atomic on their own). A file whose checksum changed after it ran is reported as `changed` and NOT re-run:
review it by hand. Run `apply.sh` again after a sync brings in a new migration.

**Do not replay the whole chain on a populated database.** Individual files are written to be re-runnable,
but the chain is not: for example roster `0021` replaces `doge_ledger_kind_check` with a constraint that
lacks the kinds that `0023`, `0024`, `0025` and `0034` later widen it with, so replaying it fails on a database that holds
those rows, after earlier function replacements in the same run already committed. That is why `apply.sh`
tracks what ran, and refuses to run when the tracking table is empty but the project already has tables
(`answers` on core, `lesson_urls` on content).

**Baselining a project that was migrated before tracking existed** (the original teacher's two projects):

```bash
bash supabase/apply.sh core "$CORE_DB_URL" --mark-applied      # records every file as applied, runs none
```

`--mark-applied` records every pending file without running it, so make sure each one really is in that
project first. Files added to this directory after the project was set up by hand (for example
`core/010_realtime_publication.sql` and `core/901_worksheet_diagnostics_bucket.sql`) are idempotent: run
them in the SQL editor before or after baselining.

## Keeping it true

- `supabase/expected-tables.json` lists every table the code reads, every storage bucket it uses
  (`buckets`), and every table it subscribes to with `postgres_changes` (`realtime`).
  `node scripts/doctor.mjs --env` probes each table through the REST API and each bucket through
  `GET /storage/v1/bucket/<name>` with the service key, and fails on a missing one. Publication membership
  is not visible over REST; the doctor prints the SQL to check it. `npm run test:scripts` fails when the code
  subscribes to a table no SQL here adds to `supabase_realtime`, or lists a bucket no SQL here creates.
- New migrations go in `services/<service>/migrations/` as before (the services own their schema). Add the
  table name to `expected-tables.json` in the same commit.
- The roster README (`services/roster/README.md`) explains the RLS posture: roster tables have RLS enabled
  with zero policies, so only the service role can read them. The quiz tables are allow-all for anon, which
  is the original 2025 design and the reason every student answer is public to every other student.

## Provenance of the reconstructed baselines

The parents never had a runnable "create everything" script. Three sources exist:

| File | Status |
|---|---|
| `docs/quiz/supabase_schema.sql` | A dashboard dump marked "for context only, not meant to be run" (missing sequences and the `handle_updated_at` function). |
| `services/relay/migrations/`, `services/roster/migrations/` | Real, idempotent, run in production in order. Trustworthy. |
| `site/supabase-summer-2026.sql` | Real, idempotent, run on the content project in May 2026. Trustworthy. It names `lesson_urls` and `topic_schedule` as pre-existing but never creates them. |

`core/000_quiz_baseline.sql` and `content/000_roadmap_baseline.sql` were written on 2026-10-14 from the dump,
the client code's column usage, and the migrations' assumptions. They are the one part of this directory
that has NOT been proven against the live projects. **First thing to do with database access:**

```
pg_dump --schema-only --no-owner --no-privileges "$CORE_DB_URL"    > core/live-schema.sql
pg_dump --schema-only --no-owner --no-privileges "$CONTENT_DB_URL" > content/live-schema.sql
```

then compare the baselines against the dumps and fix the baselines. Keep the dumps out of git if they
contain anything you consider private (they should not; schema only).
