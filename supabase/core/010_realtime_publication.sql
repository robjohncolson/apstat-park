-- 010_realtime_publication.sql  (core project)
--
-- Supabase Realtime only streams `postgres_changes` for tables in the `supabase_realtime` publication.
-- These tables are subscribed to by the code (grep `postgres_changes` across site/ and services/):
--   public.answers   services/relay/server.js (channel 'answers_changes': cache bust + WebSocket fan-out)
--                    site/quiz/index.html     (channel 'answers_changes': turbo-mode sync)
-- Without this the subscriptions connect but never fire. Listed in supabase/expected-tables.json `realtime`.
-- Idempotent: creates the publication if missing, adds each table only when it is not already a member.

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'answers'
  ) then
    return;
  end if;
  alter publication supabase_realtime add table public.answers;
end $$;
