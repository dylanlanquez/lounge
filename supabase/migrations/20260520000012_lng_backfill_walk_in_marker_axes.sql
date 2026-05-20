-- 20260520000012_lng_backfill_walk_in_marker_axes.sql
--
-- Walk-in marker rows on lng_appointments were inserted with
-- service_type = null and event_type_label = 'Walk-in', so every
-- surface that formats the row through formatAppointmentSummary
-- (Schedule click sheet, patient timeline, visit hero) rendered
-- "Walk-in" as the booking title regardless of what service the
-- receptionist had actually staged in the cart.
--
-- The walk-in's actual service axis sits on lng_walk_ins.service_type.
-- This backfill copies it onto the matching marker appointment row
-- so historical walk-ins read the correct label retroactively. New
-- walk-ins land with the axis populated (visits.ts now writes it on
-- the marker insert directly).
--
-- arch / product_key / repair_variant stay null because lng_walk_ins
-- doesn't persist them — only service_type. Going forward
-- createWalkInVisit accepts them as optional inputs from the
-- catalogue picker so future walk-ins for impression / same-day
-- variants can carry the full axis pin set.

update public.lng_appointments a
   set service_type = w.service_type
  from public.lng_walk_ins w
 where a.walk_in_id = w.id
   and a.service_type is null
   and w.service_type is not null;
