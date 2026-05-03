-- 20260503000003_lng_patient_facing_duration.sql
--
-- ADR-006 / slice doc `docs/slices/booking-phases.md` — M3.
--
-- Adds the THIRD dimension of a booking type — the patient-facing
-- duration. The phase shape (M1) and per-appointment phase snapshot
-- (M2) cover the operational view; this migration adds the
-- patient-comms view.
--
-- ── Two new pieces ────────────────────────────────────────────────
--
-- 1. lng_booking_type_config.patient_facing_duration_minutes
--    Optional. Null on a child = inherit parent. Null on a parent =
--    use the derived block duration (sum of phase defaults) at
--    resolve time. Set to a different value when the admin wants
--    to tell the patient something other than the operational
--    total — e.g. denture repair: operational 35m, told patient
--    30m.
--
-- 2. lng_settings row 'booking.patient_segmented_threshold_minutes'
--    The threshold at which patient-facing copy switches from a
--    single duration line to a segmented schedule (one line per
--    active phase + return time). Default 60 — any booking with at
--    least one passive phase ≥ 60 min renders segmented copy.
--    No service-type branches anywhere.
--
-- ── What it does NOT change ───────────────────────────────────────
-- The conflict checker (M5) does not read patient_facing_duration_
-- minutes. Operational surfaces (calendar block, slot picker,
-- reschedule sheet) read block / phase durations only. The two
-- paths must not cross — this is an ADR-006 §6.6 implementation
-- rule and will be flagged in code review.
--
-- ── Idempotency ───────────────────────────────────────────────────
-- ALTER TABLE ... ADD COLUMN IF NOT EXISTS for the column. INSERT
-- ... ON CONFLICT DO NOTHING for the settings row. Safe to re-run.
--
-- ── Rollback ──────────────────────────────────────────────────────
-- See bottom of file.

-- ── 1. patient_facing_duration_minutes column ─────────────────────
alter table public.lng_booking_type_config
  add column if not exists patient_facing_duration_minutes int
    check (patient_facing_duration_minutes is null or patient_facing_duration_minutes > 0);

comment on column public.lng_booking_type_config.patient_facing_duration_minutes is
  'What we tell the patient in their confirmation. Null on a child = inherit parent. Null on a parent = resolves to the derived block duration (sum of phase defaults) at resolve time. Patient-comms only — never read by the conflict checker. See ADR-006 §6.3.1.';

-- ── 2. Segmented threshold setting ────────────────────────────────
-- Global (location_id IS NULL). Editable via Admin → Settings (later
-- slice). 60 min = any booking with at least one passive phase that
-- long renders patient comms in segmented schedule format.

insert into public.lng_settings (location_id, key, value, description) values
  (
    null,
    'booking.patient_segmented_threshold_minutes',
    '60'::jsonb,
    'Threshold for switching patient-facing copy from single-duration to segmented schedule. Any booking type with at least one passive phase whose default duration is at least this many minutes renders the segmented form. Default 60.'
  )
on conflict (key) where location_id is null do nothing;

-- ── Rollback ──────────────────────────────────────────────────────
-- delete from public.lng_settings
--  where location_id is null
--    and key = 'booking.patient_segmented_threshold_minutes';
-- alter table public.lng_booking_type_config
--   drop column if exists patient_facing_duration_minutes;
