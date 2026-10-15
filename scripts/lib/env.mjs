// Schema-driven .env helpers: parse, serialize, validate, render .env.example.
// Contract: config/env-schema.json. Secret values are never shown unmasked.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SERVICES = ['roster', 'relay'];
export const GROUPS = ['required', 'recommended', 'optional', 'feature_flags', 'platform', 'test_only'];
export const GROUP_TITLES = {
  required: 'Required: the service does not work correctly without these',
  recommended: "Recommended: code defaults point at the ORIGINAL teacher's deployment or are unsafe",
  optional: 'Optional: tuning and extras',
  feature_flags: 'Feature flags',
  platform: 'Platform: injected by Railway, do not set by hand',
  test_only: 'Test only: never set these in production'
};

export function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function loadSchema(root) {
  return loadJson(path.join(root, 'config', 'env-schema.json'));
}

export function loadIdentity(root, rel = 'config/identity.json') {
  return loadJson(path.resolve(root, rel));
}

export function envPath(root, svc) {
  return path.join(root, 'services', svc, '.env');
}

// ---------- dotenv parse / serialize ----------

export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2];
    if (v.startsWith('"')) {
      const end = v.lastIndexOf('"');
      v = v.slice(1, end > 0 ? end : undefined)
        .replace(/\\(["\\n])/g, (_, c) => (c === 'n' ? '\n' : c));
    } else if (v.startsWith("'")) {
      const end = v.lastIndexOf("'");
      v = v.slice(1, end > 0 ? end : undefined);
    } else {
      v = v.replace(/\s+#.*$/, '').trim();
    }
    out[m[1]] = v;
  }
  return out;
}

export function serializeValue(v) {
  const s = String(v ?? '');
  if (s === '' || /^[A-Za-z0-9_.,:\/+=@%-]+$/.test(s)) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

export function readEnvFile(file) {
  if (!file || !fs.existsSync(file)) return null;
  return parseEnv(fs.readFileSync(file, 'utf8'));
}

// ---------- schema walking ----------

// [{ key, group, spec }] in schema order.
export function serviceKeys(schema, svc) {
  const s = schema[svc];
  if (!s || !SERVICES.includes(svc)) throw new Error(`unknown service "${svc}" (expected one of ${SERVICES.join(', ')})`);
  const rows = [];
  for (const group of GROUPS) {
    for (const [key, spec] of Object.entries(s[group] || {})) rows.push({ key, group, spec: spec || {} });
  }
  return rows;
}

export function identityValue(spec, identityCurrent) {
  if (!spec || !spec.from_identity) return undefined;
  const base = identityCurrent?.[spec.from_identity];
  if (base === undefined || base === null || base === '') return undefined;
  return String(base) + (spec.suffix || '');
}

export function mask(value) {
  const s = String(value ?? '');
  if (!s) return '';
  return `${s.slice(0, 4)}...(${s.length})`;
}

export function display(value, spec) {
  if (value === undefined || value === null || value === '') return '';
  if (spec?.secret) return mask(value);
  const s = String(value);
  return s.length > 48 ? `${s.slice(0, 45)}...` : s;
}

export const isSet = (v) => v !== undefined && v !== null && String(v) !== '';

// ---------- value checks ----------

// setup.mjs writes this into URLs the teacher deferred with `later`. Any value containing it FAILs.
export const PLACEHOLDER_MARK = 'TODO-';
export const isPlaceholder = (v) => String(v ?? '').includes(PLACEHOLDER_MARK);

function ed25519PrivateError(value) {
  let key;
  try {
    // Exactly how services/*/receipts.js loads RECEIPT_ISSUER_PRIVATE_KEY.
    key = crypto.createPrivateKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'pkcs8' });
  } catch {
    return 'not a base64 PKCS8 DER private key (receipts.js would silently disable receipts)';
  }
  if (key.asymmetricKeyType !== 'ed25519') return `a ${key.asymmetricKeyType} key, not Ed25519`;
  return '';
}

function ed25519PublicError(value) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return 'not base64url of 32 bytes (43 chars, no padding)';
  if (Buffer.from(value, 'base64url').length !== 32) return 'does not decode to 32 bytes';
  try {
    crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: value }, format: 'jwk' });
  } catch {
    return 'not a valid Ed25519 public key';
  }
  return '';
}

