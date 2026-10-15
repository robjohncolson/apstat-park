#!/usr/bin/env node
// Teacher-switch wizard. Writes local files only; uploads nothing.
//
//   node scripts/setup.mjs                         interactive
//   node scripts/setup.mjs --answers answers.json  non-interactive (file path or inline JSON)
//   node scripts/setup.mjs --dry-run               print everything, write nothing
//   --root <dir>                                   operate on another checkout (tests)
//
// --answers keys: github_user, repo, site_base, roster_url, relay_url, supabase_url, supabase_anon_key,
// supabase_service_key, content_supabase_url, content_supabase_anon_key, content_supabase_service_key,
// groq_api_key, deepseek_api_key, teacher_name, sections, rotate (array of "KEY" or "svc:KEY").
// Missing answers take the previous value: existing .env files, then a previous run's
// config/identity.next.json, then identity.json. site_base keeps its previous value while github_user
// and repo are unchanged and is re-derived when either changes. Existing secrets are kept unless
// listed in `rotate`. roster_url / relay_url never default to the ORIGINAL teacher's deployment
// for a new github_user: give a URL or "later" (writes https://TODO-roster.up.railway.app /
// https://TODO-relay.up.railway.app, which check-env and doctor FAIL on until setup is re-run).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs, resolveRoot } from './lib/args.mjs';
import { SERVICES, loadSchema, loadIdentity, envPath, readEnvFile, renderEnvFile, serializeValue, mask, isSet } from './lib/env.mjs';
import {
  OPERATOR_ENV, questions, makeContext, checkAnswer, resolveAnswers, generatedKeys, planSetup,
  railwayCommands, ghCommands, checklist, trimUrl, relPath, expandLater
} from './lib/wizard.mjs';

const INTRO = [
  'apstat-park setup: point this repo at YOUR GitHub, Railway and Supabase.',
  'It writes four local files: services/roster/.env, services/relay/.env, .env (operator keys), config/identity.next.json.',
  'Secrets are generated on this machine; existing secrets are kept unless you choose to rotate them.',
  'Nothing is uploaded anywhere. At the end it prints the railway / gh commands for YOU to run.',
  'Press Enter to keep the value in [brackets]. Ctrl+C aborts without writing anything.'
];

const SECRETS_NOTICE = '!! The Railway and GitHub commands below contain your secrets in plain text. Do not paste this output into chat, issues or screenshots.';

function readAnswers(arg, root) {
  if (arg === true) throw new Error('--answers needs a JSON file path or an inline JSON object');
  const s = String(arg).trim();
  if (s.startsWith('{')) return JSON.parse(s);
  return JSON.parse(fs.readFileSync(path.resolve(root, s), 'utf8'));
}

async function askAll(rl, ctx) {
  const given = {};
  for (const q of questions()) {
    for (;;) {
      const def = q.def(ctx, given);
      const shown = q.secret ? (def ? mask(def) : '') : def;
      const raw = (await rl.question(`${q.q}${shown ? ` [${shown}]` : q.optional ? ' [skip]' : ''}: `)).trim();
      const typed = raw === '' ? def : raw === '-' && q.optional ? '' : raw;
      const value = expandLater(q, typed);
      const v = q.url ? trimUrl(value) : String(value).trim();
      const err = checkAnswer(q, v, given);
      if (!err) { given[q.id] = v; break; }
      console.log(`  ! ${err}`);
    }
  }
  return given;
}

async function askRotations(rl, schema, existing) {
  const rotate = new Set();
  const seen = new Set();
  for (const { svc, key, sharedWith } of generatedKeys(schema)) {
    const own = existing[svc]?.[key];
    if (!isSet(own) || seen.has(key + svc)) continue;
    sharedWith.forEach((o) => seen.add(key + o));
    const where = sharedWith.length ? `${svc}+${sharedWith.join('+')}` : svc;
    const yes = (await rl.question(`${where} ${key} already set (${mask(own)}). Rotate it? [y/N]: `)).trim().toLowerCase();
    if (yes === 'y' || yes === 'yes') rotate.add(`${svc}:${key}`);
  }
  return rotate;
}

