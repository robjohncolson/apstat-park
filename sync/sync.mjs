#!/usr/bin/env node
// Rebuild every mirror in sync/manifest.json from the parent repos' HEAD.
//   node sync/sync.mjs           sync, transform, identity-rewrite, write sync/state.json
//   node sync/sync.mjs --check   read-only: exit 1 if a parent has commits not yet synced
//   --parents-root <dir>         look for the parent checkouts in <dir> (by the folder name in
//                                manifest.json) instead of next to this repo; for worktrees
// See sync/README.md. Node builtins only.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { matchesAny, rewriteBuffer, identityPairs, inRewriteScope, walk, isBinary, countOccurrences } from './rewrite.mjs';
import transforms from './transforms.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SYNC = path.join(ROOT, 'sync');
const WORK = path.join(SYNC, '.work');
const STATE = path.join(SYNC, 'state.json');
const manifest = JSON.parse(fs.readFileSync(path.join(SYNC, 'manifest.json'), 'utf8'));
// `native` globs are relative to the repo root and anchored there ("README.md" = the root README only).
const NATIVE = manifest.native.map((g) => (g.startsWith('/') ? g : `/${g}`));
const identity = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'identity.json'), 'utf8'));
const CHECK = process.argv.includes('--check');
const PARENTS_ROOT = readParentsRoot();
const prevState = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : null;

function readParentsRoot() {
  const i = process.argv.indexOf('--parents-root');
  if (i === -1) return null;
  const dir = process.argv[i + 1];
  if (!dir) throw new Error('--parents-root needs a directory');
  return path.resolve(dir);
}

// Manifest paths are relative to the repo root ("../follow-alongs"). With --parents-root the
// checkout is found by its folder name in that directory instead (for a worktree elsewhere).
function parentDir(p) {
  if (!PARENTS_ROOT) return path.resolve(ROOT, p.path);
  return path.join(PARENTS_ROOT, path.basename(p.path));
}

