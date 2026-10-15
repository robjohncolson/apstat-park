# Lineage

apstat-park was assembled on 2026-10-14 from two repositories that served the AP Statistics course
until then. It starts with a fresh history on purpose: the larger parent carried 362 MB of packed
history, almost all of it media that had been added and later removed. Every old commit is still
reachable in the parents, which stay on GitHub (archived once this repo is live).

| Parent | Remote | Branch | Last commit folded in | Tag |
|---|---|---|---|---|
| follow-alongs | https://github.com/robjohncolson/apstats-live-worksheet | master | `8f395e818a4fc177eeef32a496ea0f8774cbfcc6` (2026-10-13) | `archived-2026-10-14` (local; push pending the parents' review gate) |
| curriculum_render | https://github.com/robjohncolson/curriculum_render | main | `a705abe8012fa2ddb015319a060e9573f7bdebad` (2026-10-12) | `archived-2026-10-14` (local; push pending) |

`sync/state.json` holds the parent commit that each mirror was last rebuilt from. Until the parents are
retired, this repo is **derived**: run `node sync/sync.mjs` after any parent commit, review the diff, commit.

## What moved where

| Parent path | Here | Why |
|---|---|---|
| follow-alongs root (worksheets, Desk, teacher tools, js, data, lib, dok, ai-tutor, apstat-park, ti84-trainer-v2, tests, scripts, tools, icons, vendor, css, types, u1_poster, syllabus, concept-posters, Mac-OS-Sounds) | `site/` | GitHub Pages root. One unit, so every relative link inside it keeps working. |
| follow-alongs `roster-server/` | `services/roster/` | Railway service 1 (Root Directory = `services/roster`). |
| curriculum_render root (quiz app) | `site/quiz/` | Served at `<pages>/quiz/`, iframed by the Desk. |
| curriculum_render `railway-server/` | `services/relay/` | Railway service 2 (Root Directory = `services/relay`). |
| follow-alongs `u1/` … `u9/`, `u4_l*/`, `unit4guide/`, `mit_python_vid2/`, `a2_3-3/` | `content/source/` | Transcripts, slides, PDFs. Authoring inputs, never served. |
| follow-alongs `formal/` | `content/formal/` | Racket models of the grade and wallet engines. |
| follow-alongs `docs/`, curriculum_render `docs/` | `docs/follow-alongs/`, `docs/quiz/` | Reference material, including the original Supabase schema dump. |
| curriculum_render `pdf/`, `csv/`, `assets/`, `worksheets/`, `map.tex` | `content/quiz/` | Quiz authoring inputs. Nothing in the app references them. |
| follow-alongs `*.xlsx`, one-off grading PDFs | `content/schedule/`, `content/misc/` | Teacher planning files. |
| both `.github/workflows/` | `.github/workflows/` (rewritten, native) | Monorepo paths. See the table in INSTALL.md. |

## What was left behind (in the parents' git history only)

| Parent path | Reason |
|---|---|
| 287 root `*_SPEC.md`, `*_BUILD.md`, `*_PLAN.md`, prompts, session notes (follow-alongs); the spec and plan files at curriculum_render root | Design diaries. Referenced only from code comments. Live runbooks were kept (`site/*_RUNBOOK.md`, `*_CHECKLIST.md`, `AI_GRADING_INTEGRATION.md`, `DATA_LINEAGE.md`, `STATE_MACHINES.md`). |
| `ti84_trainer.html` (v1 trainer), `ti84-verify.html`, CEmu screenshots | Linked from nothing since the v2 trainer shipped. The v2 trainer itself is kept until `docs/specs/APSTAT_PARK_TRAINER_ABSORB_SPEC.md` is built. |
| 17 week/unit calendar pages (`week_*_calendar.html`, `unit4_schedule_v*.html`, `unit4_5_schedule_v*.html`, `postbreak_calendar.html`) | SY2526 schedules superseded by the Desk. No inbound links. |
| `android-app/` | Deprecated by the teacher (2026-10-14). A future app is built against this layout. |
| `state/`, `handoff/`, `gitnexus-shadow/`, `logs/`, `test-results/`, `design/`, `probe-signal-reports/` | Agent orchestration logs, generated indexes, scratch. |
| `test_*.html` at curriculum_render root | Storage experiments from 2025. |
| `railway-server/*.log`, `railway-server/state/` | Test logs and scratch that were committed by accident. |
| untracked files in both working trees (108 + 66) | Never committed; never part of the product. |

## Things the parents did that this repo does differently

- **One Pages site, two directories.** The old quiz URL `…/curriculum_render/` becomes `…/apstat-park/quiz/`. Every
  absolute URL in the parents is rewritten on sync from `config/identity.json` (`parents` → `current`), so the
  mirrored files here never contain the old base URLs. The same mechanism (`scripts/rebrand.mjs`) retargets the whole
  repo for a new teacher.
- **Cross-repo relative imports became in-repo paths.** The relay's park tests imported
  `../../../follow-alongs/apstat-park/replica.mjs`; the site's tests read `../curriculum_render/railway-server/server.js`;
  CI checked out the second repo. These are rewritten by `sync/transforms.mjs` and listed there with their reasons.
- **Supabase migrations have one home.** `supabase/` carries both chains in the order a fresh project must run them.
- **Secrets are documented, never stored.** `services/*/.env.example` lists every variable each service reads.

## Known gaps

- **`site/scripts/build-work-manifest-ced.mjs --deploy` still writes to `site/roster-server/`.** Left
  untransformed on purpose: `work-manifest-ced-regression.test.js` runs `--deploy` against a temp root laid
  out like the old repo. Copy the result to `services/roster/data/` by hand until the parent fixes the path.
- **`site/u3_random_block_review.html` links to `../curriculum_render/worksheets/u3l5.html` and
  `../curriculum_render/pdf/u3l5_worksheet.pdf`.** The quiz's `worksheets/` and `pdf/` are mirrored to
  `content/quiz/` (not published), so these links only work while the old curriculum_render Pages site is up.
- **`site/tests/frq-rubric-transparency.test.js` fails here.** It reads `git show 72766e65:u1_lesson1_live.html`,
  a commit that exists only in the follow-alongs history (this repo starts fresh).
- **One parent test is excluded: `tests/secure-key-plugin.test.js`.** It tests `android-app/`, which was
  dropped (see the table above).