// '' when a SET value has the shape the code needs, else the reason (a FAIL).
export function formatError(spec, value) {
  const v = String(value);
  if (isPlaceholder(v)) return `placeholder (contains ${PLACEHOLDER_MARK}); re-run node scripts/setup.mjs with the real value`;
  if ((spec.forbidden || []).includes(v.trim())) return 'is the published default; the code ignores it or anyone can use it';
  if (spec.min_length && Buffer.byteLength(v, 'utf8') < spec.min_length) return `shorter than ${spec.min_length} bytes (the code ignores it)`;
  if (spec.format === 'url' && !/^https?:\/\/\S+$/.test(v)) return 'not an http(s) URL';
  if (spec.format === 'ed25519-pkcs8-b64') return ed25519PrivateError(v);
  if (spec.format === 'ed25519-pub-b64url') return ed25519PublicError(v);
  return '';
}

// '' or a WARN reason: shorter than the schema recommends, though the code accepts it.
export function lengthWarning(spec, value) {
  if (!spec.recommended_min_length) return '';
  if (Buffer.byteLength(String(value), 'utf8') >= spec.recommended_min_length) return '';
  return `shorter than the recommended ${spec.recommended_min_length} bytes`;
}

// ---------- effective values ----------

// The value the service actually uses for `key`: a key marked `overrides: key` wins when set
// (roster's FRQ_GRADER_SECRET over ROSTER_GRADER_SECRET). Returns { value, via }.
export function effectiveValue(schema, svc, env, key) {
  for (const { key: alias, spec } of serviceKeys(schema, svc)) {
    if (spec.overrides === key && isSet(env[alias])) return { value: env[alias], via: alias };
  }
  return { value: env[key], via: key };
}

// Where a merged value came from: the .env file, or the live environment that overrides it.
function sourceOf(key, env, fileEnv, fileLabel) {
  if (!fileEnv) return 'environment';
  if (isSet(fileEnv[key]) && String(fileEnv[key]) === String(env[key])) return fileLabel;
  return 'live environment';
}

// ---------- validation ----------

/**
 * validateEnv({ schema, identity, svc, env, fileEnv, otherFileEnvs, testContext })
 *   env            merged values to validate (.env file under process.env)
 *   fileEnv        values from this service's .env file only (source labels + unknown-key report)
 *   otherFileEnvs  { relay: {...} | null } other services' .env files, for shared_with checks
 * returns { ok, rows: [{ key, group, status: PASS|WARN|FAIL|UNSET|INFO, note, shown }] }
 */
export function validateEnv({ schema, identity, svc, env, fileEnv = null, otherFileEnvs = {}, testContext = null }) {
  const ctx = {
    schema, svc, env, fileEnv, otherFileEnvs,
    cur: identity?.current || {},
    inTest: testContext ?? (env.NODE_ENV === 'test' || isSet(env.VITEST)),
    fileLabel: `${svc}'s .env`,
    oneOf: {}
  };
  const keys = serviceKeys(schema, svc);
  for (const { key, spec } of keys) if (spec.one_of) (ctx.oneOf[spec.one_of] ||= []).push(key);

  const rows = [];
  for (const { key, group, spec } of keys) {
    const row = checkKey(ctx, key, group, spec);
    if (row) rows.push(row);
  }

  if (fileEnv) {
    const known = new Set(keys.map((k) => k.key));
    for (const key of Object.keys(fileEnv)) {
      if (!known.has(key)) rows.push({ key, group: 'unknown', status: 'INFO', note: 'not in env-schema.json', shown: mask(fileEnv[key]) });
    }
  }

  return { ok: !rows.some((r) => r.status === 'FAIL'), rows };
}

function checkKey(ctx, key, group, spec) {
  const v = ctx.env[key];
  if (group === 'test_only') return checkTestOnly(ctx, key, group, v);

  const row = { key, group, status: 'PASS', note: '', shown: display(v, spec) };
  const eff = effectiveValue(ctx.schema, ctx.svc, ctx.env, key);
  if (!isSet(eff.value)) return checkUnset(ctx, row, spec);

  const notes = [];
  const fail = (note) => { row.status = 'FAIL'; notes.push(note); };
  const warn = (note) => { if (row.status === 'PASS') row.status = 'WARN'; notes.push(note); };

  if (eff.via !== key) notes.push(`overridden by ${eff.via}`);
  if (isSet(v)) checkValue(ctx, key, group, spec, v, { fail, warn, notes });
  for (const other of spec.shared_with || []) checkShared(ctx, key, eff, other, { fail, notes });

  row.note = notes.join('; ');
  return row;
}

