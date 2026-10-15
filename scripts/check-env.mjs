#!/usr/bin/env node
// Validate a service's environment against config/env-schema.json.
//
//   node scripts/check-env.mjs <roster|relay> [--env-file path] [--json] [--no-process-env] [--root dir]
//   node scripts/check-env.mjs --render-examples [--root dir]
//
// The service's .env (default services/<svc>/.env) is merged UNDER process.env (process.env wins),
// matching how the service sees it on Railway. --no-process-env validates the file alone.
// Exit 1 on any FAIL. Secret values are masked (first 4 chars + length).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, resolveRoot } from './lib/args.mjs';
import {
  SERVICES, loadSchema, loadIdentity, envPath, readEnvFile, validateEnv, formatTable, writeExamples
} from './lib/env.mjs';

export function checkService(root, svc, { envFile, useProcessEnv = true, schema, identity } = {}) {
  schema ||= loadSchema(root);
  identity ||= loadIdentity(root);
  const file = envFile ? path.resolve(envFile) : envPath(root, svc);
  const fileEnv = readEnvFile(file);
  const env = { ...(fileEnv || {}), ...(useProcessEnv ? process.env : {}) };
  const otherFileEnvs = {};
  for (const other of SERVICES) if (other !== svc) otherFileEnvs[other] = readEnvFile(envPath(root, other));
  const result = validateEnv({ schema, identity, svc, env, fileEnv, otherFileEnvs });
  return { service: svc, envFile: file, envFileFound: !!fileEnv, ...result };
}

function main(argv) {
  const args = parseArgs(argv, ['json', 'render-examples', 'no-process-env']);
  const root = resolveRoot(args);

  if (args['render-examples']) {
    const files = writeExamples(root, loadSchema(root), loadIdentity(root));
    for (const f of files) console.log(`wrote ${path.relative(root, f).replace(/\\/g, '/')}`);
    return 0;
  }

  const svc = args._[0];
  if (!SERVICES.includes(svc)) {
    console.error('usage: node scripts/check-env.mjs <roster|relay> [--env-file path] [--json] [--no-process-env] [--root dir]');
    console.error('       node scripts/check-env.mjs --render-examples');
    return 2;
  }

  const res = checkService(root, svc, { envFile: args['env-file'], useProcessEnv: !args['no-process-env'] });
  if (args.json) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(`${svc}: ${res.envFileFound ? path.relative(root, res.envFile).replace(/\\/g, '/') : `${res.envFile} (not found; checking process.env only)`}`);
    console.log(formatTable(res.rows));
    const n = (s) => res.rows.filter((r) => r.status === s).length;
    console.log(`\n${res.ok ? 'OK' : 'FAILED'}: ${n('PASS')} pass, ${n('WARN')} warn, ${n('FAIL')} fail, ${n('UNSET')} unset (optional)`);
  }
  return res.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
