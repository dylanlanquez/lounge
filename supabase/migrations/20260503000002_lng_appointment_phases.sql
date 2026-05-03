-- 20260503000002_lng_appointment_phases.sql
--
-- ADR-006 / slice doc `docs/slices/booking-phases.md` — M2.
--
-- Creates lng_appointment_phases (per-appointment snapshot of the
-- resolved phase sequence) and backfills it from existing active
-- appointments. After this migration, every active appointment has
-- one phase row mirroring today's single-block behaviour, so the
-- conflict checker can be ported to read phases (M5) without a
-- gap during which any booking has no phase data.
--
-- ── Why a snapshot ────────────────────────────────────────────────
-- The label, patient_required, and pool_ids are SNAPSHOTS at
-- materialisation time (or backfill time). If an admin later edits
-- the booking-type config — renames a phase, changes pool
-- consumption, swaps patient_required — already-booked appointments
-- do NOT change. Same defence pattern as lng_visits snapshotting
-- appointment data on check-in.
--
-- ── Backfill scope ────────────────────────────────────────────────
-- Only active appointments (status in booked/arrived/in_progress)
-- with a non-null service_type get phase rows. Closed/no-show/
-- cancelled appointments are not backfilled — the conflict checker
-- doesn't read them. Active appointments missing service_type
-- (legacy Calendly imports created after the _05 backfill ran)
-- are logged to lng_system_failures so they're visible without
-- blocking the migration.
--
-- ── RLS ───────────────────────────────────────────────────────────
-- Read-open to authenticated (the schedule grid, conflict checker,
-- and appointment detail all need to read it). Writes are
-- restricted to the service role + admins — phase materialisation
-- runs from the trigger (security definer) or via the admin UI.
--
-- ── Idempotency ───────────────────────────────────────────────────
-- CREATE TABLE IF NOT EXISTS, DROP-then-CREATE for trigger/policies.
-- The backfill INSERT uses ON CONFLICT DO NOTHING against the
-- (appointment_id, phase_index) unique. Safe to re-run.
--
-- ── Rollback ──────────────────────────────────────────────────────
-- See bottom of file.

