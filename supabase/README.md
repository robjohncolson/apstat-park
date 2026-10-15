# Supabase

The course uses **two** Supabase projects. Both are on the free tier, which caps an account at two
projects, so a fresh install needs either a fresh account or an account with room for two.

| Project | identity key | Holds | Written by |
|---|---|---|---|
| **core** | `supabase_url` / `supabase_anon_key` | Quiz `answers`, `users`, votes, identity claims; `roster`, `item_ledger` and every roster-server table (41 migrations); relay tables `guest_log`, `quiz_reviews`, `park_*` (8 migrations); private storage buckets `pc-figures` and `worksheet-diagnostics`; `answers` in the `supabase_realtime` publication | roster service (service role), relay service (service role), quiz app (anon, allow-all RLS on the quiz tables) |
| **content** | `content_supabase_url` / `content_supabase_anon_key` | `lesson_urls`, `topic_schedule` (the Desk's roadmap and calendar), `students`, `student_progress` (summer self-report), private storage bucket `ti84-trainer-assets` (the teacher-supplied TI-84 ROM) | the Desk (anon: select on the two roadmap tables, insert on the two progress tables); the teacher via the SQL editor |

Nothing in the repo ever contains a service-role key. The anon keys are public by design and live in
`config/identity.json`.

## Fresh install: two equal ways

You can build each project either way. Pick one per project and stick with it.

- **SQL editor (no tools needed).** Supabase dashboard → SQL Editor → New query. Open each file below in
  order, paste its whole content, Run, wait for "Success", next file. Files that contain their own
  `begin; … commit;` run fine this way. Nothing records what you ran, so keep a note; if you later switch to
  `apply.sh`, it sees a populated project with no history and tells you to baseline it with
  `--mark-applied` (see below).
- **`apply.sh` (needs `psql`, `node`, a Bash shell).** Runs the same list in the same order and records what
  it ran, so re-running it later applies only new files. See "apply.sh" below.

### core, in this order (54 files; `apply.sh core` runs exactly this list)

1. `supabase/core/000_quiz_baseline.sql` (reconstructed; see "Provenance")
2. `supabase/core/001_user_settings.sql`
3. `supabase/core/010_realtime_publication.sql` (adds `answers` to the `supabase_realtime` publication; the relay and the quiz subscribe to it with `postgres_changes`, and without this the subscriptions never fire)
4. `services/relay/migrations/0001_guest_log.sql` … `0008_park_calc_clears.sql`, ascending (8 files)
5. `services/roster/migrations/0001_roster.sql` … `0041_tetris_gold_premium.sql`, ascending (41 files)
6. `supabase/core/900_pc_figures_bucket.sql` (creates the private bucket; upload the figures separately, see `services/roster/data/pc-figures-manifest.json`)
7. `supabase/core/901_worksheet_diagnostics_bucket.sql` (private bucket roster writes worksheet load diagnostics into)

`apply.sh` builds the list from globs (`supabase/core/0*.sql`, the relay migrations, the roster migrations,
`supabase/core/9*.sql`), so a file a sync brings in lands in its place automatically.

### content, in this order (3 files; `apply.sh content` runs exactly this list)

1. `supabase/content/000_roadmap_baseline.sql` (reconstructed)
2. `supabase/content/001_summer_2026_progress.sql`
3. `supabase/content/900_trainer_assets_bucket.sql`. Then upload your own TI-84 CE ROM as `ROM.rom` and put its signed URL in `site/ti84-trainer-v2/rom-config.js` (the trainer also accepts a local ROM file at first launch, so the upload is optional).

Then seed the Desk's data. This is data, not schema, so `apply.sh` does not run it:
`node scripts/build-lesson-urls-seed.mjs --schedule > seed.sql` writes `seed.sql` in the current directory
(one `lesson_urls` row per topic with URLs under your `site_base`, read from `site/roadmap-data.json`, plus
`topic_schedule` rows). Run it in the content project's SQL editor or with `psql "$CONTENT_DB_URL" -f seed.sql`,
then edit the `topic_schedule` dates for your sections. Do not commit `seed.sql`.

Finally copy each project's URL, anon key and service_role key into `scripts/setup.mjs` when it asks.

## apply.sh: the same lists with psql, tracked

Needs: `psql`, `node`, `sha256sum` or `shasum`, and Bash 3.2 or newer: Terminal on macOS or Linux, Git Bash
on Windows (not PowerShell or cmd). Connection strings: Project Settings → Database → Connection string, URI.

```bash
bash supabase/apply.sh core    "$CORE_DB_URL" --dry-run    # list applied / pending, run the safety checks, change nothing
bash supabase/apply.sh core    "$CORE_DB_URL"              # run only the pending files
bash supabase/apply.sh content "$CONTENT_DB_URL"
```

`apply.sh` records every file it runs in a tracking table in that project:

```sql
public.apstat_park_migrations (name text primary key, sha256 text, applied_at timestamptz)
```

`name` is the path from the repo root (`services/roster/migrations/0021_doge_gifting.sql`), `sha256` the
file's checksum with CR stripped. One extra row, `name = '__history__'`, says how the history started:
`fresh` (apply.sh built the project from nothing) or `baseline:<n>` (`--mark-applied` recorded n files).
Only files not in the table run. A file whose checksum changed after it ran is reported as `changed` and NOT
re-run: review it by hand. Run `apply.sh` again after a sync brings in a new migration.

### Each file and its tracking row commit together

For each pending file `apply.sh` opens one psql session and sends

```
begin
<the file's execution copy>
insert into public.apstat_park_migrations ... ('<name>', '<sha256>')
commit
```

with `ON_ERROR_STOP`, so the first error ends the session and the whole transaction rolls back, tracking row
included; a dropped connection does the same. Files before it stay applied; re-running continues from the
failed one.

Transactions do not nest, and psql's `--single-transaction` has no effect on a file that has its own
`BEGIN`/`COMMIT`: that file's `COMMIT` would end the outer transaction before the tracking row, and an
interruption in that gap would leave committed schema with no record, so a retry would replay the file. So
`apply.sh` owns the transaction instead. The **execution copy** is a temporary copy of the file with its own
top-level `begin;` and `commit;` lines replaced by `-- [apply.sh] removed: …` comments (line numbers in
psql errors still match the file). The mirrored files themselves are never changed.
`supabase/apply-helper.mjs` builds the copy. It lexes the SQL (comments, `'…'`/`E'…'` strings, quoted
identifiers, `$tag$` bodies), and it only removes a line that is exactly `begin;`, `commit;` or
`start transaction;` at top level, at most one pair per file, begin first. It **refuses** the file, naming
the file and line, and runs nothing at all (every copy is built before the first file runs) when it finds:

- any other transaction control: `END`, `ROLLBACK`, `ABORT`, `SAVEPOINT`, `RELEASE`, `BEGIN ISOLATION LEVEL …`,
  a `begin;` that shares its line with other SQL, a second pair, an unmatched `begin;` or `commit;`;
- a statement that cannot run inside a transaction block: anything with `CONCURRENTLY` (e.g.
  `CREATE INDEX CONCURRENTLY`), `VACUUM`, `CREATE/DROP DATABASE`, `CREATE/DROP TABLESPACE`, `ALTER SYSTEM`,
  subscriptions, `ALTER TYPE … ADD VALUE` (refused in a transaction before PostgreSQL 12; since then the new
  value is unusable until commit), `COPY … FROM STDIN`;
- a psql backslash command (`\i`, `\connect`, …).

For a refused file, run it by hand in the SQL editor and record it with the `insert` that `apply.sh` prints.

What the stripper does today (`node supabase/apply-helper.mjs scan <files>` re-checks; checked 2026-10-15
across all 54 core files and 3 content files):

| File | Top-level transaction control | Handled |
|---|---|---|
| `services/roster/migrations/0032_payout_batch.sql` | `begin;` line 14, `commit;` line 655 | stripped |
| `services/roster/migrations/0033_wallet_address_proposals.sql` | `begin;` line 10, `commit;` line 273 | stripped |
| `services/roster/migrations/0034_candy_return.sql` | `begin;` line 15, `commit;` line 197 | stripped |
| `services/roster/migrations/0035_wallet_custody.sql` | `begin;` line 5, `commit;` line 101 | stripped |
| `services/roster/migrations/0039_park_key_purchases.sql` | `begin;` line 23, `commit;` line 138 | stripped |
| `services/roster/migrations/0041_tetris_gold_premium.sql` | `begin;` line 23, `commit;` line 166 | stripped |
| every other roster and relay migration, `supabase/core/*`, `supabase/content/*` | none (the `begin … end` inside `do $$ … $$` and function bodies is PL/pgSQL, not transaction control) | run as is |

No file contains a statement that cannot run inside a transaction. `0031_frq_tickets.sql` mentions
`create index concurrently` only in a comment, as an optional manual alternative; the lexer ignores comments.

### Safety checks (run before anything is written, also in `--dry-run`)

Every read `apply.sh` makes is checked: if the database cannot be queried, it stops before planning or
writing anything. Then it lists the `public` tables and compares them with `supabase/expected-tables.json`:

- **Wrong project.** If the database holds any of the *other* project's tables (you passed the content URL as
  core, or the reverse), it refuses and names them.
