-- 20260505000004_lng_appointments_drop_in_progress.sql
--
-- 'in_progress' was carried as a separate appointment status, intended
-- to mark "the visit linked to this booking is mid-treatment". In
-- practice no code path ever writes it — the lifecycle today is
-- booked → arrived → complete (or no_show / cancelled / rescheduled),
-- with the live "what's happening now" lifted onto lng_visits.status.
-- Like in_chair (retired in 20260505_03), the value sits on the enum
-- as a confusing filter option and a defensive read in three places,
-- contributing nothing.
--
-- Migrate any straggler rows back to 'arrived' (defensive — production
-- has zero), then rebuild the check constraint without 'in_progress'.
-- After this migration:
--
--   • Appointment lifecycle: booked → arrived → complete
--     (or no_show / cancelled / rescheduled).
--   • Live treatment-state lives on lng_visits, not the appointment.
--
-- Rollback at the bottom restores the prior constraint.

-- ── 1. Migrate any stragglers ─────────────────────────────────────
update public.lng_appointments set status = 'arrived' where status = 'in_progress';

-- ── 2. Rebuild the check constraint without 'in_progress' ─────────
alter table public.lng_appointments drop constraint if exists lng_appointments_status_check;
alter table public.lng_appointments
  add constraint lng_appointments_status_check
  check (status in ('booked', 'arrived', 'complete', 'no_show', 'cancelled', 'rescheduled'));

-- ── Rollback ─────────────────────────────────────────────────────
-- ALTER TABLE public.lng_appointments DROP CONSTRAINT IF EXISTS lng_appointments_status_check;
-- ALTER TABLE public.lng_appointments
--   ADD CONSTRAINT lng_appointments_status_check
--   CHECK (status IN ('booked', 'arrived', 'in_progress', 'complete', 'no_show', 'cancelled', 'rescheduled'));
