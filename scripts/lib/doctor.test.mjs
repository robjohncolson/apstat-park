// doctor.mjs with an injected fetch and gh: no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './args.mjs';
import { runDoctor } from '../doctor.mjs';

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
    if (url.endsWith('/health') && url.includes('roster')) return json(200, { ok: true, service: 'roster', commit: 'abc123' });
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
  fs.writeFileSync(path.join(root, 'services', 'roster', '.env'), 'ROSTER_SUPABASE_SERVICE_KEY=svc\nREVIEW_GRANT_PUBKEY=OTHER\n');
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
  assert.equal(find('REVIEW_GRANT_PUBKEY').status, 'WARN');
  assert.ok(!JSON.stringify(res).includes('svc\\n'));
});
