// Pure planning logic for scripts/setup.mjs (no prompts, no file I/O, no network).
import path from 'node:path';
import { SERVICES, GROUPS, serviceKeys, identityValue, isSet, isPlaceholder } from './env.mjs';
import { generate, ed25519PublicFromPrivate } from './secrets.mjs';

// Local-only operator keys that no service reads (doctor.mjs uses them). Gitignored by `.env`.
export const OPERATOR_ENV = '.env';
export const SECTIONS_RE = /^[A-Za-z0-9_-]+:[^;:]+(;[A-Za-z0-9_-]+:[^;:]+)*$/;

export const trimUrl = (u) => String(u ?? '').trim().replace(/\/+$/, '');
export const pagesBase = (user, repo) => `https://${String(user).toLowerCase()}.github.io/${repo}`;
export function supabaseRef(url) {
  const m = String(url || '').match(/^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/i);
  return m ? m[1] : '';
}

// The answer `later` for a Railway URL writes this placeholder. check-env and doctor FAIL on it.
export const LATER = 'later';
export const PLACEHOLDER_URLS = {
  roster_url: 'https://TODO-roster.up.railway.app',
  relay_url: 'https://TODO-relay.up.railway.app'
};

// A teacher other than the original one (identity.parents.github_user) is setting up their own copy.
export function isNewTeacher(ctx, answers) {
  const user = String(answers.github_user || '').toLowerCase();
  return user !== String(ctx.originalUser).toLowerCase();
}

// Default for a Railway URL: the teacher's previous answer (.env) or identity.json, but NEVER the
// original teacher's live deployment for a new teacher. Empty means they must type a URL or `later`.
function railwayDefault(ctx, answers, id) {
  const candidates = id === 'roster_url'
    ? [ctx.env.relay.ROSTER_SERVICE_URL, ctx.cur.roster_url]
    : [ctx.env.roster.PARK_RELAY_URL, ctx.cur.relay_url];
  for (const raw of candidates) {
    const url = trimUrl(raw);
    if (!url) continue;
    if (isNewTeacher(ctx, answers) && url === trimUrl(ctx.originalUrls[id])) continue;
    return url;
  }
  return '';
}

// Default for a Supabase value: identity.json's current value, but NEVER the original teacher's
// project for a new teacher (their students' data must not land in the original database).
function supabaseDefault(ctx, answers, id) {
  for (const raw of [ctx.next[id], ctx.cur[id]]) {
    const value = String(raw || '').trim();
    if (!value) continue;
    if (isNewTeacher(ctx, answers) && value === ctx.originalSupabase[id]) continue;
    return value;
  }
  return '';
}

// `later` (any case) becomes the placeholder URL; everything else is returned unchanged.
export function expandLater(question, value) {
  if (!question.deferrable) return value;
  if (String(value).trim().toLowerCase() !== LATER) return value;
  return PLACEHOLDER_URLS[question.id];
}

