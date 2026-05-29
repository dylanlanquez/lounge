-- 20260529000002_lng_appointment_items.sql
--
-- Multi-item bag for Checkpoint bookings.
--
-- The Checkpoint staff booker now builds a bag of several products for
-- one appointment (e.g. a same-day Retainer ×2 (both) + a Night Guard
-- (upper), each with its own upgrades), mirroring the Lounge arrival
-- "Choose product or service" flow. A future appointment has no cart
-- (carts are visit-scoped, created at arrival), so the planned bag needs
-- an appointment-scoped home.
--
-- Two tables instead of JSONB, matching the existing
-- lng_appointment_upgrade_selections / lng_appointment_repair_items
-- design: each item + upgrade is a discrete, queryable, reportable row;
-- price + name are snapshotted at write time so a later catalogue edit
-- doesn't change a settled booking; cascade-on-delete keeps appointment
-- removal clean.
--
-- The customer widget is unaffected — it keeps writing a single product
-- + lng_appointment_upgrade_selections. These tables are populated only
-- by source='checkpoint' bookings.
--
-- Rollback: DROP TABLE both (no dependent views/triggers).

-- ─────────────────────────────────────────────────────────────────────
-- lng_appointment_items — one row per product in the booked bag
-- ─────────────────────────────────────────────────────────────────────

create table if not exists public.lng_appointment_items (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references public.lng_appointments(id) on delete cascade,
  -- lwo_catalogue.id of the picked row. No FK because the catalogue can
  -- be soft-deleted; the snapshot fields below are what staff render.
  catalogue_id uuid,
  -- Service + product axis pins, snapshotted. service_type is the
  -- appointment type; product_key identifies the appliance (null for the
  -- impression / virtual appointment rows which have no product_key).
  service_type text not null,
  product_key text,
  -- Display name snapshot.
  name text not null,
  -- Arch this item applies to (null when arch_match is 'any').
  arch text check (arch is null or arch in ('upper','lower','both')),
  -- Shade snapshot (e.g. 'BL1') — only set for click-in veneers today.
  shade text,
  -- Staff-set quantity for this line.
  quantity integer not null check (quantity > 0),
  -- Per-unit price snapshot, arch-resolved (both-arches price when the
  -- item's arch is 'both' and the catalogue carries one). Re-resolved
  -- server-side at write time; never trusted from the client.
  unit_price_pence integer not null check (unit_price_pence >= 0),
  -- unit_price_pence * quantity, computed server-side.
  line_total_pence integer not null check (line_total_pence >= 0),
  -- Whether this item's price is meaningful to display. False for the
  -- informational products attached to impression / virtual appointments
  -- (the £0 appointment isn't selling the product; the pick just tells
  -- the clinician what to prepare for). True for same-day services.
  price_shown boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists lng_appointment_items_appointment_idx
  on public.lng_appointment_items(appointment_id);

comment on table public.lng_appointment_items is
  'The planned product bag for a Checkpoint-booked appointment. One row per product the staff member added (with its quantity, arch, shade). Price + name frozen at booking time. Cascade-deleted with the appointment. The customer widget does not write here.';

-- ─────────────────────────────────────────────────────────────────────
-- lng_appointment_item_upgrades — upgrades attached to a bag item
-- ─────────────────────────────────────────────────────────────────────

create table if not exists public.lng_appointment_item_upgrades (
  id uuid primary key default gen_random_uuid(),
  appointment_item_id uuid not null references public.lng_appointment_items(id) on delete cascade,
  -- lwo_catalogue.id of the upgrade. No FK (soft-delete), snapshot covers display.
  upgrade_id uuid not null,
  upgrade_code text not null,
  name text not null,
  unit_price_pence integer not null check (unit_price_pence >= 0),
  both_arches_price_pence integer check (both_arches_price_pence is null or both_arches_price_pence >= 0),
  -- The arch-resolved price that applies for this item, server-computed.
  resolved_price_pence integer not null check (resolved_price_pence >= 0),
  created_at timestamptz not null default now(),
  unique (appointment_item_id, upgrade_code)
);

create index if not exists lng_appointment_item_upgrades_item_idx
  on public.lng_appointment_item_upgrades(appointment_item_id);

comment on table public.lng_appointment_item_upgrades is
  'Snapshot of paid upgrades attached to a single lng_appointment_items row. One row per ticked upgrade; price + name frozen at booking time. Cascade-deleted with the item.';

-- ─────────────────────────────────────────────────────────────────────
-- RLS — same posture as lng_appointment_upgrade_selections: authenticated
-- staff get full access; the service-role edge function bypasses RLS.
-- The customer widget never reads these.
-- ─────────────────────────────────────────────────────────────────────

alter table public.lng_appointment_items enable row level security;
alter table public.lng_appointment_item_upgrades enable row level security;

create policy lng_appointment_items_staff
  on public.lng_appointment_items
  for all
  to authenticated
  using (true)
  with check (true);

create policy lng_appointment_item_upgrades_staff
  on public.lng_appointment_item_upgrades
  for all
  to authenticated
  using (true)
  with check (true);
