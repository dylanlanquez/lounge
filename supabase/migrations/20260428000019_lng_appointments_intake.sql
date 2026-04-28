-- 20260428000019_lng_appointments_intake.sql
--
-- Adds `intake jsonb` to lng_appointments to capture Calendly's
-- per-invitee questions_and_answers (e.g. for Denture Repairs:
-- [{ "question": "Repair Type", "answer": "Snapped Denture" }];
-- for Click-in Veneers: [{ "question": "Arch", "answer": "Upper" }]).
--
-- The receptionist needs this on the booking detail BEFORE the patient
-- arrives — it tells the lab what to prep.
--
-- Also adds an index for any future filtering on intake content.
--
-- Rollback:
--   ALTER TABLE public.lng_appointments DROP COLUMN intake;

alter table public.lng_appointments
  add column if not exists intake jsonb;

comment on column public.lng_appointments.intake is
  'Calendly questions_and_answers payload, verbatim. Array of {question, answer}. NULL for non-Calendly sources.';
