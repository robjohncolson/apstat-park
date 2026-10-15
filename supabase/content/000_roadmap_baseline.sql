-- 000_roadmap_baseline.sql  (content project)
--
-- The two tables the Desk (site/ap_stats_roadmap_square_mode.html) reads at runtime with the anon key:
--   lesson_urls    one row per topic: where the worksheet, drills, quiz and Blooket for that topic live.
--                  Overrides the baked site/roadmap-data.json. Seed it with scripts/build-lesson-urls-seed.mjs.
--   topic_schedule one row per topic per period: the date it is taught, its title, its status, and the
--                  Schoology folder it is posted in. The teacher maintains it by hand.
--
-- RECONSTRUCTED 2026-10-14 from the Desk's REST selects:
--   /rest/v1/lesson_urls?select=topic,worksheet_url,drills_url,quiz_url,blooket_url
--   /rest/v1/topic_schedule?period=eq.<P>&select=topic,date,title,status,schoology_folder_id&order=date.asc
-- and from site/supabase-summer-2026.sql, which names both tables as pre-existing. Idempotent.
-- UNVERIFIED against the live project: see supabase/README.md "Provenance".

create table if not exists public.lesson_urls (
  topic         text primary key,          -- '1.1', '2.PC', ...
  worksheet_url text,
  drills_url    text,
  quiz_url      text,
  blooket_url   text,
  updated_at    timestamptz not null default now()
);

create table if not exists public.topic_schedule (
  period              text not null,       -- 'B', 'E'
  topic               text not null,
  date                date,
  title               text,
  status              text,                -- 'planned' | 'taught' | 'skipped' ... (free text in the client)
  schoology_folder_id text,
  updated_at          timestamptz not null default now(),
  primary key (period, topic)
);
create index if not exists topic_schedule_period_date_idx on public.topic_schedule (period, date);

alter table public.lesson_urls    enable row level security;
alter table public.topic_schedule enable row level security;

-- The Desk reads both with the anon key; only the teacher writes (SQL editor / service role).
drop policy if exists "lesson_urls anon select" on public.lesson_urls;
create policy "lesson_urls anon select" on public.lesson_urls for select to anon using (true);
drop policy if exists "topic_schedule anon select" on public.topic_schedule;
create policy "topic_schedule anon select" on public.topic_schedule for select to anon using (true);
grant select on public.lesson_urls, public.topic_schedule to anon;
