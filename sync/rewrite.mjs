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
// The explicit keys come first; then the shorter forms derived from them (see derivedForms),
// so a longer literal is always replaced before a shorter literal it contains.
export function identityPairs(fromMap, toMap, order) {
  const pairs = [];
  for (const key of order) {
    const a = fromMap[key], b = toMap[key];
    if (a === undefined || b === undefined) throw new Error(`identity key ${key} missing`);
    addPair(pairs, key, a, b);
  }
  for (const key of order) {
    const fromForms = derivedForms(key, fromMap[key]);
    const toForms = derivedForms(key, toMap[key]);
    for (const [label, a] of Object.entries(fromForms)) addPair(pairs, label, a, toForms[label]);
  }
  return pairs;
}

function addPair(pairs, key, from, to) {
  if (from === to) return;
  if (from === undefined || to === undefined) throw new Error(`identity ${key}: old and new values must have the same form`);
  if (to.includes(from)) throw new Error(`identity ${key}: new value contains old value; rewrite would not be idempotent`);
  pairs.push([key, from, to]);
}

// Forms of an identity value that files also contain on their own, longest first:
//   roster_url, relay_url  the WebSocket URL (https -> wss, http -> ws), e.g. the relay socket
//   site_base              as a JS regex literal (tests pin URLs with /https:\/\/...\.io\/.../),
//                          the origin (CORS allow-lists), the host as a regex literal, the bare
//                          host (hostname checks)
// quiz_base needs nothing: its origin is site_base's. Returns { "key (form)": value }.
function derivedForms(key, value) {
  if (key === 'roster_url' || key === 'relay_url') {
    const ws = webSocketUrl(value);
    if (!ws) return {};
    return { [`${key} (wss)`]: ws };
  }
  if (key === 'site_base') {
    const url = new URL(value);
    return {
      [`${key} (regex)`]: regexEscaped(value),
      [`${key} (origin)`]: url.origin,
      [`${key} (host regex)`]: regexEscaped(url.host),
      [`${key} (host)`]: url.host,
    };
  }
  return {};
}

function webSocketUrl(url) {
  if (url.startsWith('https://')) return 'wss://' + url.slice('https://'.length);
  if (url.startsWith('http://')) return 'ws://' + url.slice('http://'.length);
  return null;
}

// "https://a.b/c" -> "https:\/\/a\.b\/c", as the URL is written inside a JS regex literal.
function regexEscaped(text) {
  return text.replace(/[/.]/g, (c) => '\\' + c);
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
