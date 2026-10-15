// Runs scripts/setup.mjs and scripts/check-env.mjs non-interactively against a scratch root. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from './args.mjs';
import { parseEnv } from './env.mjs';
import { ed25519PublicFromPrivate } from './secrets.mjs';

const node = (script, args, root) => spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', script), ...args, '--root', root], {
  encoding: 'utf8', env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT }
});

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apstat-setup-'));
  fs.mkdirSync(path.join(dir, 'config'));
  for (const f of ['env-schema.json', 'identity.json']) fs.copyFileSync(path.join(REPO_ROOT, 'config', f), path.join(dir, 'config', f));
  return dir;
}
const readEnv = (root, svc) => parseEnv(fs.readFileSync(path.join(root, 'services', svc, '.env'), 'utf8'));

const ANSWERS = {
  github_user: 'NewTeacher',
  repo: 'stats-park',
  roster_url: 'https://roster-new.up.railway.app/',
  relay_url: 'https://relay-new.up.railway.app',
  supabase_url: 'https://abcdefghijklmnop.supabase.co',
  supabase_anon_key: 'anon-core',
  supabase_service_key: 'service-core-secret',
  content_supabase_url: 'https://qrstuvwxyzabcdef.supabase.co',
  content_supabase_anon_key: 'anon-content',
  content_supabase_service_key: 'service-content-secret',
  groq_api_key: 'gsk_test_key',
  teacher_name: 'Ms. New',
  sections: 'P1:Period 1;P3:Period 3'
};

test('setup --answers writes both .env files, identity.next.json, and they validate', (t) => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const r = node('setup.mjs', ['--answers', JSON.stringify(ANSWERS)], root);
  assert.equal(r.status, 0, r.stderr + r.stdout);

  const roster = readEnv(root, 'roster');
  const relay = readEnv(root, 'relay');
  for (const k of ['ROSTER_TOKEN_SECRET', 'ROSTER_GRADER_SECRET', 'PARK_KEY_GRANT_SECRET']) {
    assert.match(roster[k], /^[0-9a-f]{64}$/);
    assert.equal(relay[k], roster[k], `${k} shared`);
  }
  assert.match(roster.TEACHER_KEY, /^([a-z]+-){4}\d{2}$/);
  assert.notEqual(roster.RECEIPT_ISSUER_PRIVATE_KEY, relay.RECEIPT_ISSUER_PRIVATE_KEY);
  assert.equal(roster.REVIEW_GRANT_PUBKEY, ed25519PublicFromPrivate(relay.RECEIPT_ISSUER_PRIVATE_KEY));
  assert.equal(roster.PARK_RELAY_URL, 'https://relay-new.up.railway.app');
  assert.equal(relay.ROSTER_SERVICE_URL, 'https://roster-new.up.railway.app');
  assert.equal(relay.CURRICULUM_URL, 'https://newteacher.github.io/stats-park/quiz/data/curriculum.js');
  assert.equal(roster.OPEN_SIGNUP_SECTIONS, 'P1:Period 1;P3:Period 3');
  assert.equal(relay.GROQ_API_KEY, 'gsk_test_key');
  assert.equal(parseEnv(fs.readFileSync(path.join(root, '.env'), 'utf8')).CONTENT_SUPABASE_SERVICE_KEY, 'service-content-secret');

  const next = JSON.parse(fs.readFileSync(path.join(root, 'config', 'identity.next.json'), 'utf8'));
  assert.equal(next.current.site_base, 'https://newteacher.github.io/stats-park');
  assert.equal(next.current.supabase_project_ref, 'abcdefghijklmnop');
  assert.equal(next.current.content_supabase_project_ref, 'qrstuvwxyzabcdef');
  assert.equal(next.current.teacher_name, 'Ms. New');
  assert.deepEqual(next.parents, JSON.parse(fs.readFileSync(path.join(root, 'config', 'identity.json'), 'utf8')).parents);

  assert.match(r.stdout, /node scripts\/rebrand\.mjs --to config\/identity\.next\.json/);
  assert.match(r.stdout, /railway variables --service roster --set 'ROSTER_TOKEN_SECRET=[0-9a-f]{64}'/);
  assert.match(r.stdout, /gh secret set APSTATS_TEACHER_KEY --repo NewTeacher\/stats-park/);
  assert.match(r.stdout, /supabase\/README\.md/);

  // check-env against the scratch root: shared secrets match, identity drift is only a WARN
  // (identity.json is still the old teacher until rebrand runs).
  for (const svc of ['roster', 'relay']) {
    const c = node('check-env.mjs', [svc, '--json', '--no-process-env'], root);
    const res = JSON.parse(c.stdout);
    assert.equal(c.status, 0, JSON.stringify(res.rows.filter((x) => x.status === 'FAIL')));
    assert.ok(!c.stdout.includes(roster.ROSTER_TOKEN_SECRET), 'secret printed');
  }
});

test('setup re-run keeps existing secrets unless rotated', (t) => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(node('setup.mjs', ['--answers', JSON.stringify(ANSWERS)], root).status, 0);
  const first = { roster: readEnv(root, 'roster'), relay: readEnv(root, 'relay') };

  // Defaults come from the existing .env files, so an empty answer set is enough.
  const again = node('setup.mjs', ['--answers', JSON.stringify({ github_user: 'NewTeacher', repo: 'stats-park', rotate: ['TEACHER_KEY'] })], root);
  assert.equal(again.status, 0, again.stderr);
  const second = { roster: readEnv(root, 'roster'), relay: readEnv(root, 'relay') };
  assert.equal(second.roster.ROSTER_TOKEN_SECRET, first.roster.ROSTER_TOKEN_SECRET);
  assert.equal(second.relay.RECEIPT_ISSUER_PRIVATE_KEY, first.relay.RECEIPT_ISSUER_PRIVATE_KEY);
  assert.equal(second.roster.REVIEW_GRANT_PUBKEY, first.roster.REVIEW_GRANT_PUBKEY);
  assert.equal(second.roster.ROSTER_SUPABASE_SERVICE_KEY, 'service-core-secret');
  assert.equal(second.relay.GROQ_API_KEY, 'gsk_test_key');
  assert.notEqual(second.roster.TEACHER_KEY, first.roster.TEACHER_KEY);
});

