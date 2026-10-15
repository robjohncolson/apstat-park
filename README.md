# apstat-park

The complete AP Statistics course platform, as one repo: 69 video follow-along worksheets with AI grading,
the Desk (student home hub), the consensus quiz, APStat Park (a cooperative pixel world with a TI-84
calculator trainer), teacher dashboards, a gradebook with a two-track grade engine, and the Doge candy
economy that runs classroom incentives.

| Part | Where | Runs on |
|---|---|---|
| Static site: worksheets, Desk, teacher tools, park, trainer | `site/` | GitHub Pages |
| Consensus quiz app | `site/quiz/` | GitHub Pages (same site) |
| Roster service: auth, ledger, gradebook, candy economy | `services/roster/` | Railway |
| Relay service: answer sync, AI grading, Live Classroom, park relay | `services/relay/` | Railway |
| Databases | `supabase/` | two Supabase projects |
| Authoring inputs: transcripts, slides, source PDFs | `content/` | nowhere; they are inputs |

**To run your own copy:** read [INSTALL.md](INSTALL.md). It is a numbered list with a check after every step.

**To understand how it got here:** [docs/LINEAGE.md](docs/LINEAGE.md). This repo was assembled on
2026-10-14 from two older repos and is kept in step with them by `sync/` until they are retired.

**To work on the code:** each part keeps its own guide: `site/CLAUDE.md`, `site/quiz/CLAUDE.md`,
`services/roster/README.md`, `services/relay/README.md`. On a fresh clone run `npm run install:all` once;
then `npm test` at the root runs every suite.

## Scripts

| Command | Does |
|---|---|
| `npm run install:all` | Installs every part's dependencies (`npm ci` in `site/`, `site/quiz/`, `services/roster/`; `npm install --no-package-lock` in `services/relay/`, which has no lockfile) |
| `node scripts/setup.mjs` | Teacher-switch wizard: asks for your accounts (answer `later` for Railway URLs you do not have yet), generates secrets, writes the `.env` files, prints the Railway and GitHub commands |
| `node scripts/rebrand.mjs --to <identity.json>` | Rewrites every baked URL and key in the repo to a new identity |
| `node scripts/doctor.mjs [--env]` | Checks the live site, both services (including signed receipts), both databases; `--env` adds tables and storage buckets |
| `node scripts/check-env.mjs <roster\|relay>` | Validates a service's environment against `config/env-schema.json` |
| `node scripts/build-lesson-urls-seed.mjs [--schedule]` | SQL that seeds the Desk's content tables from the baked registry |
| `bash supabase/apply.sh <core\|content> <db-url> [--dry-run\|--mark-applied]` | Applies only the SQL files a project has not run yet, tracked in `public.apstat_park_migrations` (see `supabase/README.md`) |
| `node sync/sync.mjs [--check]` | Rebuild the mirrored directories from the parent repos |
