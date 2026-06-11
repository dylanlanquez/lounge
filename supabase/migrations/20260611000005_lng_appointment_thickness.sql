-- Retainer thickness on impression bookings.
--
-- Staff booking a virtual or in-person impression appointment through
-- Checkpoint now pick a retainer thickness (1mm or 1.5mm). It travels through
-- the existing widget-create-appointment edge function and lands here as the
-- primary product axis (lng_appointments.thickness), with the per-item value
-- on lng_appointment_items.thickness — mirroring how shade/arch already work.
--
-- Nullable: every other product (and every pre-existing row) leaves it null.
-- The whitelist matches the two options the Checkpoint picker offers.

alter table public.lng_appointments
  add column if not exists thickness text
  check (thickness is null or thickness in ('1mm', '1.5mm'));

alter table public.lng_appointment_items
  add column if not exists thickness text
  check (thickness is null or thickness in ('1mm', '1.5mm'));

comment on column public.lng_appointments.thickness is
  'Retainer thickness (1mm | 1.5mm) chosen at Checkpoint booking for impression / virtual impression appointments. Null for non-retainer products.';
comment on column public.lng_appointment_items.thickness is
  'Per-item retainer thickness (1mm | 1.5mm). Null for non-retainer items.';
