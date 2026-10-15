# CLAUDE.md

One repo, four deployables, two databases. Read `README.md` for the map and `docs/LINEAGE.md` for where
everything came from.

## The one rule that matters right now

This repo is **derived** from two parent repos until the teacher retires them (`sync/manifest.json` names
them). `site/`, `services/`, `content/`, `docs/follow-alongs/`, `docs/quiz/` are **mirror targets**: the
next `node sync/sync.mjs` rewrites them from the parents' HEAD. So:

- To change code under a mirror target, change it in the parent repo and sync. If the change is only
  needed here (a path that moved, a URL that differs), add a transform in `sync/transforms.mjs` or an
  identity key in `config/identity.json`. Never hand-edit a mirrored file.
- Native paths you may edit directly are listed under `native` in `sync/manifest.json`: the root docs,
  `config/`, `sync/`, `supabase/`, `scripts/`, `.github/`, the services' `.env.example` and `railway.json`.
- `node sync/sync.mjs --check` tells you whether the parents have moved.

When the parents are retired, delete `sync/` and this section; the mirrored directories become the source.

## Working in each part

Each part has its own guide, written for that codebase: `site/CLAUDE.md` (worksheets, Desk, park,
trainer, tests, scripts), `site/quiz/CLAUDE.md`, `services/roster/README.md`, `services/relay/README.md`.
Paths inside them are mostly relative to that directory. Where they say `roster-server/` read
`services/roster/`; where they say `curriculum_render/railway-server/` read `services/relay/`; where they
say the quiz repo, read `site/quiz/`.

## Commands

```bash
npm test                 # every suite: site, quiz, roster, relay
npm run test:site        # vitest in site/
npm run test:roster      # vitest in services/roster/
npm run test:relay       # node --test in services/relay/apstat-park
node scripts/doctor.mjs  # is the deployment alive?
```

## Conventions carried over

- Student-facing pages are single-file HTML with embedded CSS and JS. No build step except
  `site/ti84-trainer-v2/build.mjs`.
- Worksheet-wide rollouts are codemods in `site/scripts/wire-*.mjs`, pattern-guarded to
  `^u\d+_lesson.+_live\.html$`, idempotent.
- The relay owns every judgement in APStat Park; the client renders. Shared park modules are byte-identical
  between `site/apstat-park/` and `services/relay/apstat-park/` and every change bumps `CALCULATOR_PROTOCOL`.
- Supabase migrations live with the service that owns the table (`services/*/migrations/`), are idempotent,
  and are run by the teacher by hand. Add the table to `supabase/expected-tables.json` in the same commit.
- Secrets never enter the repo. `config/env-schema.json` is the contract for what each service needs.
- Write extremely easy to consume code. Optimize for how easy the code is to read. Avoid cleverness.
  Use early returns.
