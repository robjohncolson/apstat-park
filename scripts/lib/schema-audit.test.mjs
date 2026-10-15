// Keeps config/env-schema.json and supabase/ true to what the mirrored service code actually does.
// Reads services/, site/ and supabase/ only; no network. A failure here after a sync means the parents
// started (or stopped) reading something: update the schema / SQL / expected-tables.json to match.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './args.mjs';
import { loadSchema, serviceKeys } from './env.mjs';
import { envReadsFromSource, stripComments } from './env-reads.mjs';

const SKIP_DIRS = new Set(['node_modules', 'tests', 'migrations', 'data', 'scripts', 'activities', 'tools']);

function sourceFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...sourceFiles(full)); continue; }
    if (!/\.(m?js|cjs)$/.test(entry.name)) continue;
    if (/test/i.test(entry.name) || entry.name === 'vitest.config.js') continue;
    out.push(full);
  }
  return out;
}

// Every env var name a service's runtime code reads (see scripts/lib/env-reads.mjs for the rules).
// Throws with file:line on a dynamic env read the extractor does not recognise.
function envReads(svc) {
  const reads = new Set();
  for (const file of sourceFiles(path.join(REPO_ROOT, 'services', svc))) {
    const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
    for (const key of envReadsFromSource(fs.readFileSync(file, 'utf8'), rel)) reads.add(key);
  }
  return reads;
}

const schema = loadSchema(REPO_ROOT);
const haveServices = fs.existsSync(path.join(REPO_ROOT, 'services', 'roster', 'server.js'));

for (const svc of ['roster', 'relay']) {
  test(`env-schema.json ${svc}: every key the code reads is in the schema, and every schema key is read`, { skip: !haveServices }, () => {
    const reads = envReads(svc);
    const keys = new Set(serviceKeys(schema, svc).map((k) => k.key));
    const missing = [...reads].filter((k) => !keys.has(k)).sort();
    const unread = [...keys].filter((k) => !reads.has(k)).sort();
    assert.deepEqual(missing, [], `read by services/${svc} but not in config/env-schema.json`);
    assert.deepEqual(unread, [], `in config/env-schema.json but never read by services/${svc}`);
  });
}

function filesUnder(dir, re) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full, re));
    else if (re.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
  }
  return out;
}

const expected = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'supabase', 'expected-tables.json'), 'utf8'));
const supabaseSql = filesUnder(path.join(REPO_ROOT, 'supabase'), /\.sql$/).map((f) => fs.readFileSync(f, 'utf8')).join('\n');

test('realtime: every postgres_changes table is listed and added to supabase_realtime by SQL', { skip: !haveServices }, () => {
  const subscribed = new Set();
  for (const file of filesUnder(path.join(REPO_ROOT, 'site'), /\.(html|m?js)$/).concat(filesUnder(path.join(REPO_ROOT, 'services'), /\.(m?js)$/))) {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes('postgres_changes')) continue;
    for (const m of text.matchAll(/postgres_changes['"]\s*,\s*\{[^}]*table:\s*['"]([a-z_]+)['"]/g)) subscribed.add(m[1]);
  }
  const listed = new Set(Object.values(expected.realtime || {}).flat());
  for (const table of subscribed) {
    assert.ok(listed.has(table), `${table} is subscribed via postgres_changes but not in expected-tables.json realtime`);
    assert.match(supabaseSql, new RegExp(`alter publication supabase_realtime add table public\\.${table}\\b`), `no SQL adds ${table} to supabase_realtime`);
  }
});

test('buckets: every bucket in expected-tables.json is created by a supabase/ SQL file', () => {
  for (const name of Object.values(expected.buckets || {}).flat()) {
    assert.match(supabaseSql, new RegExp(`insert into storage\\.buckets[^;]*'${name}'`), `no SQL creates bucket ${name}`);
  }
});

// ---- the extractor itself, on small fixtures ----

const sorted = (set) => [...set].sort();

test('env-reads: keys inside comments are ignored, line numbers are kept', () => {
  const src = [
    '// process.env.FAKE_LINE',
    "/* process.env.FAKE_BLOCK and process.env['FAKE_QUOTED'] */",
    'const url = "http://example.com"; // process.env.FAKE_TRAILING',
    'const real = process.env.REAL_KEY;'
  ].join('\n');
  assert.deepEqual(sorted(envReadsFromSource(src)), ['REAL_KEY']);
  assert.equal(stripComments(src).split('\n').length, 4);
});

test('env-reads: a // inside a string or regex is not a comment', () => {
  const src = "const a = 'http://x' + process.env.AFTER_STRING; const b = /\\/\\//g; const c = process.env.AFTER_REGEX;";
  assert.deepEqual(sorted(envReadsFromSource(src)), ['AFTER_REGEX', 'AFTER_STRING']);
});

test('env-reads: unrelated UPPER_CASE constants are not env keys', () => {
  const src = "const SOME = 'SOME_CONST'; const port = process.env.PORT;";
  assert.deepEqual(sorted(envReadsFromSource(src)), ['PORT']);
});

test('env-reads: bracket reads with either quote style, and injected env objects', () => {
  const src = `process.env["DOUBLE_Q"]; process.env['SINGLE_Q']; function f(env) { return env.INJECTED + env["INJ_BRACKET"]; }`;
  assert.deepEqual(sorted(envReadsFromSource(src)), ['DOUBLE_Q', 'INJECTED', 'INJ_BRACKET', 'SINGLE_Q']);
});

test('env-reads: known helpers yield the key at their env-name argument only', () => {
  const src = [
    'function configuredNumber(config, key, envKey, fallback) { return process.env[envKey] ?? fallback; }',
    'configuredNumber(x, y, "FRQ_X", 1);',
    "configuredNumber(cfg, 'notAnEnvName', 'FRQ_Y', Math.max(1, 2));",
    'function capFromEnv(env, routeKey, sharedKey, fallback) { return env[routeKey] ?? env[sharedKey] ?? fallback; }',
    `capFromEnv(env, 'ROUTE_CAP', "SHARED_CAP", 10);`
  ].join('\n');
  assert.deepEqual(sorted(envReadsFromSource(src)), ['FRQ_X', 'FRQ_Y', 'ROUTE_CAP', 'SHARED_CAP']);
});

test('env-reads: an unknown dynamic read throws with file:line', () => {
  const src = 'const a = 1;\nconst b = process.env[someName];';
  assert.throws(() => envReadsFromSource(src, 'fake.js'), /fake\.js:2: unrecognised dynamic env read process\.env\[someName\]/);
});

test('env-reads: a known helper access outside a file that defines the helper still throws', () => {
  assert.throws(() => envReadsFromSource('process.env[envKey];', 'fake.js'), /fake\.js:1: unrecognised/);
});

test('env-reads: a helper call with a non-literal env name throws', () => {
  const src = 'function configuredNumber(c, k, envKey) { return process.env[envKey]; }\nconfiguredNumber(c, k, prefix + "_X");';
  assert.throws(() => envReadsFromSource(src, 'fake.js'), /fake\.js:2: configuredNumber\(\.\.\.\) argument 3 is not a quoted env name/);
});
