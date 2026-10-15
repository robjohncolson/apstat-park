#!/usr/bin/env node
// Is the deployment described by config/identity.json alive?
//
//   node scripts/doctor.mjs [--identity config/identity.json] [--env] [--json] [--root dir]
//
// Read-only GETs, 10 s timeout each. PASS / WARN / FAIL per line; exit 1 on any FAIL.
// --env also validates services/*/.env (check-env) and uses local service keys to probe every table in
// supabase/expected-tables.json. Secret values are never printed.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseArgs, resolveRoot } from './lib/args.mjs';
import { SERVICES, loadIdentity, loadSchema, envPath, readEnvFile, isSet } from './lib/env.mjs';
import { OPERATOR_ENV } from './lib/wizard.mjs';
import { checkService } from './check-env.mjs';

const TIMEOUT_MS = 10_000;

async function get(fetchImpl, url, headers = {}) {
  try {
    const res = await fetchImpl(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, text, json };
  } catch (err) {
    return { status: 0, error: err.name === 'TimeoutError' ? 'timeout after 10 s' : err.message };
  }
}

const supaHeaders = (key) => ({ apikey: key, Authorization: `Bearer ${key}` });
const why = (r) => (r.status ? `HTTP ${r.status}` : r.error);

function defaultGh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', timeout: TIMEOUT_MS });
  if (r.error) return { missing: r.error.code === 'ENOENT', code: -1, stdout: '', stderr: r.error.message };
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * runDoctor({ root, identityPath, withEnv, fetchImpl, gh }) -> { ok, rows: [{ status, check, note }] }
 * fetchImpl and gh are injectable so tests never touch the network.
 */