// The questions, in order. `def(ctx, answersSoFar)` gives the default shown to the teacher.
export function questions() {
  return [
    { id: 'github_user', q: 'GitHub user (owner of the repo)', def: (c) => c.cur.github_user || '' },
    { id: 'repo', q: 'Repo name', def: (c) => c.cur.site_repo || 'apstat-park' },
    { id: 'site_base', q: 'GitHub Pages base URL (derived; confirm or replace)', def: (c, a) => pagesBase(a.github_user, a.repo), url: true },
    { id: 'roster_url', q: 'Roster Railway URL (services/roster), or "later"', def: (c, a) => railwayDefault(c, a, 'roster_url'), url: true, deferrable: true },
    { id: 'relay_url', q: 'Relay Railway URL (services/relay), or "later"', def: (c, a) => railwayDefault(c, a, 'relay_url'), url: true, deferrable: true },
    { id: 'supabase_url', q: 'Core Supabase URL', def: (c, a) => supabaseDefault(c, a, 'supabase_url'), url: true },
    { id: 'supabase_anon_key', q: 'Core Supabase anon key (public)', def: (c, a) => supabaseDefault(c, a, 'supabase_anon_key') },
    { id: 'supabase_service_key', q: 'Core Supabase service_role key', secret: true,
      def: (c) => c.env.roster.ROSTER_SUPABASE_SERVICE_KEY || c.env.relay.SUPABASE_SERVICE_KEY || '' },
    { id: 'content_supabase_url', q: 'Content (Desk) Supabase URL', def: (c, a) => supabaseDefault(c, a, 'content_supabase_url'), url: true },
    { id: 'content_supabase_anon_key', q: 'Content Supabase anon key (public)', def: (c, a) => supabaseDefault(c, a, 'content_supabase_anon_key') },
    { id: 'content_supabase_service_key', q: 'Content Supabase service_role key (optional; only used locally by doctor.mjs)', secret: true, optional: true,
      def: (c) => c.env.operator.CONTENT_SUPABASE_SERVICE_KEY || '' },
    { id: 'groq_api_key', q: 'Groq API key (Groq and/or DeepSeek; at least one)', secret: true, optional: true, def: (c) => c.env.relay.GROQ_API_KEY || '' },
    { id: 'deepseek_api_key', q: 'DeepSeek API key', secret: true, optional: true, def: (c) => c.env.relay.DEEPSEEK_API_KEY || '' },
    { id: 'teacher_name', q: 'Teacher display name', optional: true, def: (c) => c.cur.teacher_name || '' },
    { id: 'sections', q: 'Sections (Key:Label;Key:Label)', def: (c) => c.env.roster.OPEN_SIGNUP_SECTIONS || c.sectionsDefault }
  ];
}

export function makeContext(schema, identity, existing) {
  const parents = identity.parents || {};
  return {
    cur: identity.current || {},
    originalUser: parents.github_user || 'robjohncolson',
    originalUrls: { roster_url: parents.roster_url || '', relay_url: parents.relay_url || '' },
    originalSupabase: {
      supabase_url: parents.supabase_url || '', supabase_anon_key: parents.supabase_anon_key || '',
      content_supabase_url: parents.content_supabase_url || '', content_supabase_anon_key: parents.content_supabase_anon_key || ''
    },
    env: { roster: existing.roster || {}, relay: existing.relay || {}, operator: existing.operator || {} },
    next: existing.next || {},
    sectionsDefault: schema.roster?.recommended?.OPEN_SIGNUP_SECTIONS?.default || ''
  };
}

// Returns an error string or '' for one answer.
export function checkAnswer(question, value, answers) {
  const v = String(value ?? '').trim();
  if (!v && question.deferrable) {
    return `${question.id} is required: enter your own Railway URL, or "${LATER}" to write the placeholder ${PLACEHOLDER_URLS[question.id]} and re-run setup once the service exists`;
  }
  if (!v && !question.optional) return `${question.id} is required`;
  if (v && question.url && !/^https?:\/\/[^\s]+$/.test(v)) return `${question.id} must be an http(s) URL`;
  if (question.id === 'sections' && v && !SECTIONS_RE.test(v)) return 'sections must look like PeriodB:Period B;PeriodE:Period E';
  if (question.id === 'deepseek_api_key' && !v && !String(answers.groq_api_key || '').trim()) return 'set at least one of the Groq / DeepSeek keys';
  return '';
}

// Fill unanswered questions with defaults and validate. Throws on the first invalid answer.
export function resolveAnswers(ctx, given = {}) {
  const a = {};
  for (const q of questions()) {
    const raw = given[q.id] !== undefined && given[q.id] !== null ? String(given[q.id]) : q.def(ctx, a);
    const v = expandLater(q, raw);
    a[q.id] = q.url ? trimUrl(v) : String(v).trim();
    const err = checkAnswer(q, a[q.id], a);
    if (err) throw new Error(err);
  }
  return a;
}

