-- 901_worksheet_diagnostics_bucket.sql  (core project)
--
-- The PRIVATE storage bucket for worksheet load diagnostics. roster-server reads and writes small JSON
-- summaries here with the service key (services/roster/worksheet-diagnostics.js, DIAGNOSTICS_BUCKET).
-- Operational data only: no grades, no answers. Without the bucket the diagnostics routes report
-- "Diagnostic storage unavailable". Idempotent.

insert into storage.buckets (id, name, public)
values ('worksheet-diagnostics', 'worksheet-diagnostics', false)
on conflict (id) do nothing;