- **Populated without history.** If the tracking table is empty or missing but any of this project's
  expected tables exist, it refuses: the project was migrated by hand, and replaying the chain is not safe
  (see below). Baseline it with `--mark-applied`.
- **Unfinished baseline.** If the tracking table has file rows but no `__history__` row (an older `apply.sh`
  recorded a baseline one file per session and stopped halfway), it refuses and tells you to re-run
  `--mark-applied`, which completes the baseline without running anything.

**Why not replay the whole chain on a populated database.** Individual files are written to be re-runnable,
but the chain is not: for example roster `0021` replaces `doge_ledger_kind_check` with a constraint that
lacks the kinds that `0023`, `0024`, `0025` and `0034` later widen it with, so replaying it fails on a
database that holds those rows, after earlier files in the same run already committed.

### Baselining a project that was migrated before tracking existed

The original teacher's two projects, or any project you built with the SQL editor:

```bash
bash supabase/apply.sh core "$CORE_DB_URL" --mark-applied      # records every pending file as applied, runs none
```

`--mark-applied` records every pending file and the `__history__` row in **one** transaction: either the
whole baseline is recorded or nothing is. Re-running it is safe and only adds files that are still missing
(that is also how an unfinished baseline is completed). It refuses a project that has none of the expected
tables (nothing to baseline: run without the flag) and warns, listing them, when some expected tables are
missing. It cannot see whether every file really ran, so make sure each one really is in that project first.
Files added to this directory after the project was set up by hand (for example
`core/010_realtime_publication.sql` and `core/901_worksheet_diagnostics_bucket.sql`) are idempotent: run
them in the SQL editor before baselining.

## Keeping it true

- `supabase/expected-tables.json` lists every table the code reads, every storage bucket it uses
  (`buckets`), and every table it subscribes to with `postgres_changes` (`realtime`).
  `node scripts/doctor.mjs --env` probes each table through the REST API and each bucket through
  `GET /storage/v1/bucket/<name>` with the service key, and fails on a missing one. Publication membership
  is not visible over REST; the doctor prints the SQL to check it. `npm run test:scripts` fails when the code
  subscribes to a table no SQL here adds to `supabase_realtime`, or lists a bucket no SQL here creates.
  `apply.sh` also uses the table lists for its wrong-project and populated-project checks.
- New migrations go in `services/<service>/migrations/` as before (the services own their schema). Add the
  table name to `expected-tables.json` in the same commit. If a new migration needs its own transaction
  control or a statement that cannot run in a transaction, `apply.sh` will refuse it: keep migrations to a
  single optional `begin;` / `commit;` pair on their own lines.
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
