// Shared by sync/sync.mjs and scripts/rebrand.mjs: glob matching, binary detection,
// literal identity rewriting. Node builtins only.
import fs from 'node:fs';
import path from 'node:path';

// gitignore-style glob -> RegExp over a forward-slash relative path.
// A pattern without an inner "/" matches at any depth (like .gitignore); a pattern with one
// is anchored at the root. Either form also matches everything below a matched directory.
const reCache = new Map();
export function globToRegExp(glob) {
  if (reCache.has(glob)) return reCache.get(glob);
  let g = glob.replace(/\\/g, '/');
  if (g.endsWith('/')) g = g.slice(0, -1);
  const anchored = g.includes('/');
  if (g.startsWith('/')) g = g.slice(1);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; }
        else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const rx = new RegExp((anchored ? '^' : '^(?:.*/)?') + re + '(?:/.*)?$');
  reCache.set(glob, rx);
  return rx;
}
export const matchesAny = (rel, globs = []) => globs.some((g) => globToRegExp(g).test(rel));

// Binary = a NUL byte in the first 8 KB.
export function isBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function countOccurrences(s, needle) {
  if (!needle) return 0;
  let n = 0;
  for (let i = s.indexOf(needle); i !== -1; i = s.indexOf(needle, i + needle.length)) n++;
  return n;
}

// pairs: [[key, from, to], ...] applied in order. Literal, not regex.
// Returns { buf, hits: {key: n} } ; buf is the input buffer when nothing changed.
// Works on latin1 strings so every byte (CRLF, invalid UTF-8) round-trips exactly;
// identity literals are ASCII so the match is the same as on UTF-8 text.
export function rewriteBuffer(buf, pairs) {
  let s = buf.toString('latin1');
  const hits = {};
  let changed = false;
  for (const [key, from, to] of pairs) {
    const n = countOccurrences(s, from);
    if (!n) continue;
    hits[key] = n;
    s = s.split(from).join(to);
    changed = true;
  }
  return { buf: changed ? Buffer.from(s, 'latin1') : buf, hits };
}

// Build [key, from, to] pairs from two identity maps, in rewrite_order, skipping equal values.
export function identityPairs(fromMap, toMap, order) {
  const pairs = [];
  for (const key of order) {
    const a = fromMap[key], b = toMap[key];
    if (a === undefined || b === undefined) throw new Error(`identity key ${key} missing`);
    if (a !== b) {
      if (b.includes(a)) throw new Error(`identity ${key}: new value contains old value; rewrite would not be idempotent`);
      pairs.push([key, a, b]);
    }
  }
  return pairs;
}

export const inRewriteScope = (rel, identity) =>
  matchesAny(rel, identity.rewrite_scope) && !matchesAny(rel, identity.rewrite_skip);

// Recursive file walk (forward-slash paths relative to root). Never descends into node_modules or .git.
export function walk(root, dir = '', out = []) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return out;
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    const rel = dir ? `${dir}/${ent.name}` : ent.name;
    if (ent.isDirectory()) walk(root, rel, out);
    else out.push(rel);
  }
  return out;
}
