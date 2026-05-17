-- 20260517000006_lng_backfill_service_type_calendly.sql
--
-- Backfill service_type on Calendly-imported appointments that have it
-- as NULL. Without service_type the phase-materialise trigger has
-- nothing to resolve, so the rows land with zero lng_appointment_phases
-- and disappear from lng_booking_check_conflict's pool-overlap query.
-- That's why the customer widget was offering 10:00 slots for a Relining
-- while a Calendly-imported in-person impression appointment was already
-- on the schedule for 10:00 — the existing booking was invisible to the
-- conflict checker.
--
-- The mapping mirrors the serviceTypeFromCalendlyLabel helper in
-- supabase/functions/_shared/serviceTypeFromCalendly.ts so the webhook
-- and this backfill agree on the label-to-enum translation. Forward-
-- imports now set service_type at insert time; this migration takes
-- care of every booking that pre-dates that fix.
--
-- Match strategy:
--   * substring patterns ordered most specific first
--   * "Virtual Impression Appointment" must beat the generic "Impression"
--     branch, so it's evaluated first
--   * rows whose event_type_label doesn't match any pattern stay NULL
--     (better unphased than mislabelled)
--
-- The phase-materialise trigger fires on UPDATE so each row touched
-- here will automatically get its lng_appointment_phases populated by
-- the time this migration commits.
--
-- Safe to re-run: the WHERE guard (`service_type is null`) makes
-- the UPDATE a no-op once a row has been classified.
-- ─────────────────────────────────────────────────────────────────

update public.lng_appointments
set service_type = 'click_in_veneers'
where service_type is null
  and event_type_label ilike '%click%in%veneer%';

update public.lng_appointments
set service_type = 'denture_repair'
where service_type is null
  and event_type_label ilike '%denture%repair%';

update public.lng_appointments
set service_type = 'same_day_appliance'
where service_type is null
  and event_type_label ilike '%same%day%appliance%';

update public.lng_appointments
set service_type = 'virtual_impression_appointment'
where service_type is null
  and (event_type_label ilike '%virtual%impression%'
       or event_type_label ilike '%impression%virtual%');

update public.lng_appointments
set service_type = 'impression_appointment'
where service_type is null
  and event_type_label ilike '%impression%';
