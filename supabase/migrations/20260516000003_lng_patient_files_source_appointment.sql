-- ─────────────────────────────────────────────────────────────────────────────
-- Lounge — link patient_files rows back to the appointment that
-- promoted them.
--
-- When a Lounge appointment's smile-photo intake is promoted to the
-- patient profile, the destination row goes into the shared
-- patient_files table. Today the SmilePhotosCard predicate "is this
-- already on the profile?" checks the label-key only — meaning a
-- previous appointment's promoted front-smile photo makes EVERY
-- subsequent appointment's button read "Added to patient's profile"
-- even though that specific appointment's photo was never promoted.
--
-- Fix: add a nullable source_appointment_id column so each promoted
-- row carries a back-reference to the appointment it came from. The
-- predicate then asks "did THIS appointment promote a row for this
-- label?" — which is what the operator actually wants to know.
--
-- Nullable because:
--   • Existing patient_files rows (pre-migration) have no source
--     appointment to attribute. They stay NULL.
--   • Staff-uploaded files from non-appointment surfaces (the
--     general patient-profile uploader) also have no appointment
--     and should not break by being forced to claim one.
--
-- FK on delete set null: if the appointment is ever hard-deleted
-- (rare; Lounge soft-cancels), the patient file stays — it's the
-- patient's history, not the appointment's.
--
-- Index for the lookup the SmilePhotosCard hook is about to run:
--   "for this patient, did this appointment promote a row of this
--    label?" — keyed on (patient_id, source_appointment_id).
--
-- Idempotent — re-running the migration is a no-op.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.patient_files
  add column if not exists source_appointment_id uuid
    references public.lng_appointments(id) on delete set null;

create index if not exists patient_files_patient_source_appointment_idx
  on public.patient_files (patient_id, source_appointment_id)
  where source_appointment_id is not null;

comment on column public.patient_files.source_appointment_id is
  'When set, this file row was promoted from the named Lounge appointment''s intake (e.g. smile-photo intake on the booking success screen). Drives the SmilePhotosCard "is this appointment''s photo on the profile?" check so a previous appointment''s promotion does not poison a new appointment''s button state. NULL for staff-uploaded files and any pre-migration rows.';
