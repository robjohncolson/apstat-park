-- 900_trainer_assets_bucket.sql  (content project)
--
-- PRIVATE bucket for the TI-84 CE ROM the v2 trainer boots in WebCEmu. The ROM is the teacher's own
-- (copied from a calculator they own) and is NEVER committed. site/ti84-trainer-v2/rom-config.js holds a
-- long-lived signed URL to <bucket>/ROM.rom; generate yours from Storage → ti84-trainer-assets → ROM.rom →
-- "Create signed URL". Optional: the trainer also accepts a local ROM file on first launch and keeps it in
-- IndexedDB. Idempotent.

insert into storage.buckets (id, name, public)
values ('ti84-trainer-assets', 'ti84-trainer-assets', false)
on conflict (id) do nothing;
