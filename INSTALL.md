# Install: serve the AP Statistics course from your own accounts

This is the whole course as one repo: a static site (worksheets, the Desk, the quiz, APStat Park, teacher
tools), two small Node services, two Supabase databases, and the scripts that connect them. Follow the
steps in order. Each one ends with a check. Budget an afternoon the first time.

If you are the original teacher keeping this repo in step with the old ones, skip to **Keeping in sync**.

## 0. What you need

| Account | Free tier is enough? | Used for |
|---|---|---|
| GitHub | yes | the repo and GitHub Pages (the static site) |
| Railway | the hobby plan (about $5/month) | two always-on Node services |
| Supabase | yes, but it caps you at two projects, and this needs both | the databases |
| Groq and/or DeepSeek | yes | AI grading of free-response answers and the tutor chat |
| Optional: Schoology, Blooket, Dogecoin via BlockCypher, Cloudflare R2 | | grade sync, quizzes, the candy economy, video hosting |

On your machine: git, Node 22, and the GitHub CLI `gh` (optional but used by the doctor). `psql` is optional.

## 1. Get the repo

```bash
gh repo fork robjohncolson/apstat-park --clone     # or: git clone <your copy>
cd apstat-park
npm run test                                       # proves the code works before you change anything
```

## 2. Create the two Supabase projects

Follow `supabase/README.md`. Order matters: baselines, then the relay migrations, then the roster
migrations. You will come back with, per project: the URL, the anon key, the service_role key.

Check: in each project's Table Editor you see the tables listed in `supabase/expected-tables.json`.

## 3. Run the setup wizard

```bash
node scripts/setup.mjs
```

It asks for your GitHub user, your two Railway URLs (you can leave them blank now and re-run later), the
Supabase values from step 2, your AI keys, your name and your class sections. It then:

- generates every secret the services need (token secret, teacher secret, issuer keypairs, wallet key),
- writes `services/roster/.env` and `services/relay/.env` (gitignored, never commit them),
- writes `config/identity.next.json`, the identity this repo should carry from now on,
- prints the Railway variable commands and the GitHub secret command for later steps.

Then retarget every file in the repo to your identity:

```bash
node scripts/rebrand.mjs --to config/identity.next.json
git add -A && git commit -m "Rebrand to <your name>"
```

Check: `grep -r robjohncolson site services | wc -l` prints 0 (only `docs/LINEAGE.md` still mentions the original author).

## 4. Deploy the two services on Railway

Two services, one Railway project. For each: **New service → GitHub repo → this repo**, then in the
service's Settings:

| Service | Root Directory | Start command (from `railway.json`) | Public URL goes into |
|---|---|---|---|
| roster | `services/roster` | `node server.js` | identity `roster_url`, relay var `ROSTER_SERVICE_URL`, roster var `PARK_RELAY_URL` is the *other* one |
| relay | `services/relay` | `node server.js` | identity `relay_url`, roster vars `PARK_RELAY_URL` and `FRQ_GRADER_URL` |

Paste the variables the wizard printed (Variables tab, or `railway variables --set ...` from each
service directory after `railway link`). Then put the two public URLs back into the identity: re-run
`node scripts/setup.mjs` (it keeps every earlier answer), rebrand again, commit.

Check: `curl https://<roster-url>/health` and `curl https://<relay-url>/health` both return `ok`.

## 5. Publish the site on GitHub Pages

Repo → Settings → Pages → Source: **GitHub Actions**. Push to `main`; the `pages` workflow publishes the
`site/` directory. Add the one repo secret the hourly FRQ regrade sweep needs:

```bash
gh secret set APSTATS_TEACHER_KEY --repo <you>/apstat-park     # value: roster's TEACHER_KEY
```

Check: `https://<you>.github.io/apstat-park/` shows the landing page and `/quiz/` shows the quiz.

## 6. Seed the Desk's content tables

```bash
node scripts/build-lesson-urls-seed.mjs --schedule > /tmp/seed.sql
```

Run it in the **content** project's SQL editor. Edit `topic_schedule` dates for your sections. The Desk
reads these two tables at runtime; without them it shows the baked registry, which is fine for a first look.

## 7. Enrol students and verify

- Open `site/teacher-roster-console.html` locally (it is deliberately not linked from the site) and enrol
  your sections, or let students self-enrol in the sections you listed under `OPEN_SIGNUP_SECTIONS`.
- Run the doctor against the live deployment:

```bash
node scripts/doctor.mjs --env
```

Every line should be PASS. WARN lines name what is optional. A FAIL names the step to redo.

## 8. Optional subsystems

Each is already wired and dormant until its variables are set. See `config/env-schema.json` for every key.

| Subsystem | Turn on by |
|---|---|
| Doge candy economy (wallets, gifting, Tetris stakes, buying park keys) | feature flags default on; add `BLOCKCYPHER_TOKEN` for on-chain reads and `PAYOUT_AGENT_KEY` for payouts |
| Progress Check figures | upload the figures to the private `pc-figures` bucket to match `services/roster/data/pc-figures-manifest.json` |
| TI-84 trainer with the real emulator | your own ROM, see `supabase/content/900_trainer_assets_bucket.sql` |
| Schoology grade sync | `site/tools/schoology-sync.py` drives Edge on your machine with your Schoology login; configure section ids in `services/roster/data/` and `site/tools/` per their READMEs |
| Offline video packs on Cloudflare R2 | `site/.r2.env.example` |

## Keeping in sync (original teacher only)

Until the parents are retired this repo is derived from them:

```bash
node sync/sync.mjs --check     # any new parent commits?
node sync/sync.mjs             # rebuild site/, services/, content/ from the parents' HEAD
git add -A && git commit -m "Sync parents: <what came in>"
```

The sync re-applies the path transforms and the identity rewrite, so the result is always the parents'
code at your current identity. Never hand-edit a mirrored path; see `sync/README.md`.

## Retiring the parents (one day)

1. Point both Railway services' source at this repo (Root Directory as in step 4) and redeploy.
2. Update `lesson_urls` rows (step 6) so the Desk opens worksheets here, and the Schoology links.
3. Leave `index.html` redirect stubs in the old repos for a year. Archive them on GitHub.
4. Delete `sync/`; from then on `site/`, `services/` and `content/` are the source.