export async function runDoctor({ root, identityPath = 'config/identity.json', withEnv = false, fetchImpl = fetch, gh = defaultGh }) {
  const rows = [];
  const add = (status, check, note = '') => rows.push({ status, check, note });
  const cur = loadIdentity(root, identityPath).current || {};
  const site = String(cur.site_base || '').replace(/\/+$/, '');
  const quiz = String(cur.quiz_base || '').replace(/\/+$/, '');

  const envs = {
    roster: readEnvFile(envPath(root, 'roster')) || {},
    relay: readEnvFile(envPath(root, 'relay')) || {},
    operator: readEnvFile(path.join(root, OPERATOR_ENV)) || {}
  };

  // ---- GitHub Pages ----
  const pages = [`${site}/index.html`, `${site}/ap_stats_roadmap_square_mode.html`, `${quiz}/index.html`, `${quiz}/data/curriculum.js`];
  const pageResults = await Promise.all(pages.map((u) => get(fetchImpl, u)));
  pages.forEach((u, i) => {
    const r = pageResults[i];
    add(r.status === 200 ? 'PASS' : 'FAIL', `pages ${u}`, r.status === 200 ? '200' : why(r));
  });

  // ---- Railway services ----
  const [roster, relay] = await Promise.all([get(fetchImpl, `${cur.roster_url}/health`), get(fetchImpl, `${cur.relay_url}/health`)]);
  if (roster.status === 200 && roster.json?.ok === true) {
    add('PASS', `roster ${cur.roster_url}/health`, `ok:true${roster.json.commit ? `, commit ${roster.json.commit}` : ', no commit reported (not on Railway?)'}`);
  } else {
    add('FAIL', `roster ${cur.roster_url}/health`, roster.status === 200 ? 'body is not {"ok":true,...}' : why(roster));
  }
  const relayPub = relay.json?.receipts?.pubkey || null;
  if (relay.status === 200) add('PASS', `relay ${cur.relay_url}/health`, `200${relay.json?.status ? `, ${relay.json.status}` : ''}${relay.json?.receipts?.enabled === false ? ', receipts DISABLED' : ''}`);
  else add('FAIL', `relay ${cur.relay_url}/health`, why(relay));

  // ---- Supabase REST (anon) ----
  for (const [label, url, key] of [['core', cur.supabase_url, cur.supabase_anon_key], ['content', cur.content_supabase_url, cur.content_supabase_anon_key]]) {
    const r = await get(fetchImpl, `${url}/rest/v1/`, supaHeaders(key));
    const check = `supabase ${label} ${url}/rest/v1/`;
    if (r.status === 200) add('PASS', check, '200 with anon key');
    // Supabase restricts the OpenAPI root to service_role; this specific 401 proves the anon key is valid.
    else if (r.status === 401 && /only the `?service_role`? api key/i.test(r.json?.hint || '')) add('PASS', check, 'reachable; anon key valid (root is service_role-only)');
    else if (r.status === 401) add('FAIL', check, `anon key rejected: ${r.json?.message || 'HTTP 401'}`);
    else add('FAIL', check, why(r));
  }

  // ---- lesson_urls point at this site ----
  const lu = await get(fetchImpl, `${cur.content_supabase_url}/rest/v1/lesson_urls?select=topic,worksheet_url&limit=3`, supaHeaders(cur.content_supabase_anon_key));
  if (lu.status !== 200 || !Array.isArray(lu.json)) {
    add('FAIL', 'content lesson_urls (anon)', why(lu));
  } else {
    const stale = lu.json.filter((row) => row.worksheet_url && !String(row.worksheet_url).startsWith(site));
    if (!lu.json.length) add('WARN', 'content lesson_urls (anon)', 'no rows');
    else if (stale.length) add('WARN', 'content lesson_urls (anon)', `${stale.length}/${lu.json.length} sampled worksheet_url not under ${site} (e.g. ${stale[0].worksheet_url}); update the rows`);
    else add('PASS', 'content lesson_urls (anon)', `sampled ${lu.json.length} rows, all under site_base`);
  }

  // ---- GitHub ----
  const repo = `${cur.github_user}/${cur.site_repo}`;
  const ver = gh(['--version']);
  if (ver.missing || ver.code !== 0) {
    add('WARN', 'github', 'gh CLI not available; skipped repo and Pages checks');
  } else {
    const view = gh(['repo', 'view', repo, '--json', 'name']);
    add(view.code === 0 ? 'PASS' : 'WARN', `github repo ${repo}`, view.code === 0 ? 'exists' : (view.stderr.trim().split('\n')[0] || 'not found or no access'));
    const pg = gh(['api', `repos/${repo}/pages`]);
    let note = 'Pages not enabled (Settings > Pages > Source = GitHub Actions)';
    if (pg.code === 0) {
      try { const j = JSON.parse(pg.stdout); note = `enabled, build_type ${j.build_type || '?'}, ${j.html_url || ''}`.trim(); } catch { note = 'enabled'; }
    }
    add(pg.code === 0 ? 'PASS' : 'WARN', `github pages ${repo}`, note);
  }

  if (!withEnv) return { ok: !rows.some((r) => r.status === 'FAIL'), rows };

  // ---- --env: local env files ----
  const schema = loadSchema(root);
  for (const svc of SERVICES) {
    const res = checkService(root, svc, { useProcessEnv: false, schema });
    if (!res.envFileFound) { add('FAIL', `env ${svc}`, `${path.relative(root, res.envFile).replace(/\\/g, '/')} not found (run node scripts/setup.mjs)`); continue; }
    for (const r of res.rows) {
      if (r.status === 'FAIL' || r.status === 'WARN') add(r.status, `env ${svc} ${r.key}`, r.note);
    }
    const n = (s) => res.rows.filter((r) => r.status === s).length;
    add(res.ok ? 'PASS' : 'FAIL', `env ${svc}`, `${n('PASS')} pass, ${n('WARN')} warn, ${n('FAIL')} fail`);
  }

  const grant = envs.roster.REVIEW_GRANT_PUBKEY;
  if (relayPub && isSet(grant)) {
    add(grant === relayPub ? 'PASS' : 'WARN', 'roster REVIEW_GRANT_PUBKEY vs live relay issuer',
      grant === relayPub ? 'match' : `local roster .env has ${grant}, live relay signs with ${relayPub}: AI review grants would be rejected`);
  }

  // ---- --env: expected tables with service keys ----
  const tablesFile = path.join(root, 'supabase', 'expected-tables.json');
  if (!fs.existsSync(tablesFile)) {
    add('WARN', 'supabase tables', 'supabase/expected-tables.json missing; skipped');
  } else {
    const expected = JSON.parse(fs.readFileSync(tablesFile, 'utf8'));
    const projects = {
      core: { url: cur.supabase_url, key: envs.roster.ROSTER_SUPABASE_SERVICE_KEY || envs.relay.SUPABASE_SERVICE_KEY, from: 'services/roster/.env ROSTER_SUPABASE_SERVICE_KEY' },
      content: { url: cur.content_supabase_url, key: envs.operator.CONTENT_SUPABASE_SERVICE_KEY, from: `${OPERATOR_ENV} CONTENT_SUPABASE_SERVICE_KEY` }
    };
    for (const [proj, cfg] of Object.entries(projects)) {
      const tables = Array.isArray(expected[proj]) ? expected[proj] : [];
      if (!tables.length) continue;
      if (!isSet(cfg.key)) { add('WARN', `supabase ${proj} tables`, `no service key (${cfg.from}); skipped ${tables.length} tables`); continue; }
      const results = await Promise.all(tables.map((t) => get(fetchImpl, `${cfg.url}/rest/v1/${encodeURIComponent(t)}?select=*&limit=0`, supaHeaders(cfg.key))));
      tables.forEach((t, i) => {
        const r = results[i];
        const missing = r.status === 404 || ['42P01', 'PGRST205'].includes(r.json?.code);
        if (r.status === 200) add('PASS', `supabase ${proj} table ${t}`, '200');
        else add('FAIL', `supabase ${proj} table ${t}`, missing ? 'table missing' : `${why(r)}${r.json?.message ? ': ' + r.json.message : ''}`);
      });
    }
  }

  return { ok: !rows.some((r) => r.status === 'FAIL'), rows };
}

async function main(argv) {
  const args = parseArgs(argv, ['env', 'json']);
  const root = resolveRoot(args);
  const res = await runDoctor({ root, identityPath: args.identity || 'config/identity.json', withEnv: !!args.env });
  if (args.json) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    for (const r of res.rows) console.log(`${r.status.padEnd(4)}  ${r.check}${r.note ? `  (${r.note})` : ''}`);
    const n = (s) => res.rows.filter((r) => r.status === s).length;
    console.log(`\n${res.ok ? 'HEALTHY' : 'PROBLEMS'}: ${n('PASS')} pass, ${n('WARN')} warn, ${n('FAIL')} fail`);
  }
  return res.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(`doctor: ${e.message}`); process.exitCode = 1; });
}
