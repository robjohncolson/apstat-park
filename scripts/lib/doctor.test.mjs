// doctor.mjs with an injected fetch and gh: no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './args.mjs';
import { runDoctor } from '../doctor.mjs';
import { ed25519 } from './secrets.mjs';

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apstat-doctor-'));
  fs.mkdirSync(path.join(dir, 'config'));
  for (const f of ['env-schema.json', 'identity.json']) fs.copyFileSync(path.join(REPO_ROOT, 'config', f), path.join(dir, 'config', f));
  return dir;
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeFetch(site, overrides = {}) {
  return async (url) => {
    for (const [frag, res] of Object.entries(overrides)) if (url.includes(frag)) return res();
    if (url.endsWith('/health') && url.includes('roster')) return json(200, { ok: true, service: 'roster', commit: 'abc123', receipts: { enabled: true, pubkey: 'RPUB', persistFailures: 0 } });
    if (url.endsWith('/health')) return json(200, { status: 'healthy', receipts: { enabled: true, pubkey: 'PUB' } });
    if (url.endsWith('/rest/v1/')) return json(401, { message: 'Invalid API key', hint: 'Only the `service_role` API key can be used for this endpoint.' });
    if (url.includes('lesson_urls')) return json(200, [{ topic: '1.1', worksheet_url: `${site}/u1_lesson1_live.html` }]);
    if (url.includes('/rest/v1/')) return json(200, []);
    return new Response('ok', { status: 200 });
  };
}
const noGh = () => ({ missing: true, code: -1, stdout: '', stderr: '' });

test('doctor: all healthy -> ok, reports commit, gh missing is WARN', async (t) => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const site = JSON.parse(fs.readFileSync(path.join(root, 'config', 'identity.json'))).current.site_base;
  const res = await runDoctor({ root, fetchImpl: fakeFetch(site), gh: noGh });
  assert.equal(res.ok, true, JSON.stringify(res.rows));
  assert.ok(res.rows.some((r) => r.note.includes('commit abc123')));
  assert.ok(res.rows.some((r) => r.status === 'WARN' && r.check === 'github'));
});

test('doctor: page 404, bad anon key, stale lesson_urls, missing table', async (t) => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const site = JSON.parse(fs.readFileSync(path.join(root, 'config', 'identity.json'))).current.site_base;
  fs.mkdirSync(path.join(root, 'supabase'));
  fs.writeFileSync(path.join(root, 'supabase', 'expected-tables.json'), JSON.stringify({ core: ['answers', 'gone'], content: ['lesson_urls'] }));
  fs.mkdirSync(path.join(root, 'services', 'roster'), { recursive: true });
  fs.writeFileSync(path.join(root, 'services', 'roster', '.env'), `ROSTER_SUPABASE_SERVICE_KEY=svc\nREVIEW_GRANT_PUBKEY=${ed25519().publicKey}\n`);
  const res = await runDoctor({
    root, withEnv: true, gh: noGh,
    fetchImpl: fakeFetch(site, {
      'ap_stats_roadmap_square_mode.html': () => new Response('nope', { status: 404 }),
      '/rest/v1/gone': () => json(404, { code: 'PGRST205', message: 'Could not find the table' }),
      'lesson_urls?select=topic': () => json(200, [{ topic: '4.6', worksheet_url: 'https://old.example/u4.html' }]),
      // first match wins, so this only catches the content project's REST root
      'hgvnytaqmuybzbotosyj.supabase.co/rest/v1/': () => json(401, { message: 'Invalid API key', hint: 'Double check your key' })
    })
  });
  const find = (s) => res.rows.find((r) => r.check.includes(s));
  assert.equal(res.ok, false);
  assert.equal(find('ap_stats_roadmap_square_mode').status, 'FAIL');
  assert.equal(find('content lesson_urls').status, 'WARN');
  assert.equal(find('supabase content https').status, 'FAIL');
  assert.match(find('supabase content https').note, /anon key rejected/);
  assert.equal(find('supabase core https').status, 'PASS');
  assert.equal(find('table gone').status, 'FAIL');
  assert.equal(find('table gone').note, 'table missing');
  assert.equal(find('table answers').status, 'PASS');
  assert.match(find('supabase content tables').note, /no service key/);
  assert.equal(find('REVIEW_GRANT_PUBKEY vs live relay').status, 'WARN');
  assert.ok(!JSON.stringify(res).includes('svc\\n'));
});

