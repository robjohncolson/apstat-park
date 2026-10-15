# Supabase

The course uses **two** Supabase projects. Both are on the free tier, which caps an account at two
projects, so a fresh install needs either a fresh account or an account with room for two.

| Project | identity key | Holds | Written by |
|---|---|---|---|
| **core** | `supabase_url` / `supabase_anon_key` | Quiz `answers`, `users`, votes, identity claims; `roster`, `item_ledger` and every roster-server table (41 migrations); relay tables `guest_log`, `quiz_reviews`, `park_*` (8 migrations); private storage bucket `pc-figures` | roster service (service role), relay service (service role), quiz app (anon, allow-all RLS on the quiz tables) |
| **content** | `content_supabase_url` / `content_supabase_anon_key` | `lesson_urls`, `topic_schedule` (the Desk's roadmap and calendar), `students`, `student_progress` (summer self-report), private storage bucket `ti84-trainer-assets` (the teacher-supplied TI-84 ROM) | the Desk (anon: select on the two roadmap tables, insert on the two progress tables); the teacher via the SQL editor |

Nothing in the repo ever contains a service-role key. The anon keys are public by design and live in
`config/identity.json`.

## Fresh install, in order

1. Create the **core** project. SQL Editor → run, in this order:
   1. `core/000_quiz_baseline.sql` (reconstructed; see "Provenance")
   2. `core/001_user_settings.sql`
   3. `../services/relay/migrations/0001_*.sql` … `0008_*.sql`, ascending
   4. `../services/roster/migrations/0001_*.sql` … `0041_*.sql`, ascending
   5. `core/900_pc_figures_bucket.sql` (creates the private bucket; upload the figures separately, see `services/roster/data/pc-figures-manifest.json`)
2. Create the **content** project. SQL Editor → run:
   1. `content/000_roadmap_baseline.sql` (reconstructed)
   2. `content/001_summer_2026_progress.sql`
   3. seed `lesson_urls`: `node scripts/build-lesson-urls-seed.mjs > /tmp/lesson_urls.sql` and run it (it reads the quiz curriculum and writes one row per topic with URLs under your `site_base`); then enter `topic_schedule` rows for your sections (the Desk's calendar), one row per topic per period.
   4. `content/900_trainer_assets_bucket.sql` and upload your own TI-84 CE ROM as `ROM.rom`; put its signed URL in `site/ti84-trainer-v2/rom-config.js` (the trainer also accepts a local ROM file at first launch, so this step is optional).
3. Copy each project's URL, anon key and service_role key into `scripts/setup.mjs` when it asks.

With `psql` and the projects' connection strings, `bash supabase/apply.sh core "$CORE_DB_URL"` and
`bash supabase/apply.sh content "$CONTENT_DB_URL"` run the same lists. Every file is idempotent and safe to
re-run; `apply.sh` is what you run again after a sync brings in a new migration.

## Keeping it true

- `supabase/expected-tables.json` lists every table the code reads. `node scripts/doctor.mjs --env` probes
  each one through the REST API with the service key and fails on a missing table.
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
