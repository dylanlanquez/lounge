-- 20260522000002_lng_sms_virtual_call_waiting_per_service.sql
--
-- Move virtual_call_waiting from a General row (service_type=null)
-- to a virtual-impression-only row. The template is meaningless on
-- in-person / same-day bookings — it carries the meet join URL and
-- is fired only from the AppointmentDetail surface that exists on
-- virtual impression appointments — so it shouldn't appear in the
-- General pill of Admin → SMS. It belongs under a new dedicated
-- "Virtual impression" pill, alongside any future virtual-only
-- copy admins want to write.
--
-- Edge resolver (lng_resolve_sms_template) prefers a service-typed
-- override and falls back to General. With no General row for this
-- key after the update, the resolver will only return a body when
-- called with p_service_type='virtual_impression_appointment',
-- which is exactly the call path send-visit-ready-sms takes when
-- it's invoked with an appointment_id whose service_type is virtual.
--
-- Single row in the wild today (seeded yesterday), so this is a
-- straight UPDATE rather than a delete + reinsert — that way any
-- admin edits or version bumps after seeding are preserved.
--
-- Rollback:
--   update public.lng_sms_templates
--      set service_type = null
--    where key = 'virtual_call_waiting'
--      and service_type = 'virtual_impression_appointment';

update public.lng_sms_templates
   set service_type = 'virtual_impression_appointment'
 where key = 'virtual_call_waiting'
   and service_type is null;
