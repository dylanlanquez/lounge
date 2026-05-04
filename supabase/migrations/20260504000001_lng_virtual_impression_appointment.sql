-- 20260504000001_lng_virtual_impression_appointment.sql
--
-- Adds `virtual_impression_appointment` as a first-class booking type
-- so it shows up in the admin Booking types tab and the Services tab,
-- not just as a teal-coloured outlier on the schedule.
--
-- Today, Calendly's "Virtual Impression Appointment" event flows in
-- with no service_type (Calendly bookings store event_type_label and
-- a join_url; the schedule card derives the teal colour by regex).
-- Admin had no way to configure working hours, phases, or patient-
-- facing duration for the virtual variant. This migration makes it a
-- proper service_type with its own row in lng_booking_type_config and
-- a catalogue entry in lwo_catalogue.
--
-- Inferrer change (in src/lib/queries/waiver.ts) makes new Calendly
-- imports resolve to this new type. The impression_appointment waiver
-- section is already an always-on section (applies_to_service_type IS
-- NULL), so virtual bookings keep picking it up — no compliance gap.

-- ── 1. Loosen the service_type check to include the new value ─────
alter table public.lng_booking_type_config
  drop constraint if exists lng_booking_type_config_service_type_check;

alter table public.lng_booking_type_config
  add constraint lng_booking_type_config_service_type_check
  check (service_type = any (array[
    'denture_repair'::text,
    'click_in_veneers'::text,
    'same_day_appliance'::text,
    'impression_appointment'::text,
    'virtual_impression_appointment'::text,
    'other'::text
  ]));

-- ── 2. Parent config row for the new service_type ────────────────
--
-- Working hours mirror the in-person impression default (Mon-Fri 9-18,
-- Sat 10-16, Sun closed). Patient-facing window is 15-15 min — virtual
-- impressions are a single video call, no chair/lab time, so it's a
-- tighter window than in-person. A pure parent row has no repair_variant /
-- product_key / arch.
--
-- Idempotent: if a virtual_impression_appointment parent already exists,
-- skip the insert.

insert into public.lng_booking_type_config (
  service_type,
  working_hours,
  patient_facing_min_minutes,
  patient_facing_max_minutes
)
select
  'virtual_impression_appointment',
  jsonb_build_object(
    'mon', jsonb_build_object('open', '09:00', 'close', '18:00'),
    'tue', jsonb_build_object('open', '09:00', 'close', '18:00'),
    'wed', jsonb_build_object('open', '09:00', 'close', '18:00'),
    'thu', jsonb_build_object('open', '09:00', 'close', '18:00'),
    'fri', jsonb_build_object('open', '09:00', 'close', '18:00'),
    'sat', jsonb_build_object('open', '10:00', 'close', '16:00'),
    'sun', null
  ),
  15,
  15
where not exists (
  select 1
  from public.lng_booking_type_config
  where service_type = 'virtual_impression_appointment'
    and repair_variant is null
    and product_key is null
    and arch is null
);

-- ── 3. Default phases for the new service ────────────────────────
--
-- Virtual impression is a single block of patient time: the video call
-- where the operator walks the patient through capturing the impression
-- via the One Click app. No book-in chair, no lab work. A single phase
-- with patient_required = true keeps the schedule colour-block solid.

insert into public.lng_booking_type_phases (
  config_id,
  phase_index,
  label,
  patient_required,
  duration_default
)
select
  c.id,
  1,
  'Video call',
  true,
  15
from public.lng_booking_type_config c
where c.service_type = 'virtual_impression_appointment'
  and c.repair_variant is null
  and c.product_key is null
  and c.arch is null
  and not exists (
    select 1 from public.lng_booking_type_phases p
    where p.config_id = c.id
  );

-- ── 4. Catalogue entry for the new service ───────────────────────
--
-- Mirrors the existing 'impression_appt' row but priced at 0.00 (same
-- as in-person — actual pricing is handled per-product / per-arch on
-- the cart). is_service=true so it slots into the Services tab and
-- not the Products tab. quantity_enabled and include_on_lwo follow
-- the impression default.

insert into public.lwo_catalogue (
  code,
  category,
  name,
  unit_price,
  service_type,
  is_service,
  arch_match,
  quantity_enabled,
  include_on_lwo,
  allocate_job_box,
  active
)
select
  'virtual_impression_appt',
  'Impression appointments',
  'Virtual impression appointment',
  0.00,
  'virtual_impression_appointment',
  true,
  'any',
  false,
  false,
  false,
  true
where not exists (
  select 1 from public.lwo_catalogue where code = 'virtual_impression_appt'
);

-- ── Rollback ─────────────────────────────────────────────────────
--
-- delete from public.lwo_catalogue where code = 'virtual_impression_appt';
-- delete from public.lng_booking_type_phases where config_id in (
--   select id from public.lng_booking_type_config where service_type = 'virtual_impression_appointment'
-- );
-- delete from public.lng_booking_type_config where service_type = 'virtual_impression_appointment';
-- alter table public.lng_booking_type_config drop constraint lng_booking_type_config_service_type_check;
-- alter table public.lng_booking_type_config add constraint lng_booking_type_config_service_type_check
--   check (service_type = any (array['denture_repair'::text, 'click_in_veneers'::text, 'same_day_appliance'::text, 'impression_appointment'::text, 'other'::text]));
