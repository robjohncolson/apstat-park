-- 000_quiz_baseline.sql  (core project)
--
-- The consensus quiz app's original tables, as created by hand in the Supabase dashboard in 2025.
-- RECONSTRUCTED 2026-10-14 from docs/quiz/supabase_schema.sql (a context-only dump), the quiz client's
-- column usage (site/quiz/index.html, site/quiz/js/*), and the relay's queries. Idempotent.
-- UNVERIFIED against the live project: see supabase/README.md "Provenance".
--
-- RLS posture (original design): every quiz table is readable and writable by the anon key. Every
-- student's answers are visible to every other student; that is the point of the consensus quiz.
-- Do not put anything private in these tables.

create extension if not exists pgcrypto;

create or replace function public.handle_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- Users: quiz usernames (Fruit_Animal) to display names.
create table if not exists public.users (
  username   text primary key,
  real_name  text not null,
  password   text,
  user_type  text default 'student',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_users_real_name on public.users (real_name);
create index if not exists idx_users_user_type on public.users (user_type);
drop trigger if exists users_updated_at on public.users;
create trigger users_updated_at before update on public.users
  for each row execute function public.handle_updated_at();

-- Answers: one row per (username, question). `reasoning` is added by relay migration 0003.
create table if not exists public.answers (
  id           serial,
  username     text   not null,
  question_id  text   not null,
  answer_value text   not null,
  "timestamp"  bigint not null,
  created_at   timestamptz default now(),
  updated_at   timestamptz not null default now(),
  primary key (username, question_id)
);
create index if not exists idx_answers_question on public.answers (question_id);
create index if not exists idx_answers_updated on public.answers (updated_at);
drop trigger if exists answers_updated_at on public.answers;
create trigger answers_updated_at before update on public.answers
  for each row execute function public.handle_updated_at();

create table if not exists public.badges (
  id          serial primary key,
  username    text   not null,
  badge_type  text   not null,
  earned_date bigint not null,
  created_at  timestamptz default now()
);

create table if not exists public.user_activity (
  username       text primary key,
  activity_state text not null,
  question_id    text,
  "timestamp"    bigint not null,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

create table if not exists public.votes (
  id              bigserial primary key,
  created_at      timestamp default now(),
  question_id     text not null,
  voter_username  text not null,
  target_username text not null,
  score           smallint,
  "timestamp"     timestamp not null,
  constraint votes_question_voter_target_key unique (question_id, voter_username, target_username)
);

-- Identity claims: resolve orphaned usernames by prompting candidates.
create table if not exists public.identity_claims (
  id                 serial primary key,
  orphan_username    text not null,
  candidate_username text not null,
  response           text,
  created_by         text not null,
  created_at         timestamptz default now(),
  responded_at       timestamptz,
  constraint identity_claims_orphan_candidate_key unique (orphan_username, candidate_username)
);
create index if not exists idx_identity_claims_orphan    on public.identity_claims (orphan_username);
create index if not exists idx_identity_claims_candidate on public.identity_claims (candidate_username);
create index if not exists idx_identity_claims_pending   on public.identity_claims (candidate_username) where response is null;

create table if not exists public.teacher_notifications (
  id                serial primary key,
  teacher_username  text not null,
  notification_type text not null,
  message           text not null,
  related_orphan    text,
  read              boolean default false,
  created_at        timestamptz default now()
);
create index if not exists idx_teacher_notifications_teacher on public.teacher_notifications (teacher_username);
create index if not exists idx_teacher_notifications_unread  on public.teacher_notifications (teacher_username) where read = false;

-- Allow-all RLS for the anon role on the quiz tables (original design).
do $$
declare t text;
begin
  foreach t in array array['users','answers','badges','user_activity','votes','identity_claims','teacher_notifications'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "%s allow all" on public.%I', t, t);
    execute format('create policy "%s allow all" on public.%I for all using (true) with check (true)', t, t);
    execute format('grant select, insert, update, delete on public.%I to anon', t);
  end loop;
end $$;
grant usage, select on all sequences in schema public to anon;
