-- 20260515000003_lng_appointment_upgrades_and_repair_items.sql
--
-- Persist the patient's widget-side picks (paid upgrades + denture-
-- repair line items) on the booking row so they flow through to every
-- staff-facing surface: AppointmentDetail, VisitDetail, the Arrival
-- staging basket, the printed waiver. The widget already captures both
-- in state; the create-appointment edge function carried them in the
-- payload but had no place to write them. This migration creates that
-- place.
--
-- Two tables instead of JSONB columns on lng_appointments because:
--   • Each upgrade / repair line is a discrete, queryable record (we
--     report on revenue per upgrade, repair-mix per location, etc.).
--   • Editing or removing one line shouldn't require a JSONB rewrite.
--   • Cascade-on-delete keeps appointment removal clean without trigger
--     plumbing.
--
-- Both tables snapshot price + name at insert time so a catalogue edit
-- mid-flight doesn't change the patient's commitment after the fact.
-- The catalogue id stays as a foreign-key-ish reference (no FK because
-- lwo_catalogue rows can be soft-deleted; the snapshot covers display),
-- so the join is best-effort live and falls back to the snapshot.
--
-- Apply order per CLAUDE.md: shadow first, then production.
-- Rollback: DROP TABLE both tables (no dependent views or triggers
-- yet — check before re-deploying display surfaces).

-- ─────────────────────────────────────────────────────────────────────
-- lng_appointment_upgrade_selections — one row per ticked upgrade
-- ─────────────────────────────────────────────────────────────────────

create table if not exists public.lng_appointment_upgrade_selections (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references public.lng_appointments(id) on delete cascade,
  -- lwo_catalogue.id of the upgrade row the patient selected. No FK
  -- because the catalogue can be soft-deleted; if it disappears the
  -- snapshot below is what the staff app renders.
  upgrade_id uuid not null,
  -- Catalogue code (e.g. 'titanium_nightguard'). Convenient for
  -- analytics filters even when name copy changes.
  upgrade_code text not null,
  -- Display name snapshotted at insert time. Renderer prefers this
  -- over re-resolving the catalogue so a name change post-booking
  -- doesn't relabel a settled appointment.
  name text not null,
  -- 'per arch' / 'per tooth' / null. Drives quantity rendering.
  unit_label text,
  -- Per-unit price snapshotted at insert time. Resolved against the
  -- appointment's arch and stored in resolved_price_pence below.
  unit_price_pence integer not null check (unit_price_pence >= 0),
  -- Optional both-arches override snapshot. NULL when the catalogue
  -- row doesn't carry a both-arches price.
  both_arches_price_pence integer check (both_arches_price_pence is null or both_arches_price_pence >= 0),
  -- The price that will hit the cart for this appointment, after
  -- arch resolution. Computed server-side at write time so the
  -- waiver totals match the cart totals exactly.
  resolved_price_pence integer not null check (resolved_price_pence >= 0),
  created_at timestamptz not null default now(),
  unique (appointment_id, upgrade_code)
);

create index if not exists lng_appointment_upgrade_selections_appointment_idx
  on public.lng_appointment_upgrade_selections(appointment_id);

comment on table public.lng_appointment_upgrade_selections is
  'Snapshot of paid upgrades the patient selected in the booking widget. One row per ticked upgrade; price + name frozen at booking time so post-write catalogue edits do not retroactively change the appointment commitment. Cascade-deleted with the appointment row.';

-- ─────────────────────────────────────────────────────────────────────
-- lng_appointment_repair_items — one row per denture-repair line
-- ─────────────────────────────────────────────────────────────────────

create table if not exists public.lng_appointment_repair_items (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references public.lng_appointments(id) on delete cascade,
  -- lwo_catalogue.id of the repair row. Same soft-delete reasoning
  -- as upgrade_id above.
  catalogue_id uuid not null,
  -- Catalogue code (e.g. 'den_snapped', 'den_reline'). Drives the
  -- friendly-title mapping the widget uses.
  code text not null,
  -- Catalogue's repair_variant column value (e.g. 'Snapped denture',
  -- 'Broken tooth', 'Relining'). Mirrors the column the upgrades
  -- query, slot RPC, and resolver all filter on.
  repair_variant text not null,
  -- Display name snapshot.
  name text not null,
  -- 'per tooth' / 'per arch' / null. The renderer + cart staging
  -- need this to know whether to show "× 3 teeth" alongside the
  -- price.
  unit_label text,
  -- Which arch the patient said this line applies to.
  arch text not null check (arch in ('upper','lower','both')),
  -- Patient-set quantity. Per-tooth lines accept 1-14 (matches the
  -- widget stepper); per-arch / flat lines stay at 1.
  quantity integer not null check (quantity > 0),
  -- Snapshotted unit price at insert time.
  unit_price_pence integer not null check (unit_price_pence >= 0),
  -- Snapshotted both-arches override price. NULL when the catalogue
  -- row doesn't carry one.
  both_arches_price_pence integer check (both_arches_price_pence is null or both_arches_price_pence >= 0),
  -- The price that will hit the cart for this line, computed
  -- server-side at write time using the same resolution rules as
  -- the widget price preview (per-tooth scales by quantity; per-arch
  -- 'both' uses both_arches_price when set).
  line_total_pence integer not null check (line_total_pence >= 0),
  created_at timestamptz not null default now()
);

create index if not exists lng_appointment_repair_items_appointment_idx
  on public.lng_appointment_repair_items(appointment_id);

comment on table public.lng_appointment_repair_items is
  'Snapshot of denture-repair line items the patient selected in the booking widget. One row per arch-scoped repair (so a "both" booking that picked a Reline + 2 Broken Teeth on the lower arch produces three rows). Price + name frozen at booking time. Cascade-deleted with the appointment row.';

-- ─────────────────────────────────────────────────────────────────────
-- RLS — same posture as lng_appointments. Anon role gets read access
-- via the widget's appointment-lookup token path; staff role has full
-- access via service-role / authenticated grants. We deliberately do
-- not enable a permissive anon policy — the staff app uses the
-- authenticated role and the widget never reads these back.
-- ─────────────────────────────────────────────────────────────────────

alter table public.lng_appointment_upgrade_selections enable row level security;
alter table public.lng_appointment_repair_items enable row level security;

-- Authenticated staff: full access (RLS via the standard staff policy
-- pattern used elsewhere in the lng_ schema). The service role bypass
-- is automatic for edge functions; staff policies guard the kiosk.
create policy lng_appointment_upgrade_selections_staff
  on public.lng_appointment_upgrade_selections
  for all
  to authenticated
  using (true)
  with check (true);

create policy lng_appointment_repair_items_staff
  on public.lng_appointment_repair_items
  for all
  to authenticated
  using (true)
  with check (true);