function checkTestOnly(ctx, key, group, v) {
  // NODE_ENV=production is normal; only the test fixtures' path keys are a smell.
  if (!isSet(v) || key === 'NODE_ENV') return null;
  return {
    key, group, shown: display(v, {}),
    status: ctx.inTest ? 'INFO' : 'WARN',
    note: ctx.inTest ? 'test-only key (test context)' : 'test-only key set outside test: unset it in production'
  };
}

function checkUnset(ctx, row, spec) {
  const notes = [];
  if (spec.one_of) {
    const members = ctx.oneOf[spec.one_of];
    const satisfied = members.some((k) => isSet(ctx.env[k]));
    row.status = satisfied ? 'UNSET' : (row.group === 'required' ? 'FAIL' : 'WARN');
    notes.push(satisfied ? `one_of ${spec.one_of}: satisfied by another key` : `one_of ${spec.one_of}: set at least one of ${members.join(' / ')}`);
  } else if (row.group === 'required') {
    row.status = 'FAIL';
    notes.push(spec.default !== undefined ? `missing (set it to "${spec.default}")` : 'missing');
  } else if (row.group === 'recommended') {
    row.status = 'WARN';
    notes.push(spec.default !== undefined ? `unset (schema suggests "${spec.default}")` : 'unset');
  } else {
    row.status = 'UNSET';
  }
  const want = identityValue(spec, ctx.cur);
  if (want) notes.push(`identity says ${display(want, spec)}`);
  row.note = notes.join('; ');
  return row;
}

function checkValue(ctx, key, group, spec, v, { fail, warn, notes }) {
  const bad = formatError(spec, v);
  if (bad) fail(bad);

  const short = lengthWarning(spec, v);
  if (short) warn(short);

  if (group === 'required' && spec.default !== undefined && String(v) !== String(spec.default)) warn(`expected "${spec.default}"`);
  if (spec.one_of) notes.push(`one_of ${spec.one_of}`);

  if (spec.overrides) {
    notes.push(`overrides ${spec.overrides}: the code uses this value`);
    const base = ctx.env[spec.overrides];
    if (isSet(base) && String(base) !== String(v)) warn(`differs from ${spec.overrides}; ${key} wins`);
  }

  const want = identityValue(spec, ctx.cur);
  if (want === undefined || isPlaceholder(v)) return;
  if (String(v).replace(/\/+$/, '') === want.replace(/\/+$/, '')) return;
  warn(`differs from identity.current.${spec.from_identity}${spec.suffix ? ' + ' + spec.suffix : ''} (${display(want, spec)})`);
}

// Shared secrets: compare THIS service's effective value with the peer's effective value.
function checkShared(ctx, key, eff, other, { fail, notes }) {
  const otherEnv = ctx.otherFileEnvs[other];
  if (!otherEnv) {
    notes.push(`shared with ${other} (its .env not found locally, not compared)`);
    return;
  }
  const peer = effectiveValue(ctx.schema, other, otherEnv, key);
  if (!isSet(peer.value)) {
    fail(`shared with ${other}, but ${other}'s .env has no ${key}`);
    return;
  }
  const ownFrom = `${eff.via} from ${sourceOf(eff.via, ctx.env, ctx.fileEnv, ctx.fileLabel)}`;
  const peerFrom = `${peer.via} from ${other}'s .env`;
  if (String(peer.value) !== String(eff.value)) {
    fail(`must equal ${other}'s ${peer.via}, but differs (this side: ${ownFrom}; ${other}: ${peerFrom})`);
    return;
  }
  notes.push(`matches ${other} (${ownFrom} = ${peerFrom})`);
}


