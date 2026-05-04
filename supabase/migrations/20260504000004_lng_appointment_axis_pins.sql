-- 20260504000004_lng_appointment_axis_pins.sql
--
-- Persists the booking-type axis pins (repair_variant, product_key,
-- arch) on lng_appointments. The new-booking flow now asks the
-- receptionist to pin the right child axes for the chosen service
-- (e.g. for a same-day appliance: which appliance and which arch),
-- and the resolver uses those pins to pick the right booking-type
-- config. Storing them on the row means:
--
--   - Reschedule preserves the pins (new slot inherits the same
--     duration/working hours rules as the original).
--   - The catalogue picker on visit-detail can match the receptionist's
--     pre-stated intent without re-inferring from intake.
--   - Reports can break activity down by what was actually booked,
--     not just the parent service.
--
-- Also fixes a stale service_type CHECK that was missing
-- 'virtual_impression_appointment' (the type was added as first-class
-- in commit 3cc8a84 but the appointments-side constraint never caught
-- up — any attempt to insert one would have failed).

begin;

-- ── 1. Axis pin columns ────────────────────────────────────────────────────
alter table public.lng_appointments
  add column if not exists repair_variant text null,
  add column if not exists product_key    text null,
  add column if not exists arch           text null;

-- arch values are constrained the same way they are everywhere else
-- in the system. NULL means "no arch pinned" (e.g. denture repair has
-- no arch axis; whitening kit doesn't expose arch).
alter table public.lng_appointments
  drop constraint if exists lng_appointments_arch_check;

alter table public.lng_appointments
  add constraint lng_appointments_arch_check
  check (arch is null or arch in ('upper', 'lower', 'both'));

comment on column public.lng_appointments.repair_variant is
  'Booking-type axis pin: the variant of denture repair (e.g. "Snapped"). NULL when the service does not have a variant axis or the receptionist did not pin one.';

comment on column public.lng_appointments.product_key is
  'Booking-type axis pin: which product (e.g. retainer, whitening_tray) for services that have a product axis (same-day appliance, virtual impression). NULL when the service has no product axis.';

comment on column public.lng_appointments.arch is
  'Booking-type axis pin: upper / lower / both. NULL when the service or product does not expose arch (denture repair, whitening kit).';

-- ── 2. Refresh service_type CHECK ──────────────────────────────────────────
-- Add 'virtual_impression_appointment'. The type was added in
-- 20260504000001 but the appointments CHECK never included it.
alter table public.lng_appointments
  drop constraint if exists lng_appointments_service_type_check;

alter table public.lng_appointments
  add constraint lng_appointments_service_type_check
  check (
    service_type is null
    or service_type in (
      'denture_repair',
      'click_in_veneers',
      'same_day_appliance',
      'impression_appointment',
      'virtual_impression_appointment',
      'other'
    )
  );

commit;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- ALTER TABLE public.lng_appointments DROP CONSTRAINT IF EXISTS lng_appointments_arch_check;
-- ALTER TABLE public.lng_appointments DROP COLUMN IF EXISTS arch;
-- ALTER TABLE public.lng_appointments DROP COLUMN IF EXISTS product_key;
-- ALTER TABLE public.lng_appointments DROP COLUMN IF EXISTS repair_variant;
-- (service_type CHECK rollback intentionally omitted — narrowing it
--  back would reject existing virtual_impression_appointment rows.)
