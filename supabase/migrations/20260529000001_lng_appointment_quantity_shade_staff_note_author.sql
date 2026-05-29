-- ─────────────────────────────────────────────────────────────────────────────
-- Checkpoint booker enrichment — quantity, shade, external staff-note author
--
-- Why this migration exists
-- -------------------------
-- The staff booker built into Checkpoint's ScanView creates real
-- future appointments through widget-create-appointment. Until now it
-- could only capture a single product + arch, so when a customer
-- upgraded to a same-day appliance the staff member could not record
-- the quantity, the shade (click-in veneers), or which paid upgrades
-- the customer agreed to — the exact things the customer-facing widget
-- and the in-clinic arrival flow already capture. The result was staff
-- booking customers in for the wrong thing.
--
-- Appointments stay a single-primary-product model (carts, which carry
-- the full multi-line bag, are visit-scoped and only created at
-- arrival). We extend that single product with the two columns it
-- lacked: quantity and shade. Upgrades already have a home in
-- lng_appointment_upgrade_selections.
--
-- Separately: a note a Checkpoint staff member types is a STAFF note,
-- not a customer note. It must land in lng_appointment_staff_notes. But
-- Checkpoint users have no Lounge `accounts` row, so author_account_id
-- can't attribute them. We add author_name — a free-text display name
-- for externally-authored notes — mirroring exactly how
-- lng_appointments.created_via_actor already records the external
-- actor's name when there's no account FK to point at.
-- ─────────────────────────────────────────────────────────────────────────────

-- Primary product enrichment on the appointment row.
alter table public.lng_appointments
  add column if not exists quantity int
    check (quantity is null or quantity > 0);

alter table public.lng_appointments
  add column if not exists shade text;

comment on column public.lng_appointments.quantity is
  'Quantity of the primary product the patient is being booked for. '
  'Null for legacy / single-unit bookings; > 0 when captured by the '
  'Checkpoint booker (mirrors the arrival flow''s per-line quantity).';

comment on column public.lng_appointments.shade is
  'Shade picked for the primary product (e.g. BL1 / A1 / A2). Currently '
  'only set for click_in_veneers, matching the arrival CataloguePicker. '
  'Free text snapshot — no shade catalogue table exists.';

-- External-author attribution for staff notes. Checkpoint users have no
-- accounts row, so author_account_id is null for their notes; the
-- display name lives here instead. Same shape as
-- lng_appointments.created_via_actor.
alter table public.lng_appointment_staff_notes
  add column if not exists author_name text;

comment on column public.lng_appointment_staff_notes.author_name is
  'Display name of an external author (e.g. a Checkpoint staff member) '
  'who has no Lounge accounts row. Null for in-app notes, which attribute '
  'via author_account_id. The byline prefers the joined account name and '
  'falls back to this when author_account_id is null.';