function writeFile(file, text, dryRun, written) {
  if (dryRun) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  written.push(file);
}

async function main(argv) {
  const args = parseArgs(argv, ['dry-run']);
  const root = resolveRoot(args);
  const dryRun = !!args['dry-run'];
  const schema = loadSchema(root);
  const identity = loadIdentity(root);
  const operatorFile = path.join(root, OPERATOR_ENV);
  const nextFile = path.join(root, 'config', 'identity.next.json');
  const existing = {
    roster: readEnvFile(envPath(root, 'roster')) || {},
    relay: readEnvFile(envPath(root, 'relay')) || {},
    operator: readEnvFile(operatorFile) || {},
    // A previous run's answers, so a re-run keeps them without falling back to identity.json.
    next: fs.existsSync(nextFile) ? (JSON.parse(fs.readFileSync(nextFile, 'utf8')).current || {}) : {}
  };
  const ctx = makeContext(schema, identity, existing);

  console.log(INTRO.join('\n'));
  if (dryRun) console.log('(--dry-run: nothing will be written)');
  console.log('');

  let answers;
  let rotate;
  if (args.answers !== undefined) {
    const given = readAnswers(args.answers, root);
    answers = resolveAnswers(ctx, given);
    rotate = new Set(given.rotate || []);
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      answers = resolveAnswers(ctx, await askAll(rl, ctx));
      rotate = await askRotations(rl, schema, existing);
    } finally {
      rl.close();
    }
  }

  const plan = planSetup({ schema, identity, answers, existing, rotate });
  const written = [];

  for (const svc of SERVICES) writeFile(envPath(root, svc), renderEnvFile(schema, svc, plan.envs[svc]), dryRun, written);
  const opText = [
    '# Operator-only keys (gitignored). No service reads this file; scripts/doctor.mjs does.',
    ...Object.entries(plan.operator).filter(([, v]) => isSet(v)).map(([k, v]) => `${k}=${serializeValue(v)}`)
  ].join('\n') + '\n';
  writeFile(operatorFile, opText, dryRun, written);
  writeFile(nextFile, JSON.stringify(plan.identityNext, null, 2) + '\n', dryRun, written);

  const hr = (t) => console.log(`\n==== ${t} ${'='.repeat(Math.max(0, 70 - t.length))}`);

  hr('Secrets');
  for (const g of plan.generated) {
    const svcs = [g.svc, ...g.sharedWith].join('+');
    console.log(`${g.reused ? 'kept     ' : 'generated'}  ${svcs.padEnd(12)} ${g.key.padEnd(28)} ${mask(plan.envs[g.svc][g.key])}`);
  }
  if (plan.relayPubkey) console.log(`roster REVIEW_GRANT_PUBKEY = relay issuer public key ${plan.relayPubkey}`);
  for (const w of plan.warnings) console.log(`WARN: ${w}`);

  hr(dryRun ? 'Would write' : 'Wrote');
  for (const f of [envPath(root, 'roster'), envPath(root, 'relay'), operatorFile, nextFile]) console.log(relPath(root, f));
  if (dryRun) {
    console.log('\nconfig/identity.next.json (current):');
    console.log(JSON.stringify(plan.identityNext.current, null, 2));
  }

  hr('Next: rebrand the repo (not run by this wizard)');
  console.log('node scripts/rebrand.mjs --to config/identity.next.json');

  const rw = railwayCommands(schema, plan.envs);
  console.log(`\n${SECRETS_NOTICE}`);
  for (const svc of SERVICES) {
    hr(`Railway variables: ${svc} (Root Directory ${schema[svc].railway_root_directory})`);
    console.log(rw[svc].join('\n'));
  }

  hr('GitHub secret');
  console.log(ghCommands(schema, plan.envs, answers).join('\n'));

  hr('Manual steps this wizard cannot do');
  checklist(schema, answers).forEach((s, i) => console.log(`[ ] ${i + 1}. ${s}`));
  console.log('');
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(`setup: ${e.message}`); process.exitCode = 1; });
}