// Every key setup generates: [{ svc, key, kind, sharedWith }]
export function generatedKeys(schema) {
  const out = [];
  for (const svc of SERVICES) {
    for (const { key, spec } of serviceKeys(schema, svc)) if (spec.generate) out.push({ svc, key, kind: spec.generate, sharedWith: spec.shared_with || [] });
  }
  return out;
}

/**
 * planSetup({ schema, identity, answers, existing, rotate })
 *   answers   resolved answers (resolveAnswers)
 *   existing  { roster: {...}, relay: {...}, operator: {...} } current local .env contents ({} if missing)
 *   rotate    Set of 'KEY' or 'svc:KEY' the teacher chose to regenerate even though a value exists
 */
export function planSetup({ schema, identity, answers: a, existing, rotate = new Set() }) {
  const warnings = [];
  const generated = [];
  const cur = {
    ...(identity.current || {}),
    site_base: a.site_base,
    quiz_base: `${a.site_base}/quiz`,
    roster_url: a.roster_url,
    relay_url: a.relay_url,
    supabase_url: a.supabase_url,
    supabase_project_ref: supabaseRef(a.supabase_url),
    supabase_anon_key: a.supabase_anon_key,
    github_user: a.github_user,
    site_repo: a.repo,
    quiz_repo: a.repo,
    content_supabase_url: a.content_supabase_url,
    content_supabase_project_ref: supabaseRef(a.content_supabase_url),
    content_supabase_anon_key: a.content_supabase_anon_key
  };
  if (a.teacher_name) cur.teacher_name = a.teacher_name;
  else delete cur.teacher_name;
  for (const id of deferredUrls(a)) warnings.push(`${id} deferred: wrote placeholder ${a[id]}; re-run setup with the real URL before going live`);
  if (!cur.supabase_project_ref) warnings.push(`core Supabase URL ${a.supabase_url} is not https://<ref>.supabase.co; supabase_project_ref left empty`);
  if (!cur.content_supabase_project_ref) warnings.push(`content Supabase URL ${a.content_supabase_url} is not https://<ref>.supabase.co; content_supabase_project_ref left empty`);

  const identityNext = {
    ...identity,
    $comment: `${identity.$comment || ''} [identity.next.json written by scripts/setup.mjs; apply with node scripts/rebrand.mjs --to config/identity.next.json]`.trim(),
    current: cur
  };

  const envs = { roster: { ...(existing.roster || {}) }, relay: { ...(existing.relay || {}) } };
  const shouldRotate = (svc, key) => rotate.has(key) || rotate.has(`${svc}:${key}`);

  // 1. identity-derived keys, defaults for required/recommended
  for (const svc of SERVICES) {
    for (const { key, group, spec } of serviceKeys(schema, svc)) {
      const want = identityValue(spec, cur);
      if (want !== undefined) envs[svc][key] = want;
      else if ((group === 'required' || group === 'recommended') && spec.default !== undefined && !isSet(envs[svc][key])) envs[svc][key] = spec.default;
    }
  }

  // 2. answered keys
  Object.assign(envs.roster, {
    ROSTER_SUPABASE_SERVICE_KEY: a.supabase_service_key,
    PC_FIGURES_SUPABASE_SERVICE_KEY: a.supabase_service_key,
    OPEN_SIGNUP_SECTIONS: a.sections
  });
  Object.assign(envs.relay, { SUPABASE_SERVICE_KEY: a.supabase_service_key });
  for (const [key, ans] of [['GROQ_API_KEY', 'groq_api_key'], ['DEEPSEEK_API_KEY', 'deepseek_api_key']]) {
    if (a[ans]) envs.relay[key] = a[ans];
    else delete envs.relay[key];
  }

  // 3. generated secrets (reuse unless rotated), honouring shared_with
  for (const { svc, key, kind, sharedWith } of generatedKeys(schema)) {
    const own = existing[svc]?.[key];
    const peers = sharedWith.map((o) => existing[o]?.[key]).filter(isSet);
    let value;
    let reused = false;
    if (isSet(own) && !shouldRotate(svc, key)) {
      value = own; reused = true;
      for (const p of peers) if (p !== own) warnings.push(`${key}: ${sharedWith.join('/')} had a different value; using ${svc}'s for both sides`);
    } else if (!isSet(own) && peers.length && !shouldRotate(svc, key)) {
      value = peers[0]; reused = true;
    } else {
      value = generate(kind);
    }
    envs[svc][key] = value;
    for (const o of sharedWith) envs[o][key] = value;
    generated.push({ svc, key, kind, reused, sharedWith });
  }

  // 4. roster trusts the relay's issuer key for AI review grants
  const relayPub = ed25519PublicFromPrivate(envs.relay.RECEIPT_ISSUER_PRIVATE_KEY || '');
  if (relayPub) envs.roster.REVIEW_GRANT_PUBKEY = relayPub;
  else warnings.push("relay RECEIPT_ISSUER_PRIVATE_KEY is not a base64 PKCS8 Ed25519 key; REVIEW_GRANT_PUBKEY not set (rotate it to fix)");

  const operator = { ...(existing.operator || {}) };
  operator.CONTENT_SUPABASE_URL = a.content_supabase_url;
  if (a.content_supabase_service_key) operator.CONTENT_SUPABASE_SERVICE_KEY = a.content_supabase_service_key;

  return { identityNext, envs, operator, generated, warnings, relayPubkey: relayPub };
}