function git(cwd, args, opts = {}) {
  const r = spawnSync('git', ['-C', cwd, ...args], { maxBuffer: 2 ** 31 - 1, encoding: opts.binary ? 'buffer' : 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd} failed: ${r.stderr}`);
  return opts.binary || opts.raw ? r.stdout : r.stdout.trim();
}
const warnings = [];
const warn = (m) => { warnings.push(m); console.log(`  WARN ${m}`); };

// ---- parents ------------------------------------------------------------------------------
const parents = {};
for (const [id, p] of Object.entries(manifest.parents)) {
  const dir = parentDir(p);
  const head = git(dir, ['rev-parse', 'HEAD']);
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const dirtyFiles = git(dir, ['status', '--porcelain', '--untracked-files=no'], { raw: true }).split('\n').filter(Boolean).map((l) => l.slice(3));
  const last = prevState?.parents?.[id]?.head;
  let incoming = [];
  if (last && last !== head) {
    const log = spawnSync('git', ['-C', dir, 'log', '--oneline', `${last}..HEAD`], { encoding: 'utf8' });
    incoming = log.status === 0 ? log.stdout.trim().split('\n').filter(Boolean) : [`(cannot list ${last}..HEAD: ${log.stderr.trim()})`];
  }
  parents[id] = { dir, head, branch, dirty: dirtyFiles.length > 0, dirtyFiles, last, incoming };
}

console.log(CHECK ? 'sync --check' : 'sync');
let behind = false;
for (const [id, p] of Object.entries(parents)) {
  const label = manifest.parents[id].label;
  console.log(`\n[${id}] ${label}  HEAD ${p.head.slice(0, 8)} (${p.branch})  last synced ${p.last ? p.last.slice(0, 8) : 'never'}`);
  if (p.branch !== manifest.parents[id].branch) warn(`${id}: parent is on branch ${p.branch}, manifest expects ${manifest.parents[id].branch}`);
  if (p.dirty) warn(`${id}: parent working tree is dirty (sync reads HEAD, not these): ${p.dirtyFiles.join(', ')}`);
  if (!p.last) { behind = true; console.log('  never synced'); }
  else if (p.last !== p.head) {
    behind = true;
    console.log(`  ${p.incoming.length} new commit(s):`);
    for (const l of p.incoming) console.log(`    ${l}`);
  } else console.log('  up to date');
}
if (CHECK) process.exit(behind ? 1 : 0);

// ---- archive + extract -------------------------------------------------------------------
// Minimal tar reader for `git archive` output (ustar + pax 'x' path records).
function untar(buf) {
  const files = new Map();
  let off = 0, paxPath = null;
  const str = (o, n) => { const b = buf.subarray(o, o + n); const z = b.indexOf(0); return b.subarray(0, z === -1 ? n : z).toString('utf8'); };
  while (off + 512 <= buf.length) {
    if (buf[off] === 0) break;
    const name = str(off, 100), prefix = str(off + 345, 155);
    const size = parseInt(str(off + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(buf[off + 156] || 48);
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      const m = body.toString('utf8').match(/\d+ path=([^\n]*)\n/);
      paxPath = m ? m[1] : null;
      continue;
    }
    if (type === 'g') continue;
    const full = paxPath ?? (prefix ? `${prefix}/${name}` : name);
    paxPath = null;
    if (type === '0') files.set(full, body);
    else if (type === '5') continue;
    else throw new Error(`unsupported tar entry type ${type} for ${full}`);
  }
  return files;
}

const trees = {};
for (const [id, p] of Object.entries(parents)) {
  const files = untar(git(p.dir, ['archive', '--format=tar', 'HEAD'], { binary: true }));
  const out = path.join(WORK, id);
  fs.rmSync(out, { recursive: true, force: true });
  for (const [rel, body] of files) {
    fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true });
    fs.writeFileSync(path.join(out, rel), body);
  }
  trees[id] = files;
}

// ---- plan: dest path -> buffer ---------------------------------------------------------------
const plan = new Map();          // dest (repo-relative) -> Buffer
const origin = new Map();        // dest -> mirror id
const skippedNative = [];
const parseFrom = (spec) => { const i = spec.indexOf(':'); return [spec.slice(0, i), spec.slice(i + 1).replace(/^\/+/, '')]; };
function put(dest, buf, who) {
  if (matchesAny(dest, NATIVE)) { skippedNative.push(`${dest} (${who})`); return false; }
  if (origin.has(dest)) throw new Error(`mirror overlap: ${dest} written by both ${origin.get(dest)} and ${who}`);
  plan.set(dest, buf); origin.set(dest, who); return true;
}
const mirrorCounts = [];
for (const m of manifest.mirrors) {
  const [pid, from] = parseFrom(m.from);
  const to = m.to.replace(/\/?$/, '/');
  let n = 0;
  for (const [rel, buf] of trees[pid]) {
    if (from && !rel.startsWith(from)) continue;
    const sub = rel.slice(from.length);
    if (matchesAny(sub, m.exclude) && !matchesAny(sub, m.keep)) continue;
    if (put(to + sub, buf, m.id)) n++;
  }
  if (!n) warn(`mirror ${m.id}: copied 0 files from ${m.from}`);
  mirrorCounts.push([m.id, m.to, n]);
}
for (const f of manifest.files || []) {
  const [pid, from] = parseFrom(f.from);
  const buf = trees[pid].get(from);
  if (!buf) { warn(`file ${f.from} not in parent HEAD`); continue; }
  put(f.to, buf, `file:${f.from}`);
  mirrorCounts.push([`file`, f.to, 1]);
}
const targets = [...manifest.mirrors.map((m) => m.to.replace(/\/?$/, '/')), ...(manifest.files || []).map((f) => f.to)];

// ---- transforms ----------------------------------------------------------------------------
// Literal replacements on the in-memory copy of the parent's file. Strings are compared as
// latin1 so every byte (CRLF, non-UTF-8) round-trips untouched.
const latin1 = (s) => Buffer.from(s, 'utf8').toString('latin1');
const transformReport = [];
for (const t of transforms) {
  // An identity-derived pair can be a no-op (from === to); drop it rather than count it.
  const replace = t.replace.filter(([a, b]) => a !== b);
  for (const [a, b] of replace) if (b.includes(a)) throw new Error(`transform ${t.id}: "to" contains "from" (not idempotent)`);
  let total = 0;
  const perFile = {};
  const negated = t.files.filter((g) => g.startsWith('!')).map((g) => g.slice(1));
  for (const g of t.files.filter((x) => !x.startsWith('!'))) {
    if (!replace.length) break;
    const isLiteral = !/[*?]/.test(g);
    let globHits = 0, globFiles = 0;
    for (const [dest, buf] of plan) {
      if (!matchesAny(dest, [g]) || matchesAny(dest, negated)) continue;
      globFiles++;
      let s = buf.toString('latin1'), hits = 0;
      for (const [a, b] of replace) {
        const A = latin1(a), n = countOccurrences(s, A);
        if (n) { s = s.split(A).join(latin1(b)); hits += n; }
      }
      if (hits) { plan.set(dest, Buffer.from(s, 'latin1')); perFile[dest] = (perFile[dest] || 0) + hits; globHits += hits; }
      else if (isLiteral) warn(`transform ${t.id}: 0 hits in ${dest} (stale? the parent may have changed)`);
    }
    if (!globFiles) warn(`transform ${t.id}: ${g} matches no mirrored file`);
    else if (!isLiteral && !globHits) warn(`transform ${t.id}: 0 hits across ${g} (stale?)`);
    total += globHits;
  }
  transformReport.push([t.id, total, Object.keys(perFile).length]);
}

// ---- identity rewrite (parents -> current) -----------------------------------------------
const pairs = identityPairs(identity.parents, identity.current, identity.rewrite_order);
const idFiles = {}, idHits = {};
for (const [dest, buf] of plan) {
  if (!inRewriteScope(dest, identity) || isBinary(buf)) continue;
  const r = rewriteBuffer(buf, pairs);
  for (const [k, n] of Object.entries(r.hits)) { idFiles[k] = (idFiles[k] || 0) + 1; idHits[k] = (idHits[k] || 0) + n; }
  if (r.buf !== buf) plan.set(dest, r.buf);
}

// ---- apply: delete stale files under targets, write changed files ---------------------------
// Equivalent to "wipe the target, copy fresh" but leaves unchanged files alone. Never touched:
// native paths, node_modules, and gitignored local files (.env, tool state, media caches).
const existing = new Set();
for (const t of targets) {
  if (t.endsWith('/')) for (const rel of walk(ROOT, t.slice(0, -1))) existing.add(rel);
  else if (fs.existsSync(path.join(ROOT, t))) existing.add(t);
}
// The paths in `list` that a .gitignore pattern matches, tracked or not. check-ignore exits 0
// when some path is ignored and 1 when none is; anything else is an error, and it must stop the
// sync before anything is deleted.
const checkIgnored = (list) => {
  if (!list.length) return new Set();
  const r = spawnSync('git', ['-C', ROOT, 'check-ignore', '--no-index', '-z', '--stdin'], { input: list.join('\0'), encoding: 'utf8', maxBuffer: 2 ** 28 });
  if (r.status !== 0 && r.status !== 1) throw new Error(`git check-ignore failed: ${r.error?.message || r.stderr}`);
  return new Set(r.stdout.split('\0').filter(Boolean));
};
const tracked = new Set(git(ROOT, ['ls-files', '-z'], { raw: true }).split('\0').filter(Boolean));
const stale = [...existing].filter((rel) => !plan.has(rel) && !matchesAny(rel, NATIVE));
// Untracked + gitignored = a local file (.env, tool state, media cache): leave it alone.
// Tracked = a mirror file the parent no longer has (even a force-added, gitignored one): delete it.
const ignoredStale = checkIgnored(stale.filter((rel) => !tracked.has(rel)));
let deleted = 0, written = 0;
for (const rel of stale) {
  if (ignoredStale.has(rel)) continue;
  fs.rmSync(path.join(ROOT, rel)); deleted++;
}
const prune = (dir) => {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && e.name !== 'node_modules') prune(path.join(dir, e.name));
  if (dir !== ROOT && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
};
for (const t of targets) if (t.endsWith('/')) prune(path.join(ROOT, t));
for (const [rel, buf] of plan) {
  const abs = path.join(ROOT, rel);
  if (fs.existsSync(abs) && fs.readFileSync(abs).equals(buf)) continue;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf); written++;
}
// Parents force-add a few files their own .gitignore matches (site/.gitignore mirrors that
// .gitignore). Tracked here already = fine; otherwise they need `git add -f` once.
const ignoredMirrored = new Set([...checkIgnored([...plan.keys()])].filter((rel) => !tracked.has(rel)));

// ---- state ----------------------------------------------------------------------------------
// Only rewritten when something changed, so a no-op sync leaves `git status` clean.
const stateParents = Object.fromEntries(Object.entries(parents).map(([id, p]) => [id, {
  path: manifest.parents[id].path, head: p.head, branch: p.branch, dirty: p.dirty,
}]));
const sameParents = prevState && JSON.stringify(prevState.parents) === JSON.stringify(stateParents);
const noop = sameParents && !written && !deleted;
if (!noop) {
  fs.writeFileSync(STATE, JSON.stringify({ synced_at: new Date().toISOString(), parents: stateParents }, null, 2) + '\n');
}

// ---- summary --------------------------------------------------------------------------------
console.log('\nMirrors (files copied):');
for (const [id, to, n] of mirrorCounts) console.log(`  ${String(n).padStart(6)}  ${id.padEnd(24)} -> ${to}`);
console.log(`  total ${plan.size} files; ${written} written, ${deleted} deleted, ${plan.size - written} unchanged`);
if (skippedNative.length) console.log(`  not copied (native in this repo): ${skippedNative.join(', ')}`);
if (ignoredStale.size) console.log(`  kept ${ignoredStale.size} gitignored local file(s) under mirror targets`);
if (ignoredMirrored.size) warn(`${ignoredMirrored.size} mirrored file(s) are gitignored here and untracked; the parent tracks them, so add with \`git add -f\`: ${[...ignoredMirrored].slice(0, 20).join(', ')}${ignoredMirrored.size > 20 ? ' ...' : ''}`);
console.log('\nTransforms (hits / files):');
for (const [id, n, f] of transformReport) console.log(`  ${String(n).padStart(5)} / ${String(f).padStart(3)}  ${id}`);
console.log('\nIdentity rewrite parents -> current (files / hits):');
for (const [k] of pairs) console.log(`  ${String(idFiles[k] || 0).padStart(5)} / ${String(idHits[k] || 0).padStart(5)}  ${k}`);
console.log(`\n${noop ? 'No changes; state.json untouched.' : 'state.json updated.'}${warnings.length ? ` ${warnings.length} warning(s) above.` : ''}`);
