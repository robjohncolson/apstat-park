// Path fixes that the monorepo layout needs and the parents cannot carry.
// Applied by sync/sync.mjs, in order, after copying and before the identity rewrite.
//
//   id       short name, shown in the sync summary
//   why      the failing test, broken import, or wrong path that justifies it
//   files    globs relative to the repo root; a leading "!" excludes
//   replace  [[from, to], ...] literal (not regex) replacements, applied in order
//
// Rules: `to` must never contain `from` (sync refuses to run otherwise). A literal file
// entry (no * or ?) with zero hits is a warning: the parent changed and the transform is
// stale. Keep each transform as narrow as the evidence for it.
//
// Layout reminder (parent -> here):
//   follow-alongs/                    -> site/
//   follow-alongs/roster-server/      -> services/roster/
//   curriculum_render/                -> site/quiz/
//   curriculum_render/railway-server/ -> services/relay/
//   curriculum_render/assets/         -> content/quiz/assets/
import fs from 'node:fs';

const identity = JSON.parse(fs.readFileSync(new URL('../config/identity.json', import.meta.url), 'utf8'));
const sitePath = new URL(identity.current.site_base + '/').pathname;          // "/apstat-park/"
const quizPath = new URL(identity.current.quiz_base).pathname.slice(1);      // "apstat-park/quiz"
const regexEscapedUrl = (url) => url.replace(/[/.]/g, (c) => '\\' + c);       // as written in a JS regex literal

