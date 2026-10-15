// Tiny argv parser shared by the operator scripts. No dependencies.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// parseArgs(['roster', '--env-file', 'x', '--json']) -> { _: ['roster'], 'env-file': 'x', json: true }
// `flags` lists options that never take a value.
export function parseArgs(argv, flags = []) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 0) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const name = a.slice(2);
    const next = argv[i + 1];
    if (flags.includes(name) || next === undefined || next.startsWith('--')) out[name] = true;
    else { out[name] = next; i++; }
  }
  return out;
}

export function resolveRoot(args) {
  return args.root ? path.resolve(String(args.root)) : REPO_ROOT;
}