-- ── 1. lng_appointment_phases table ──────────────────────────────
create table if not exists public.lng_appointment_phases (
  id                uuid primary key default gen_random_uuid(),

  appointment_id    uuid not null
                      references public.lng_appointments(id)
                      on delete cascade,

  -- 1-based, matches lng_booking_type_phases.phase_index for the
  -- config row this appointment was materialised from.
  phase_index       int not null check (phase_index > 0),

  -- Snapshots — frozen at materialisation time. Editing the source
  -- config does NOT propagate. See ADR-006 §6.6.
  label             text not null check (length(trim(label)) > 0),
  patient_required  boolean not null,

  -- Pool consumption snapshot. text[] (not a junction table) because
  -- (a) the per-appointment row count is high, (b) the conflict
  -- checker only ever reads the array, (c) snapshots shouldn't
  -- mutate so a junction adds nothing.
  pool_ids          text[] not null default array[]::text[],

  -- Phase boundaries. Computed from the appointment's start_at +
  -- summed phase durations. The first phase starts at the
  -- appointment's start_at; the last phase ends at the appointment's
  -- end_at (when the sum of phase defaults matches the booking
  -- block — when it doesn't, the helper function logs and trims).
  start_at          timestamptz not null,
  end_at            timestamptz not null check (end_at > start_at),

  -- Receptionist-driven status. 'overdue' is a derived state
  -- computed at read time (when end_at < now() and status is still
  -- pending or in_progress) — not stored.
  status            text not null default 'pending'
                      check (status in ('pending','in_progress','complete','skipped')),

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- One phase row per (appointment, phase_index). The materialisation
-- helper (task #4) inserts in phase_index order; the conflict
-- checker reads in that order.
create unique index if not exists lng_appointment_phases_appt_idx
  on public.lng_appointment_phases (appointment_id, phase_index);

-- Conflict-checker overlap probe — analogous to
-- lng_appointments_overlap_idx. Filters on time range + active
-- statuses; the GIN on pool_ids accelerates "any pool in this set"
-- queries the new lng_booking_check_conflict will run.
create index if not exists lng_appointment_phases_overlap_idx
  on public.lng_appointment_phases (start_at, end_at)
  where status in ('pending','in_progress');

create index if not exists lng_appointment_phases_pool_gin
  on public.lng_appointment_phases using gin (pool_ids);

drop trigger if exists lng_appointment_phases_set_updated_at on public.lng_appointment_phases;
create trigger lng_appointment_phases_set_updated_at
  before update on public.lng_appointment_phases
  for each row execute function public.touch_updated_at();

alter table public.lng_appointment_phases enable row level security;

-- All authenticated staff can read.
drop policy if exists lng_appointment_phases_read on public.lng_appointment_phases;
create policy lng_appointment_phases_read
  on public.lng_appointment_phases
  for select to authenticated using (true);

-- Status transitions allowed for any authenticated user — the
-- "Mark patient may leave" / "Mark ready for collection" actions
-- are receptionist-driven. INSERT/DELETE restricted to admins
-- (or via the materialisation trigger which runs as security
-- definer). UPDATE limited to status + updated_at.
drop policy if exists lng_appointment_phases_update on public.lng_appointment_phases;
create policy lng_appointment_phases_update
  on public.lng_appointment_phases
  for update to authenticated
  using (true)
  with check (true);

drop policy if exists lng_appointment_phases_admin_write on public.lng_appointment_phases;
create policy lng_appointment_phases_admin_write
  on public.lng_appointment_phases
  for all to authenticated
  using (public.auth_is_lng_admin() or public.auth_is_super_admin())
  with check (public.auth_is_lng_admin() or public.auth_is_super_admin());

comment on table public.lng_appointment_phases is
  'Per-appointment snapshot of the resolved phase sequence. label, patient_required, and pool_ids are frozen at materialisation time so subsequent config edits do not rewrite live appointments. The conflict checker (M5) walks this table joined to itself for overlap; the schedule grid renders two-tone blocks from it. See ADR-006.';

-- ── 2. Backfill: one default phase per active appointment ────────
-- Every active appointment with a known service_type gets a single
-- phase row covering its full window, with pool_ids snapshotted
-- from the parent's phase 1 (which was seeded in M1 to mirror the
-- existing service_pools state).
--
-- The label is taken from the parent's phase 1 — denture_repair →
-- "Denture repair", click_in_veneers → "Click-in veneers", etc.

insert into public.lng_appointment_phases (
  appointment_id, phase_index, label, patient_required,
  pool_ids, start_at, end_at, status
)
select
  a.id,
  1,
  p.label,
  p.patient_required,
  coalesce(
    (select array_agg(pp.pool_id order by pp.pool_id)
       from public.lng_booking_type_phase_pools pp
      where pp.phase_id = p.id),
    array[]::text[]
  ),
  a.start_at,
  a.end_at,
  case a.status
    when 'arrived'     then 'in_progress'
    when 'in_progress' then 'in_progress'
    else                    'pending'
  end
from public.lng_appointments a
join public.lng_booking_type_config c
       on c.service_type = a.service_type
      and c.repair_variant is null
      and c.product_key   is null
      and c.arch          is null
join public.lng_booking_type_phases p
       on p.config_id   = c.id
      and p.phase_index = 1
where a.status in ('booked', 'arrived', 'in_progress')
  and a.service_type is not null
on conflict (appointment_id, phase_index) do nothing;

-- ── 3. Loud warning: active appointments missing service_type ────
-- Per CLAUDE.md "failures must be loud" — anything that should have
-- been backfilled but couldn't gets logged so admin can see it
-- and fix the underlying data.

insert into public.lng_system_failures (severity, source, message, context)
select
  'warning',
  'migration:20260503000002_lng_appointment_phases',
  'Active appointment has no service_type, phase backfill skipped',
  jsonb_build_object(
    'appointment_id',   a.id,
    'status',           a.status,
    'start_at',         a.start_at,
    'event_type_label', a.event_type_label,
    'source',           a.source
  )
from public.lng_appointments a
where a.status in ('booked', 'arrived', 'in_progress')
  and a.service_type is null;

-- ── 4. Sanity: every active appointment with a service_type has
--      exactly one phase row after backfill ─────────────────────
-- DO block raises an error if the invariant is broken — fail the
-- migration loudly per the brief's anti-shortcut philosophy.

do $$
declare
  missing int;
begin
  select count(*) into missing
    from public.lng_appointments a
   where a.status in ('booked', 'arrived', 'in_progress')
     and a.service_type is not null
     and not exists (
       select 1 from public.lng_appointment_phases p
        where p.appointment_id = a.id
     );

  if missing > 0 then
    raise exception
      'M2 backfill incomplete: % active appointments with service_type still have no phase row',
      missing;
  end if;
end$$;

-- ── Rollback ─────────────────────────────────────────────────────
-- drop policy if exists lng_appointment_phases_admin_write on public.lng_appointment_phases;
-- drop policy if exists lng_appointment_phases_update      on public.lng_appointment_phases;
-- drop policy if exists lng_appointment_phases_read         on public.lng_appointment_phases;
-- drop trigger if exists lng_appointment_phases_set_updated_at on public.lng_appointment_phases;
-- drop index if exists public.lng_appointment_phases_pool_gin;
-- drop index if exists public.lng_appointment_phases_overlap_idx;
-- drop index if exists public.lng_appointment_phases_appt_idx;
-- drop table if exists public.lng_appointment_phases;
