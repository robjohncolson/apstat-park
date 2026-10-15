-- 900_pc_figures_bucket.sql  (core project)
--
-- The PRIVATE storage bucket that holds Progress Check figures. roster-server signs short-lived URLs
-- for it with the service key (services/roster/pc-figures.js). The figure files themselves are not in
-- this repo (College Board material); upload them to match services/roster/data/pc-figures-manifest.json.
-- Idempotent.

insert into storage.buckets (id, name, public)
values ('pc-figures', 'pc-figures', false)
on conflict (id) do nothing;
