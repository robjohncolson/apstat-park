#!/usr/bin/env node
// Retarget this repo at a new identity (another teacher, another GitHub user, new services).
//
//   node scripts/rebrand.mjs --to new-identity.json [--dry-run]
//
// new-identity.json is either a full identity file (its `current` block is used) or a flat
// { key: value } map with any subset of the keys in config/identity.json `current`.
// Every literal `current[key]` in the rewrite scope becomes the new value (same engine and
// order as sync/sync.mjs), then config/identity.json `current` is updated.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { identityPairs, inRewriteScope, isBinary, rewriteBuffer, walk } from '../sync/rewrite.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IDENTITY = path.join(ROOT, 'config', 'identity.json');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const toIndex = args.indexOf('--to');
if (toIndex === -1 || !args[toIndex + 1]) {
  console.error('usage: node scripts/rebrand.mjs --to <new-identity.json> [--dry-run]');
  process.exit(2);
}

const identity = JSON.parse(fs.readFileSync(IDENTITY, 'utf8'));
const input = JSON.parse(fs.readFileSync(path.resolve(args[toIndex + 1]), 'utf8'));
const requested = input.current ?? input;

// Keys in rewrite_order are rewritten in files. Any other key (github_user, site_repo, the wizard's
// teacher_name, ...) is informational: recorded in `current`, never searched for in files.
const next = { ...identity.current };
for (const [key, value] of Object.entries(requested)) {
  if (key.startsWith('$')) continue;
  if (typeof value !== 'string') {
    console.error(`identity key ${key}: value must be a string`);
    process.exit(2);
  }
  next[key] = value;
}

const pairs = identityPairs(identity.current, next, identity.rewrite_order);
const fileCounts = {};
const hitCounts = {};
let filesChanged = 0;

for (const rel of walk(ROOT)) {
  if (!inRewriteScope(rel, identity)) continue;
  const abs = path.join(ROOT, rel);
  const buf = fs.readFileSync(abs);
  if (isBinary(buf)) continue;
  const result = rewriteBuffer(buf, pairs);
  if (result.buf === buf) continue;
  filesChanged++;
  for (const [key, n] of Object.entries(result.hits)) {
    fileCounts[key] = (fileCounts[key] || 0) + 1;
    hitCounts[key] = (hitCounts[key] || 0) + n;
  }
  if (!dryRun) fs.writeFileSync(abs, result.buf);
}

console.log(`${dryRun ? 'DRY RUN: would rewrite' : 'Rewrote'} ${filesChanged} file(s) (files / hits per key):`);
for (const [key, from, to] of pairs) {
  console.log(`  ${String(fileCounts[key] || 0).padStart(5)} / ${String(hitCounts[key] || 0).padStart(5)}  ${key}: ${from} -> ${to}`);
}
const otherChanged = Object.keys(next).filter((k) => next[k] !== identity.current[k] && !identity.rewrite_order.includes(k));
if (otherChanged.length) console.log(`  (recorded only, not rewritten in files: ${otherChanged.join(', ')})`);

if (!dryRun) {
  identity.current = next;
  fs.writeFileSync(IDENTITY, JSON.stringify(identity, null, 2) + '\n');
  console.log('config/identity.json `current` updated.');
}

console.log(`
Rebrand cannot do these; do them by hand:
  - Railway: set each service's variables (SUPABASE_URL, keys, TEACHER_KEY, CORS origins) and
    Root Directory (services/roster, services/relay); redeploy both services.
  - GitHub: create the repo, enable Pages (source: GitHub Actions), add the APSTATS_TEACHER_KEY
    Actions secret used by .github/workflows/frq-regrade.yml.
  - Supabase: rows in the lesson_urls table hold absolute worksheet URLs; update them to the new
    Pages base. Run the migrations in supabase/ on a fresh project if the project changed.
  - Schoology (or any LMS): links posted to students still point at the old URLs.
  - While this repo is still derived from the parents, run \`node sync/sync.mjs\` afterwards: it
    re-applies parents -> current from config/identity.json, including the identity-derived
    transforms in sync/transforms.mjs (test regexes, path prefixes) that a literal rewrite misses.`);
