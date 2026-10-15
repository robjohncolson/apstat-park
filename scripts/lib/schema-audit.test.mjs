// Keeps config/env-schema.json and supabase/ true to what the mirrored service code actually does.
// Reads services/, site/ and supabase/ only; no network. A failure here after a sync means the parents
// started (or stopped) reading something: update the schema / SQL / expected-tables.json to match.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './args.mjs';
import { loadSchema, serviceKeys } from './env.mjs';

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

// Every env var name a service's runtime code reads: process.env.X, env.X (injected env objects), and
// quoted UPPER_CASE names in files that read process.env[name] / env[name] dynamically.
function envReads(svc) {
  const reads = new Set();
  for (const file of sourceFiles(path.join(REPO_ROOT, 'services', svc))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) reads.add(m[1]);
    for (const m of text.matchAll(/\benv\.([A-Z][A-Z0-9_]{3,})/g)) reads.add(m[1]);
    if (!/process\.env\[|\benv\[[a-zA-Z]/.test(text)) continue;
    for (const m of text.matchAll(/'([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)'/g)) reads.add(m[1]);
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