export default [
  // ---------------------------------------------------------------- relay (services/relay)
  {
    id: 'relay-park-replica-import',
    why: 'services/relay/apstat-park/*.test.mjs import the client replica from the sibling follow-alongs checkout; it lives at site/apstat-park/ here. Without this, npm run test:relay fails with ERR_MODULE_NOT_FOUND.',
    files: ['services/relay/apstat-park/*.test.mjs'],
    replace: [["'../../../follow-alongs/apstat-park/", "'../../../site/apstat-park/"]],
  },

  // ---------------------------------------------------------------- roster (services/roster) -> site
  {
    id: 'roster-tests-site-root',
    why: "Six roster tests reach the follow-alongs root from roster-server/tests as '../../X' or resolve(rs, '..') (bundle parity with lib/ and data/, Desk + dashboard HTML, scripts/, tools/lib/, doge-keys.js, the crosswalk). That root is site/ here. ENOENT / failed imports otherwise. Fixture and golden helpers use '../../' for the roster root and are not touched.",
    files: [
      'services/roster/tests/bundle-parity.test.js',
      'services/roster/tests/candy-return.test.js',
      'services/roster/tests/classify-answer-source.test.js',
      'services/roster/tests/payout-conservation.test.js',
      'services/roster/tests/quarters-by-date.test.js',
      'services/roster/tests/wallet-custody.test.js',
    ],
    replace: [
      ["const repo = resolve(rs, '..');", "const repo = resolve(rs, '..', '..', 'site');"],
      ["resolve(__dirname, '..', '..', 'teacher-dashboard.html')", "resolve(__dirname, '../../../site/teacher-dashboard.html')"],
      ["resolve(__dirname, '..', '..', 'ap_stats_roadmap_square_mode.html')", "resolve(__dirname, '../../../site/ap_stats_roadmap_square_mode.html')"],
      ["'../../js/", "'../../../site/js/"],
      ["'../../scripts/", "'../../../site/scripts/"],
      ["'../../tools/", "'../../../site/tools/"],
      ["'../../2026-crosswalk.json'", "'../../../site/2026-crosswalk.json'"],
      ["'../../doge-keys.js'", "'../../../site/doge-keys.js'"],
    ],
  },

  // ---------------------------------------------------------------- site: park tests + smokes
  {
    id: 'site-park-relay-imports',
    why: 'site/apstat-park/*.mjs (test:park and the browser smokes) import relay modules and ws from ../../curriculum_render/railway-server/; the relay is services/relay/ here. Broken imports otherwise.',
    files: ['site/apstat-park/*.mjs'],
    replace: [
      ["'../../curriculum_render/railway-server/", "'../../services/relay/"],
      ["'../../curriculum_render/'", "'../quiz/'"],
    ],
  },

  // ---------------------------------------------------------------- site -> roster
  {
    id: 'site-roster-imports',
    why: 'Site tests, lib tests, scripts and tools import roster modules as ../roster-server/*.js; roster-server/ is services/roster/ here. Vitest fails to resolve ~15 test files otherwise.',
    files: ['site/tests/**/*.js', 'site/lib/*.js', 'site/scripts/*.mjs', 'site/tools/*.mjs'],
    replace: [["'../roster-server/", "'../../services/roster/"]],
  },
  {
    id: 'site-tools-lib-roster-import',
    why: 'site/tools/lib/doge-keys.mjs re-exports ../../roster-server/lib/doge-keys.mjs (broken import).',
    files: ['site/tools/lib/doge-keys.mjs'],
    replace: [["'../../roster-server/", "'../../../services/roster/"]],
  },
  {
    id: 'site-roster-paths',
    why: "Site tests and scripts resolve roster files relative to the site root ('roster-server/data/...', 'roster-server', 'class.js'); they live at ../services/roster/ here. ENOENT in ~20 site tests otherwise. build-work-manifest-ced.mjs and its regression test are excluded: their --deploy path is relative to a temp root in the test (see site-work-manifest-ced-test).",
    files: [
      'site/tests/**/*.js',
      '!site/tests/work-manifest-ced-regression.test.js',
      'site/scripts/*.mjs',
      '!site/scripts/build-work-manifest-ced.mjs',
      'site/tools/*.mjs',
    ],
    replace: [
      ["'roster-server/", "'../services/roster/"],
      ["'roster-server',", "'..', 'services', 'roster',"],
      ['"roster-server/', '"../services/roster/'],
    ],
  },
  {
    id: 'site-work-manifest-ced-test',
    why: 'work-manifest-ced-regression.test.js reads the committed roster copy of the Do-Now manifest (ENOENT otherwise). Only the two reads of the repo copy change; the --deploy subtest writes to a temp root laid out like the old repo and stays as is.',
    files: ['site/tests/work-manifest-ced-regression.test.js'],
    replace: [
      ["resolve(repo, 'roster-server/data/work-manifest.json')", "resolve(repo, '../services/roster/data/work-manifest.json')"],
      ["resolve(repo, 'roster-server/data/blooket-lessons.json')", "resolve(repo, '../services/roster/data/blooket-lessons.json')"],
    ],
  },
  {
    id: 'site-work-manifest-ced-live-path-regex',
    why: 'work-manifest-ced-regression.test.js (c) pins the 9-unit builder\'s live paths with a regex ending in roster-server/data/work-manifest.json; site-roster-paths moved that path to ../services/roster/.',
    files: ['site/tests/work-manifest-ced-regression.test.js'],
    replace: [['/roster-server\\/data\\/work-manifest\\.json$/', '/services\\/roster\\/data\\/work-manifest\\.json$/']],
  },
  {
    id: 'site-grade-engine-roster-dir',
    why: "scripts/build-grade-engine.mjs bundles the roster grade modules from resolve(ROOT, 'roster-server'); grade-engine-bundle-parity and lineage freshness tests regenerate the bundle (ENOENT otherwise).",
    files: ['site/scripts/build-grade-engine.mjs'],
    replace: [["resolve(ROOT, 'roster-server')", "resolve(ROOT, '../services/roster')"]],
  },
  {
    id: 'site-lineage-roster-paths',
    why: 'data/lineage.json lists roster artifacts, pins and regeneration commands relative to the site root (roster-server/...); lineage.test.js checks every one exists. Prose fields that merely name the service are left alone.',
    files: ['site/data/lineage.json'],
    replace: [
      ['"roster-server/', '"../services/roster/'],
      ['"node roster-server/', '"node ../services/roster/'],
      ['"cd roster-server && ', '"cd ../services/roster && '],
    ],
  },
  {
    id: 'site-data-lineage-md-roster-paths',
    why: 'DATA_LINEAGE.md is the committed render of data/lineage.json; lineage.test.js requires it to equal a fresh render, so it takes the same path changes as site-lineage-roster-paths (backtick-quoted in the Markdown).',
    files: ['site/DATA_LINEAGE.md'],
    replace: [
      ['`roster-server/', '`../services/roster/'],
      ['`node roster-server/', '`node ../services/roster/'],
      ['`cd roster-server && ', '`cd ../services/roster && '],
    ],
  },
  {
    id: 'site-frq-regrade-workflow-path',
    why: 'frq-regrade-job.test.js reads .github/workflows/frq-regrade.yml relative to the site root; the workflow is at the repo root here (written natively with the same assertions kept true).',
    files: ['site/tests/frq-regrade-job.test.js'],
    replace: [["resolve(ROOT, '.github/workflows/", "resolve(ROOT, '../.github/workflows/"]],
  },
  {
    id: 'site-audit-question-assets',
    why: "scripts/audit-question-context.mjs resolves image attachments (assets/pngs/...) against the quiz root; the quiz's assets/ is content/quiz/assets/ here (not published). audit-script.test.js expects IMAGE_OK for a present PNG.",
    files: ['site/scripts/audit-question-context.mjs'],
    replace: [
      ["resolve(CR_ROOT, 'assets', 'pngs')", "resolve(ROOT, '../content/quiz/assets/pngs')"],
      ['const fullPath = resolve(CR_ROOT, rawPath);', "const fullPath = rawPath.startsWith('assets/') ? resolve(ROOT, '../content/quiz', rawPath) : resolve(CR_ROOT, rawPath);"],
    ],
  },
  {
    id: 'site-audit-script-quiz-src',
    why: 'audit-script.test.js finds the curriculum.js <script> in study_guide_diagnostic.html by the string curriculum_render/data/curriculum.js; site-study-guide-quiz-data changed that src to quiz/data/curriculum.js.',
    files: ['site/tests/audit-script.test.js'],
    replace: [["content.indexOf('curriculum_render/data/curriculum.js')", "content.indexOf('quiz/data/curriculum.js')"]],
  },
  {
    id: 'site-python-roster-paths',
    why: 'The Schoology tools and their pytest files join REPO_ROOT with "roster-server" (schedule, answer key, .env); wrong path here.',
    files: ['site/tools/*.py', 'site/tests/*.py'],
    replace: [['"roster-server",', '"..", "services", "roster",']],
  },

  // ---------------------------------------------------------------- site -> quiz / relay
  {
    id: 'site-cr-segment-paths',
    why: "Site tests and scripts build paths as (root, '..', 'curriculum_render', ...). railway-server is services/relay/ and the quiz root is site/quiz/ here. candy-poke, doge-presence-submenu, level-editor*, fetch-offline-videos and build-offline-pack read missing files otherwise.",
    files: ['site/tests/**/*.js', 'site/scripts/*.mjs'],
    replace: [
      ["'..', 'curriculum_render', 'railway-server',", "'..', 'services', 'relay',"],
      ["'..', 'curriculum_render'", "'quiz'"],
    ],
  },
  {
    id: 'site-cr-string-paths',
    why: "Site scripts, lib modules and tests reference the quiz repo as '../curriculum_render/...' relative to the site root (curriculum.js, frameworks.js, assets/pngs, railway-server/apstat-park). Here: data -> quiz/, assets -> ../content/quiz/assets/, railway-server -> ../services/relay/.",
    files: ['site/tests/**/*.js', 'site/scripts/*.mjs', 'site/lib/*.mjs'],
    replace: [
      ["'../curriculum_render/railway-server/", "'../services/relay/"],
      ["'../curriculum_render/assets/", "'../content/quiz/assets/"],
      ["'../curriculum_render/", "'quiz/"],
      ["'../curriculum_render'", "'quiz'"],
    ],
  },
  {
    id: 'site-cr-railway-copy-targets',
    why: "ced-no-raw-keys.test.js and sync-ced-crosswalk.mjs treat the quiz root as the whole curriculum_render repo and reach 'railway-server/data/2026-crosswalk.json' under it; here that copy is services/relay/data/ (two levels up from site/quiz).",
    files: ['site/tests/ced-no-raw-keys.test.js', 'site/scripts/sync-ced-crosswalk.mjs'],
    replace: [["'railway-server/data/2026-crosswalk.json'", "'../../services/relay/data/2026-crosswalk.json'"]],
  },
  {
    id: 'site-curriculum-js-default',
    why: 'misconception-map-sources.mjs falls back to an absolute path into the sibling curriculum_render checkout when CURRICULUM_JS is unset; here the file is site/quiz/data/curriculum.js. Lets misconception-maps.test.js run without the env (CI no longer checks out a second repo).',
    files: ['site/scripts/misconception-map-sources.mjs'],
    replace: [[
      "process.env.CURRICULUM_JS || 'C:/Users/rober/Downloads/Projects/school/curriculum_render/data/curriculum.js'",
      "process.env.CURRICULUM_JS || resolve(ROOT, 'quiz/data/curriculum.js')",
    ]],
  },
  {
    id: 'site-study-guide-quiz-data',
    why: 'study_guide_diagnostic.html loads the quiz data and links questions via ../curriculum_render/ (the sibling Pages site). Here the quiz is published at quiz/ under the same site, so the page is self-contained. (study-guide.test.js pins these src strings; site-cr-string-paths already moves them to quiz/.)',
    files: ['site/study_guide_diagnostic.html', 'site/gitnexus-shadow/study_guide_diagnostic.inline.js'],
    replace: [["../curriculum_render/", "quiz/"]],
  },

  // ---------------------------------------------------------------- quiz (site/quiz) -> relay
  {
    id: 'quiz-relay-paths',
    why: "Quiz tests import and read the relay as ../railway-server/* or (ROOT, 'railway-server/...'); the relay is services/relay/ here (three levels up from site/quiz/tests).",
    files: ['site/quiz/tests/**/*.js'],
    replace: [
      ["'../railway-server/", "'../../../services/relay/"],
      ["'railway-server/", "'../../services/relay/"],
      ["'railway-server',", "'..', '..', 'services', 'relay',"],
    ],
  },
  {
    id: 'quiz-vitest-relay-tests',
    why: "The quiz's vitest config also runs the relay's own unit tests (railway-server/tests, 13 files, ~350 tests). They are services/relay/tests here; without this they silently stop running (no other suite picks them up).",
    files: ['site/quiz/vitest.config.js'],
    replace: [["'railway-server/tests/**/*.test.{js,ts}'", "'../../services/relay/tests/**/*.test.{js,ts}'"]],
  },
  {
    id: 'quiz-crosswalk-source',
    why: "ced-crosswalk-identity.test.js compares the vendored crosswalk copies with ../follow-alongs/2026-crosswalk.json; the source is site/2026-crosswalk.json here (one level up from site/quiz). Without this the identity check silently skips.",
    files: ['site/quiz/tests/ced-crosswalk-identity.test.js'],
    replace: [["resolve(ROOT, '../follow-alongs/2026-crosswalk.json')", "resolve(ROOT, '../2026-crosswalk.json')"]],
  },

  // ---------------------------------------------------------------- identity-coupled test fixtures
  {
    id: 'site-journey-page-prefix',
    why: "tests/journeys/harness.js serves repo files for URLs under PAGE_PREFIX, which must match the path of DESK_URL. The identity rewrite moves DESK_URL to the new Pages base; this keeps PAGE_PREFIX in step (derived from config/identity.json). Every journey and pico-home test fails with 'Sign-in unavailable (offline)' otherwise.",
    files: ['site/tests/journeys/harness.js'],
    replace: [["const PAGE_PREFIX = '/apstats-live-worksheet/';", `const PAGE_PREFIX = '${sitePath}';`]],
  },
  {
    id: 'site-desk-verify-quiz-url',
    why: "desk-verify-tools.test.js pins the Desk's verify links by the quiz path 'curriculum_render/<page>.html'; the identity rewrite moves the quiz to the new Pages base (derived from config/identity.json).",
    files: ['site/tests/desk-verify-tools.test.js'],
    replace: [
      ["'curriculum_render/teacher-verify.html'", `'${quizPath}/teacher-verify.html'`],
      ["'curriculum_render/verify.html'", `'${quizPath}/verify.html'`],
    ],
  },
  {
    id: 'site-dok-url-regex',
    why: 'desk-dok-ladder-row.test.js and desk-teacher-dok-app.test.js pin the DOK app URL with a regex literal; the identity rewrite changes the URL in the Desk, so the regex must follow (derived from config/identity.json).',
    files: ['site/tests/desk-dok-ladder-row.test.js', 'site/tests/desk-teacher-dok-app.test.js'],
    replace: [[regexEscapedUrl(identity.parents.site_base), regexEscapedUrl(identity.current.site_base)]],
  },
];
