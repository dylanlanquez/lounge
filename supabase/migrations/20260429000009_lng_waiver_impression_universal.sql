-- 20260429000009_lng_waiver_impression_universal.sql
--
-- Make the impression-appointment waiver section universal — required
-- for every patient regardless of what's in the cart. Patients can be
-- asked for an impression at any stage of any visit (denture repair
-- needing a fresh impression, click-in veneers re-fit, same-day
-- appliance with a re-take), so the consent has to be on file
-- ahead of time rather than gated on a specific service_type.
--
-- Implementation: just flip applies_to_service_type from
-- 'impression_appointment' to NULL on that section. The
-- requiredSectionsForServiceTypes helper already includes every
-- section with applies_to_service_type=NULL irrespective of cart
-- contents (that's how 'general' / Privacy and consent works), so no
-- code change is needed — the next render of any waiver-aware
-- surface (Arrival, Schedule popup, patient profile chips) picks
-- this up automatically.
--
-- Idempotent: matches by section key, fine to re-run.

update public.lng_waiver_sections
   set applies_to_service_type = null
 where key = 'impression_appointment';