export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function railwayCommands(schema, envs) {
  const out = {};
  for (const svc of SERVICES) {
    out[svc] = [];
    const settable = GROUPS.filter((g) => g !== 'platform' && g !== 'test_only');
    for (const g of settable) {
      for (const key of Object.keys(schema[svc][g] || {})) {
        if (isSet(envs[svc][key])) out[svc].push(`railway variables --service ${svc} --set ${shq(`${key}=${envs[svc][key]}`)}`);
      }
    }
  }
  return out;
}

export function ghCommands(schema, envs, answers) {
  const repo = `${answers.github_user}/${answers.repo}`;
  const lines = [];
  for (const svc of SERVICES) {
    for (const { key, spec } of serviceKeys(schema, svc)) {
      if (spec.github_secret && isSet(envs[svc][key])) lines.push(`gh secret set ${spec.github_secret} --repo ${repo} --body ${shq(envs[svc][key])}`);
    }
  }
  return lines;
}

// Which Railway URLs were deferred with `later`.
export function deferredUrls(answers) {
  return ['roster_url', 'relay_url'].filter((id) => isPlaceholder(answers[id]));
}

export function checklist(schema, answers) {
  const repo = `${answers.github_user}/${answers.repo}`;
  const deferred = deferredUrls(answers);
  const first = [];
  if (deferred.length) {
    first.push(`Railway URLs deferred (${deferred.join(', ')} are TODO placeholders; check-env and doctor FAIL until fixed): once both services have public URLs, re-run node scripts/setup.mjs with the real URLs, then rebrand again and update the Railway variables.`);
  }
  return [
    ...first,
    `Railway: create two services from GitHub repo ${repo}: "roster" with Root Directory ${schema.roster.railway_root_directory}, "relay" with Root Directory ${schema.relay.railway_root_directory}. Health check path /health on both. (Names must match the --service flags above, or edit them.)`,
    'Railway: paste the variables above, then confirm each service\'s public URL matches what you entered (roster_url / relay_url).',
    `GitHub: Settings > Pages > Build and deployment > Source = "GitHub Actions" for ${repo}.`,
    'Supabase: run the SQL for both projects in the order given by supabase/README.md (core project first, then content), or with psql: bash supabase/apply.sh core <db-url> and bash supabase/apply.sh content <db-url>.',
    `Supabase (content project): update the lesson_urls rows so worksheet_url points at ${answers.site_base}/... (doctor.mjs warns while they still point at an old site).`,
    'Then: node scripts/rebrand.mjs --to config/identity.next.json, review the diff, commit, push.',
    'Finally: node scripts/doctor.mjs --env'
  ];
}

export function relPath(root, file) {
  return path.relative(root, file).replace(/\\/g, '/');
}
