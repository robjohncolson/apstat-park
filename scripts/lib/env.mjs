// Schema-driven .env helpers: parse, serialize, validate, render .env.example.
// Contract: config/env-schema.json. Secret values are never shown unmasked.
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

// ---------- validation ----------

/**
 * validateEnv({ schema, identity, svc, env, fileEnv, otherFileEnvs, testContext })
 *   env            merged values to validate (.env file under process.env)
 *   fileEnv        values from this service's .env file only (shared checks + unknown-key report)
 *   otherFileEnvs  { relay: {...} | null } other services' .env files, for shared_with checks
 * returns { ok, rows: [{ key, group, status: PASS|WARN|FAIL|UNSET|INFO, note, shown }] }
 */
export function validateEnv({ schema, identity, svc, env, fileEnv = null, otherFileEnvs = {}, testContext = null }) {
  const cur = identity?.current || {};
  const inTest = testContext ?? (env.NODE_ENV === 'test' || isSet(env.VITEST));
  const rows = [];
  const keys = serviceKeys(schema, svc);

  const oneOf = {};
  for (const { key, spec } of keys) if (spec.one_of) (oneOf[spec.one_of] ||= []).push(key);
  const oneOfOk = Object.fromEntries(Object.entries(oneOf).map(([g, ks]) => [g, ks.some((k) => isSet(env[k]))]));

  for (const { key, group, spec } of keys) {
    const v = env[key];
    const row = { key, group, status: 'PASS', note: '', shown: display(v, spec) };
    const notes = [];

    if (group === 'test_only') {
      // NODE_ENV=production is normal; only the test fixtures' path keys are a smell.
      if (!isSet(v) || key === 'NODE_ENV') continue;
      row.status = inTest ? 'INFO' : 'WARN';
      row.note = inTest ? 'test-only key (test context)' : 'test-only key set outside test: unset it in production';
      rows.push(row);
      continue;
    }

    if (!isSet(v)) {
      if (spec.one_of) {
        const ok = oneOfOk[spec.one_of];
        row.status = ok ? 'UNSET' : (group === 'required' ? 'FAIL' : 'WARN');
        notes.push(ok ? `one_of ${spec.one_of}: satisfied by another key` : `one_of ${spec.one_of}: set at least one of ${oneOf[spec.one_of].join(' / ')}`);
      } else if (group === 'required') {
        row.status = 'FAIL';
        notes.push(spec.default !== undefined ? `missing (set it to "${spec.default}")` : 'missing');
      } else if (group === 'recommended') {
        row.status = 'WARN';
        notes.push(spec.default !== undefined ? `unset (schema suggests "${spec.default}")` : 'unset');
      } else {
        row.status = 'UNSET';
      }
      const want = identityValue(spec, cur);
      if (want) notes.push(`identity says ${display(want, spec)}`);
      row.note = notes.join('; ');
      rows.push(row);
      continue;
    }

    if (group === 'required' && spec.default !== undefined && String(v) !== String(spec.default)) {
      row.status = 'WARN';
      notes.push(`expected "${spec.default}"`);
    }
    if (spec.one_of) notes.push(`one_of ${spec.one_of}`);

    const want = identityValue(spec, cur);
    if (want !== undefined && String(v).replace(/\/+$/, '') !== want.replace(/\/+$/, '')) {
      if (row.status === 'PASS') row.status = 'WARN';
      notes.push(`differs from identity.current.${spec.from_identity}${spec.suffix ? ' + ' + spec.suffix : ''} (${display(want, spec)})`);
    }

    for (const other of spec.shared_with || []) {
      const otherEnv = otherFileEnvs[other];
      const own = fileEnv && isSet(fileEnv[key]) ? fileEnv[key] : v;
      if (!otherEnv) { notes.push(`shared with ${other} (its .env not found locally, not compared)`); continue; }
      if (!isSet(otherEnv[key])) { row.status = 'FAIL'; notes.push(`shared with ${other}, but ${other}'s .env has no ${key}`); }
      else if (String(otherEnv[key]) !== String(own)) { row.status = 'FAIL'; notes.push(`must equal ${other}'s ${key}, but differs`); }
      else notes.push(`matches ${other}`);
    }

    row.note = notes.join('; ');
    rows.push(row);
  }

  if (fileEnv) {
    const known = new Set(keys.map((k) => k.key));
    for (const key of Object.keys(fileEnv)) {
      if (!known.has(key)) rows.push({ key, group: 'unknown', status: 'INFO', note: 'not in env-schema.json', shown: mask(fileEnv[key]) });
    }
  }

  return { ok: !rows.some((r) => r.status === 'FAIL'), rows };
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
