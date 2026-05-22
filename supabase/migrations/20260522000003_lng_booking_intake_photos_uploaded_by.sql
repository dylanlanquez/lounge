-- 20260522000003_lng_booking_intake_photos_uploaded_by.sql
--
-- Adds an `uploaded_by_account_id` column to lng_booking_intake_photos
-- so the new staff-side upload path (staff-upload-intake-photo edge
-- function) can stamp who uploaded the photo. Pre-existing rows from
-- the customer widget upload stay NULL — the absence of an actor
-- IS the audit signal ("uploaded by the patient via widget").
--
-- Nullable + ON DELETE SET NULL: a staff account being removed
-- mustn't cascade-delete clinical reference photos.
--
-- Rollback:
--   alter table public.lng_booking_intake_photos
--     drop column if exists uploaded_by_account_id;

alter table public.lng_booking_intake_photos
  add column if not exists uploaded_by_account_id uuid
  references public.accounts(id) on delete set null;
