#!/usr/bin/env node
// Install the dependencies of every part, so `npm test` can run on a fresh clone.
//
//   npm run install:all        (same as: node scripts/install-all.mjs)
//
// site/, site/quiz/ and services/roster/ have lockfiles: `npm ci` installs exactly what they pin.
// services/relay/ has no lockfile (its parent repo never committed one), so it gets
// `npm install --no-package-lock`, which installs without writing a lockfile into a mirrored path.
// Stops at the first failure.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from './lib/args.mjs';

export const STEPS = [
  { dir: 'site', args: ['ci'] },
  { dir: 'site/quiz', args: ['ci'] },
  { dir: 'services/roster', args: ['ci'] },
  { dir: 'services/relay', args: ['install', '--no-package-lock'] }
];

function run(step, index) {
  const label = `[${index + 1}/${STEPS.length}] ${step.dir}: npm ${step.args.join(' ')}`;
  console.log(`\n==== ${label}`);
  // shell: true so Windows resolves npm.cmd.
  const r = spawnSync('npm', step.args, { cwd: path.join(REPO_ROOT, step.dir), stdio: 'inherit', shell: true });
  if (r.status === 0) return true;
  console.error(`\nFAILED: ${label} (exit ${r.status ?? r.error?.message})`);
  return false;
}

function main() {
  for (let i = 0; i < STEPS.length; i++) {
    if (!run(STEPS[i], i)) return 1;
  }
  console.log('\nAll dependencies installed. Next: npm test');
  return 0;
}

process.exitCode = main();
