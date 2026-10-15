#!/usr/bin/env node
// Emit idempotent SQL that seeds the CONTENT project's `lesson_urls` (and, with --schedule, `topic_schedule`)
// from the baked roadmap registry, site/roadmap-data.json. The registry already carries the current
// identity's URLs (config/identity.json is applied to it on every sync), so the rows point at THIS site.
//
//   node scripts/build-lesson-urls-seed.mjs            > lesson_urls.sql
//   node scripts/build-lesson-urls-seed.mjs --schedule > lesson_urls_and_schedule.sql
//
// Paste the output into the content project's SQL editor, or: psql "$CONTENT_DB_URL" -f lesson_urls.sql
// Re-running overwrites the same rows (upsert on the primary key). Rows the registry does not know
// about are left alone.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const withSchedule = process.argv.includes('--schedule');
const registry = JSON.parse(readFileSync(resolve(root, 'site/roadmap-data.json'), 'utf8'));

const lit = v => (v === null || v === undefined || v === '') ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;

// "Topic 8.1" -> "8.1"; progress checks -> "<unit>.PC" (the Desk's key for a unit's PC).
function topicKey(entry, kind) {
  if (kind === 'pc') {
    const unit = entry.unit ?? entry.unitId ?? (typeof entry.topic === 'string' && /(\d+)/.exec(entry.topic)?.[1]);
    return unit ? `${unit}.PC` : null;
  }
  if (typeof entry.topic !== 'string') return null;
  const m = /(\d+)\.(\d+)/.exec(entry.topic);
  return m ? `${m[1]}.${m[2]}` : null;
}

const lessons = Array.isArray(registry.lessons) ? registry.lessons : Object.values(registry.lessons || {});
const pcs = Array.isArray(registry.progressChecks) ? registry.progressChecks : Object.values(registry.progressChecks || {});

const urlRows = [];
const schedRows = [];
const skipped = [];
for (const [list, kind] of [[lessons, 'lesson'], [pcs, 'pc']]) {
  for (const entry of list) {
    const topic = topicKey(entry, kind);
    if (!topic) { skipped.push(entry.topic ?? entry.title ?? '(untitled)'); continue; }
    const u = entry.urls || {};
    urlRows.push(`  (${lit(topic)}, ${lit(u.worksheet)}, ${lit(u.drills)}, ${lit(u.quiz)}, ${lit(u.blooket)})`);
    if (withSchedule && entry.periods) {
      for (const [period, p] of Object.entries(entry.periods)) {
        if (!p || !p.date) continue;
        const folderId = typeof p.schoologyFolder === 'string' ? (/[?&]f=(\d+)/.exec(p.schoologyFolder)?.[1] ?? null) : null;
        schedRows.push(`  (${lit(period)}, ${lit(topic)}, ${lit(p.date)}, ${lit(entry.ced2026?.newLabel ?? entry.topic)}, ${lit(p.posted ? 'posted' : 'planned')}, ${lit(folderId)})`);
      }
    }
  }
}

const out = [];
out.push(`-- lesson_urls seed generated ${new Date().toISOString()} from site/roadmap-data.json (registryVersion ${registry.registryVersion ?? '?'})`);
out.push(`-- ${urlRows.length} rows; ${skipped.length} registry entries without a topic key were skipped.`);
out.push(`insert into public.lesson_urls (topic, worksheet_url, drills_url, quiz_url, blooket_url) values`);
out.push(urlRows.join(',\n'));
out.push(`on conflict (topic) do update set
  worksheet_url = excluded.worksheet_url,
  drills_url    = excluded.drills_url,
  quiz_url      = excluded.quiz_url,
  blooket_url   = excluded.blooket_url,
  updated_at    = now();`);
if (withSchedule && schedRows.length) {
  out.push('');
  out.push(`-- topic_schedule: ${schedRows.length} rows (only entries with a date). Status is 'posted' or 'planned'.`);
  out.push(`insert into public.topic_schedule (period, topic, date, title, status, schoology_folder_id) values`);
  out.push(schedRows.join(',\n'));
  out.push(`on conflict (period, topic) do update set
  date = excluded.date, title = excluded.title, status = excluded.status,
  schoology_folder_id = excluded.schoology_folder_id, updated_at = now();`);
}
process.stdout.write(out.join('\n') + '\n');
if (skipped.length) process.stderr.write(`skipped (no topic key): ${skipped.join(', ')}\n`);