test('doctor: receipts disabled on either service is FAIL', async (t) => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const site = JSON.parse(fs.readFileSync(path.join(root, 'config', 'identity.json'))).current.site_base;
  const res = await runDoctor({
    root, gh: noGh,
    fetchImpl: fakeFetch(site, {
      'roster-production-12c1.up.railway.app/health': () => json(200, { ok: true, receipts: { enabled: false, pubkey: null } }),
      'curriculumrender-production.up.railway.app/health': () => json(200, { status: 'healthy', receipts: { enabled: false, pubkey: null } })
    })
  });
  assert.equal(res.ok, false);
  assert.equal(res.rows.find((r) => r.check === 'roster receipts').status, 'FAIL');
  assert.equal(res.rows.find((r) => r.check === 'relay receipts').status, 'FAIL');
});

test('doctor: buckets WARN without --env, FAIL when missing with --env; realtime listed', async (t) => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const site = JSON.parse(fs.readFileSync(path.join(root, 'config', 'identity.json'))).current.site_base;
  fs.mkdirSync(path.join(root, 'supabase'));
  fs.writeFileSync(path.join(root, 'supabase', 'expected-tables.json'), JSON.stringify({
    core: [], content: [], buckets: { core: ['pc-figures', 'worksheet-diagnostics'], content: ['ti84-trainer-assets'] }, realtime: { core: ['answers'] }
  }));
  const fetchImpl = fakeFetch(site, {
    '/storage/v1/bucket/pc-figures': () => json(200, { id: 'pc-figures', public: false }),
    '/storage/v1/bucket/worksheet-diagnostics': () => json(400, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' })
  });

  const plain = await runDoctor({ root, gh: noGh, fetchImpl });
  assert.match(plain.rows.find((r) => r.check === 'supabase core buckets').note, /not checked/);
  assert.equal(plain.rows.find((r) => r.check === 'supabase core buckets').status, 'WARN');

  fs.mkdirSync(path.join(root, 'services', 'roster'), { recursive: true });
  fs.writeFileSync(path.join(root, 'services', 'roster', '.env'), 'ROSTER_SUPABASE_SERVICE_KEY=svc\n');
  const withEnv = await runDoctor({ root, gh: noGh, fetchImpl, withEnv: true });
  const find = (s) => withEnv.rows.find((r) => r.check === s);
  assert.equal(find('supabase core bucket pc-figures').status, 'PASS');
  assert.equal(find('supabase core bucket worksheet-diagnostics').status, 'FAIL');
  assert.match(find('supabase core bucket worksheet-diagnostics').note, /bucket missing/);
  assert.equal(find('supabase content buckets').status, 'WARN');
  assert.equal(find('supabase core realtime').status, 'INFO');
});

test('doctor: placeholder Railway URLs in the identity are FAIL, not probed', async (t) => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const idFile = path.join(root, 'config', 'identity.json');
  const id = JSON.parse(fs.readFileSync(idFile, 'utf8'));
  id.current.roster_url = 'https://TODO-roster.up.railway.app';
  fs.writeFileSync(idFile, JSON.stringify(id));
  const probed = [];
  const base = fakeFetch(id.current.site_base);
  const res = await runDoctor({ root, gh: noGh, fetchImpl: (url) => { probed.push(url); return base(url); } });
  const row = res.rows.find((r) => r.check.startsWith('roster https://TODO-'));
  assert.equal(row.status, 'FAIL');
  assert.match(row.note, /placeholder/);
  assert.ok(!probed.some((u) => u.includes('TODO-')));
});

const ROSTER_HEALTH = 'roster-production-12c1.up.railway.app/health';
const RELAY_HEALTH = 'curriculumrender-production.up.railway.app/health';