test('setup --dry-run writes nothing; missing AI key is rejected', (t) => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dry = node('setup.mjs', ['--dry-run', '--answers', JSON.stringify(ANSWERS)], root);
  assert.equal(dry.status, 0, dry.stderr);
  assert.ok(!fs.existsSync(path.join(root, 'services')));
  assert.ok(!fs.existsSync(path.join(root, 'config', 'identity.next.json')));
  const bad = node('setup.mjs', ['--dry-run', '--answers', JSON.stringify({ ...ANSWERS, groq_api_key: '' })], root);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Groq \/ DeepSeek/);
});

test('check-env --render-examples writes both .env.example files; check-env flags shared mismatch', (t) => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const r = node('check-env.mjs', ['--render-examples'], root);
  assert.equal(r.status, 0, r.stderr);
  for (const svc of ['roster', 'relay']) assert.match(fs.readFileSync(path.join(root, 'services', svc, '.env.example'), 'utf8'), /GENERATED by/);

  assert.equal(node('setup.mjs', ['--answers', JSON.stringify(ANSWERS)], root).status, 0);
  const relayFile = path.join(root, 'services', 'relay', '.env');
  fs.writeFileSync(relayFile, fs.readFileSync(relayFile, 'utf8').replace(/^ROSTER_GRADER_SECRET=.*$/m, 'ROSTER_GRADER_SECRET=mismatch'));
  const c = node('check-env.mjs', ['relay', '--no-process-env'], root);
  assert.equal(c.status, 1);
  assert.match(c.stdout, /FAIL\s+ROSTER_GRADER_SECRET\s+mism\.\.\.\(8\)\s+.*must equal roster's ROSTER_GRADER_SECRET, but differs \(this side: ROSTER_GRADER_SECRET from relay's \.env/);
});

test('setup: a new teacher never inherits the original Railway URLs', (t) => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { roster_url, relay_url, ...noUrls } = ANSWERS;
  const r = node('setup.mjs', ['--dry-run', '--answers', JSON.stringify(noUrls)], root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /roster_url is required: enter your own Railway URL, or "later"/);
  assert.doesNotMatch(r.stdout, /roster-production-12c1/);
});

test('setup: the original teacher keeps the current Railway URLs as defaults', (t) => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { roster_url, relay_url, ...noUrls } = ANSWERS;
  const r = node('setup.mjs', ['--answers', JSON.stringify({ ...noUrls, github_user: 'robjohncolson', repo: 'apstat-park' })], root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readEnv(root, 'relay').ROSTER_SERVICE_URL, 'https://roster-production-12c1.up.railway.app');
});

test('setup: "later" writes placeholder URLs, lists the re-run step, and check-env FAILs on them', (t) => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const r = node('setup.mjs', ['--answers', JSON.stringify({ ...ANSWERS, roster_url: 'later', relay_url: 'LATER' })], root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readEnv(root, 'relay').ROSTER_SERVICE_URL, 'https://TODO-roster.up.railway.app');
  assert.equal(readEnv(root, 'roster').PARK_RELAY_URL, 'https://TODO-relay.up.railway.app');
  const next = JSON.parse(fs.readFileSync(path.join(root, 'config', 'identity.next.json'), 'utf8'));
  assert.equal(next.current.roster_url, 'https://TODO-roster.up.railway.app');
  assert.match(r.stdout, /\[ \] 1\. Railway URLs deferred \(roster_url, relay_url are TODO placeholders/);
  assert.match(r.stdout, /re-run node scripts\/setup\.mjs with the real URLs/);

  const c = node('check-env.mjs', ['relay', '--no-process-env'], root);
  assert.equal(c.status, 1);
  assert.match(c.stdout, /FAIL\s+ROSTER_SERVICE_URL\s+https:\/\/TODO-roster\.up\.railway\.app\s+placeholder/);

  // re-running keeps the placeholder as the default until a real URL is given
  const again = node('setup.mjs', ['--answers', JSON.stringify({ github_user: 'NewTeacher', repo: 'stats-park', roster_url: 'https://roster-real.up.railway.app' })], root);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readEnv(root, 'relay').ROSTER_SERVICE_URL, 'https://roster-real.up.railway.app');
  assert.equal(readEnv(root, 'roster').PARK_RELAY_URL, 'https://TODO-relay.up.railway.app');
});

test('setup: the summary warns that the commands contain secrets', (t) => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const r = node('setup.mjs', ['--dry-run', '--answers', JSON.stringify(ANSWERS)], root);
  assert.equal(r.status, 0, r.stderr);
  const notice = r.stdout.indexOf('contain your secrets in plain text');
  assert.ok(notice > 0, 'notice printed');
  assert.ok(notice < r.stdout.indexOf('railway variables --service'), 'notice comes before the commands');
});

test('setup: a new teacher never inherits the original Supabase projects', (t) => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { supabase_url, supabase_anon_key, content_supabase_url, content_supabase_anon_key, ...noSupabase } = ANSWERS;
  const r = node('setup.mjs', ['--dry-run', '--answers', JSON.stringify(noSupabase)], root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /supabase_url is required/);
  assert.doesNotMatch(r.stdout, /bzqbhtrurzzavhqbgqrs|hgvnytaqmuybzbotosyj/);
});