export function formatTable(rows, cols = ['status', 'key', 'shown', 'note']) {
  const label = { shown: 'value' };
  const widths = cols.map((c) => Math.min(64, Math.max((label[c] || c).length, ...rows.map((r) => String(r[c] ?? '').length))));
  const line = (r) => cols.map((c, i) => String(r[c] ?? '').padEnd(widths[i])).join('  ').trimEnd();
  const head = Object.fromEntries(cols.map((c) => [c, label[c] || c]));
  return [line(head), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

// ---------- .env.example rendering ----------

function wrapComment(text, width = 100) {
  const lines = [];
  let cur = '#';
  for (const w of String(text).split(/\s+/).filter(Boolean)) {
    if (cur.length + 1 + w.length > width && cur !== '#') { lines.push(cur); cur = '#'; }
    cur += ' ' + w;
  }
  if (cur !== '#') lines.push(cur);
  return lines;
}

export function renderExample(schema, identity, svc) {
  const s = schema[svc];
  const cur = identity?.current || {};
  const out = [
    `# ${s.service_dir}/.env.example`,
    '# GENERATED by `node scripts/check-env.mjs --render-examples` from config/env-schema.json. Do not edit by hand.',
    `# Copy to ${s.service_dir}/.env (gitignored), or run \`node scripts/setup.mjs\` to generate one with fresh secrets.`,
    `# Validate with: node scripts/check-env.mjs ${svc}`,
    `# Railway: Root Directory = ${s.railway_root_directory}; health check path = ${s.health}.`,
    ''
  ];

  for (const group of GROUPS) {
    const entries = Object.entries(s[group] || {});
    out.push(`# ==================== ${GROUP_TITLES[group]} ====================`);
    if (!entries.length) { out.push('# (none)', ''); continue; }
    if (group === 'test_only') {
      out.push(...wrapComment(`Read only by the test suite; leave unset on Railway: ${entries.map(([k]) => k).join(', ')}.`), '');
      continue;
    }
    for (const [key, specRaw] of entries) {
      const spec = specRaw || {};
      if (spec.doc) out.push(...wrapComment(spec.doc));
      const tags = [];
      if (spec.secret) tags.push('secret');
      if (spec.generate) tags.push(`generated by setup.mjs (${spec.generate === 'ed25519' ? 'ed25519, base64 PKCS8 DER' : spec.generate})`);
      if (spec.one_of) {
        const members = Object.entries(s[group]).filter(([, x]) => x?.one_of === spec.one_of).map(([k]) => k);
        tags.push(`at least one of ${members.join(' / ')}`);
      }
      for (const other of spec.shared_with || []) tags.push(`must equal ${other} ${key}`);
      if (spec.from_identity) tags.push(`from identity.current.${spec.from_identity}${spec.suffix ? ` + "${spec.suffix}"` : ''}`);
      if (spec.overrides) tags.push(`overrides ${spec.overrides} when set`);
      if (spec.format) tags.push(`format ${spec.format}`);
      if (spec.min_length) tags.push(`at least ${spec.min_length} bytes`);
      if (spec.recommended_min_length) tags.push(`${spec.recommended_min_length}+ bytes recommended`);
      if (tags.length) out.push(`# ${tags.join('; ')}`);
      let value = '';
      if (spec.from_identity) value = identityValue(spec, cur) ?? '';
      else if (spec.default !== undefined) value = spec.default;
      out.push(`${group === 'platform' ? '# ' : ''}${key}=${spec.secret ? '' : serializeValue(value)}`, '');
    }
  }
  return out.join('\n').replace(/\n+$/, '') + '\n';
}

export function examplePath(root, schema, svc) {
  return path.join(root, schema[svc].service_dir, '.env.example');
}

export function writeExamples(root, schema, identity) {
  return SERVICES.map((svc) => {
    const file = examplePath(root, schema, svc);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, renderExample(schema, identity, svc));
    return file;
  });
}

// ---------- real .env files (setup.mjs) ----------

export function renderEnvFile(schema, svc, values) {
  const out = [
    `# ${schema[svc].service_dir}/.env: LOCAL ONLY (gitignored). Contains secrets. Written by scripts/setup.mjs.`,
    '# Re-running setup keeps existing secrets unless you choose to rotate them.',
    ''
  ];
  const done = new Set();
  for (const group of GROUPS) {
    const keys = Object.keys(schema[svc][group] || {}).filter((k) => isSet(values[k]));
    if (!keys.length) continue;
    out.push(`# --- ${group} ---`);
    for (const k of keys) { out.push(`${k}=${serializeValue(values[k])}`); done.add(k); }
    out.push('');
  }
  const extra = Object.keys(values).filter((k) => !done.has(k) && isSet(values[k]));
  if (extra.length) {
    out.push('# --- not in env-schema.json (kept from the previous file) ---');
    for (const k of extra) out.push(`${k}=${serializeValue(values[k])}`);
  }
  return out.join('\n').replace(/\n+$/, '') + '\n';
}