async function doctorWith(t, overrides) {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const site = JSON.parse(fs.readFileSync(path.join(root, 'config', 'identity.json'))).current.site_base;
  const res = await runDoctor({ root, gh: noGh, fetchImpl: fakeFetch(site, overrides) });
  const row = (check) => res.rows.find((r) => r.check === check || r.check.startsWith(`${check} `));
  return { res, row };
}

test('doctor: healthy services PASS both the status field and receipts', async (t) => {
  const { res, row } = await doctorWith(t, {});
  assert.equal(res.ok, true, JSON.stringify(res.rows));
  assert.equal(row('roster receipts').status, 'PASS');
  assert.equal(row('relay receipts').status, 'PASS');
  assert.match(row('relay').note, /status:healthy/);
});

test('doctor: a 200 HTML page on /health is FAIL (wrong endpoint)', async (t) => {
  const { res, row } = await doctorWith(t, { [RELAY_HEALTH]: () => new Response('<html>Railway</html>', { status: 200 }) });
  assert.equal(res.ok, false);
  assert.equal(row('relay').status, 'FAIL');
  assert.match(row('relay').note, /not a JSON object/);
  assert.equal(row('relay receipts'), undefined, 'receipts not judged on a bad body');
});

test('doctor: relay status other than healthy is FAIL and names the field', async (t) => {
  const { row } = await doctorWith(t, { [RELAY_HEALTH]: () => json(200, { status: 'unhealthy', receipts: { enabled: true, pubkey: 'PUB' } }) });
  assert.equal(row('relay').status, 'FAIL');
  assert.match(row('relay').note, /"status" is "unhealthy", expected "healthy"/);
});

test('doctor: roster body without ok is FAIL and names the field', async (t) => {
  const { row } = await doctorWith(t, { [ROSTER_HEALTH]: () => json(200, { service: 'roster' }) });
  assert.equal(row('roster').status, 'FAIL');
  assert.match(row('roster').note, /no "ok" field/);
});

test('doctor: missing receipts object or receipts.enabled is FAIL (old deployment)', async (t) => {
  const { row } = await doctorWith(t, {
    [ROSTER_HEALTH]: () => json(200, { ok: true }),
    [RELAY_HEALTH]: () => json(200, { status: 'healthy', receipts: { pubkey: 'PUB' } })
  });
  assert.equal(row('roster').status, 'PASS');
  assert.equal(row('roster receipts').status, 'FAIL');
  assert.match(row('roster receipts').note, /no "receipts" object/);
  assert.equal(row('relay receipts').status, 'FAIL');
  assert.match(row('relay receipts').note, /no "receipts\.enabled" field/);
});

test('doctor: non-boolean receipts.enabled is FAIL', async (t) => {
  const { row } = await doctorWith(t, { [RELAY_HEALTH]: () => json(200, { status: 'healthy', receipts: { enabled: 'yes', pubkey: 'PUB' } }) });
  assert.equal(row('relay receipts').status, 'FAIL');
  assert.match(row('relay receipts').note, /receipts\.enabled is "yes", expected true/);
});

test('doctor --env: REVIEW_GRANT_PUBKEY matching the live relay pubkey is PASS', async (t) => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const site = JSON.parse(fs.readFileSync(path.join(root, 'config', 'identity.json'))).current.site_base;
  const { publicKey } = ed25519();
  fs.mkdirSync(path.join(root, 'services', 'roster'), { recursive: true });
  fs.writeFileSync(path.join(root, 'services', 'roster', '.env'), `REVIEW_GRANT_PUBKEY=${publicKey}\n`);
  const res = await runDoctor({
    root, withEnv: true, gh: noGh,
    fetchImpl: fakeFetch(site, { [RELAY_HEALTH]: () => json(200, { status: 'healthy', receipts: { enabled: true, pubkey: publicKey } }) })
  });
  const row = res.rows.find((r) => r.check === 'roster REVIEW_GRANT_PUBKEY vs live relay issuer');
  assert.equal(row.status, 'PASS');
  assert.equal(row.note, 'match');
});
