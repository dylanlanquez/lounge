-- 20260918000002_lng_patient_files_photo_thumbnail.sql
--
-- Adds lng_thumbnail_path to patient_files: a small (long edge ~800px)
-- JPEG generated client-side at upload time for before/after and
-- marketing-content photos, so the marketing page and the appointment
-- page's photo galleries don't have to sign and load multi-megabyte
-- phone-camera originals just to show a few hundred pixels.
--
-- Distinct from Meridian's existing thumbnail_path column, which
-- caches a rendered preview PNG for STL/OBJ scan files, a different
-- concept for a different file type, owned by Meridian's own
-- scan-processing pipeline. Reusing that column here would conflate
-- two unrelated thumbnail mechanisms on a table Lounge does not own
-- outright. Same reasoning as source_appointment_id
-- (20260516000003): a Lounge-owned, clearly-named append-only column
-- on a shared table, never touched by Meridian's side.
--
-- NULL on every row until either a fresh upload populates it or the
-- companion backfill (lng-backfill-photo-thumbnails edge function,
-- run once) generates one for existing photos.
--
-- ── Apply order (per CLAUDE.md) ──────────────────────────────────
-- Write -> shadow (verify) -> Meridian. No destructive operations.

alter table public.patient_files
  add column if not exists lng_thumbnail_path text;

comment on column public.patient_files.lng_thumbnail_path is
  'Lounge-generated small JPEG (long edge ~800px) for before/after and marketing-content photos. NULL falls back to file_url (the original) when rendering a thumbnail. Not the same as thumbnail_path, which is Meridian''s STL/OBJ scan preview cache.';
