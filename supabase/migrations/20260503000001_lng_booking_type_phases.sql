-- 20260503000001_lng_booking_type_phases.sql
--
-- ADR-006 / slice doc `docs/slices/booking-phases.md` — M1.
--
-- Generalises the booking-type model from "one block, one pool list,
-- whole-window consumption" to "a sequence of phases, each with its
-- own duration, its own answer to 'is the patient required?', and
-- its own pool consumption".
--
-- Today, every booking is implicitly a single phase that consumes
-- its service-level pool list for the whole [start_at, end_at]
-- window (lng_booking_service_pools). That model cannot represent:
--
--   • Denture repair — 15 min patient-in chair work + 15-20 min
--     bench-only work where the chair is free for the next patient.
--   • Click-in Veneers — 30 min impression + 3-6 h lab fabrication
--     (no patient, lab bench held, chair free) + 20 min fit (chair
--     held AGAIN, patient back).
--
-- Phases let both shapes (and any future N-phase shape) live in one
-- model with no service-type code branches. A 1-phase booking is the
-- degenerate case and behaves identically to today.
--
-- ── This migration ─────────────────────────────────────────────────
--
-- 1. Create lng_booking_type_phases — phase definitions hung off a
--    parent (or child) lng_booking_type_config row. phase_index
--    orders them. patient_required is the structural "do we need the
--    patient here?" flag. duration_min/max/default define the time
--    bounds for the phase.
--
-- 2. Create lng_booking_type_phase_pools — junction (phase_id, pool_id)
--    that replaces lng_booking_service_pools at finer grain. The
--    old service-level table is RETAINED for now and will be dropped
--    in a follow-up migration once the conflict checker is fully
--    ported off it (ADR-006 §6.6).
--
-- 3. Seed every existing parent config row with one default phase
--    that mirrors today's behaviour: label = service display name,
--    patient_required = true, durations from parent.duration_*,
--    pool_ids = current lng_booking_service_pools for that service.
--    This means nothing observably changes after this migration —
--    every existing booking type is still a single-phase booking.
--    Admins opt into multi-phase by editing the ribbon.
--
-- 4. Backfill of in-flight appointments lives in M2
--    (20260503000002_lng_appointment_phases.sql) — separate file so
--    each migration has one concern.
--
-- ── RLS ────────────────────────────────────────────────────────────
-- Mirrors lng_booking_type_config / lng_booking_resource_pools:
-- read-open to authenticated (the reschedule slot picker and the
-- conflict checker need to read the phase shape), admin-only writes.
--
-- ── Idempotency ────────────────────────────────────────────────────
-- All CREATEs use IF NOT EXISTS. The seeds use ON CONFLICT DO NOTHING
-- against the relevant unique keys. Safe to re-run.
--
-- ── Rollback ───────────────────────────────────────────────────────
-- See bottom of file.

-- ── 1. lng_booking_type_phases ─────────────────────────────────────
-- Per-phase definition. config_id points at either a parent or a
-- child config row in lng_booking_type_config. For a parent, the
-- phase set is the canonical shape of the service. For a child,
-- per-(config_id, phase_index) rows are duration overrides only —
-- the parent's shape is the contract; children retune timings.
--
-- patient_required is the single most important phase fact: it
-- decides whether the chair pool is held during this phase, whether
-- the patient appears in the schedule grid as solid vs hatched,
-- whether the timeline row reads "Patient in chair" vs "Patient may
-- leave", etc. Structural — children cannot override it
-- (enforced at the application layer; see slice spec §3.1).

create table if not exists public.lng_booking_type_phases (
  id                uuid primary key default gen_random_uuid(),

  -- Either a parent or child config row owns this phase.
  config_id         uuid not null
                      references public.lng_booking_type_config(id)
                      on delete cascade,

  -- 1-based ordering within the booking type. Phase 1 is what
  -- happens first when the patient arrives. Sequence holes are
  -- permitted at the DB level (the resolver tolerates them) but
  -- the admin UI keeps them dense.
  phase_index       int not null check (phase_index > 0),

  -- Operator-facing label. "Sign in & assess", "Lab work",
  -- "Fit & deliver". Patient-facing copy reads this verbatim
  -- when rendering the segmented schedule (slice spec §3.7).
  label             text not null check (length(trim(label)) > 0),

  -- Structural: does the patient need to be physically present
  -- during this phase? Active = true → solid block in the schedule
  -- grid + "Patient in chair" timeline subtitle. Passive = false →
  -- hatched block + "Patient may leave, ready ~HH:MM" subtitle.
  patient_required  boolean not null,

  -- Phase duration bounds. Each is null-fallback at resolve time:
  -- a child override row (config_id = a child) can set just one of
  -- these and inherit the others from the parent's same-phase_index
  -- row. Parent rows typically populate all three.
  duration_min      int check (duration_min     is null or duration_min     > 0),
  duration_max      int check (duration_max     is null or duration_max     > 0),
  duration_default  int check (duration_default is null or duration_default > 0),

  -- Free-text admin note shown on the phase editor.
  notes             text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- Range sanity: max ≥ min, default within [min, max] when all set.
  -- Each clause is permissive when its inputs are null so partial
  -- child override rows still validate.
  constraint phase_dur_max_gte_min check (
    duration_min is null or duration_max is null or duration_max >= duration_min
  ),
  constraint phase_dur_default_in_range check (
    duration_default is null
    or (
      (duration_min is null or duration_default >= duration_min)
      and (duration_max is null or duration_default <= duration_max)
    )
  )
);

-- One phase per (config_id, phase_index). A child override row uses
-- the same (config_id_of_child, phase_index) shape as the parent so
-- the resolver can join them by phase_index.
create unique index if not exists lng_booking_type_phases_config_idx
  on public.lng_booking_type_phases (config_id, phase_index);

-- Lookup index for the resolver: given a config row, fetch its
-- phases ordered by phase_index in one scan.
create index if not exists lng_booking_type_phases_config_order_idx
  on public.lng_booking_type_phases (config_id, phase_index);

-- Triggers and policies do not have CREATE ... IF NOT EXISTS in
-- every Postgres version; drop-then-create is the universal
-- idempotency pattern.
drop trigger if exists lng_booking_type_phases_set_updated_at on public.lng_booking_type_phases;
create trigger lng_booking_type_phases_set_updated_at
  before update on public.lng_booking_type_phases
  for each row execute function public.touch_updated_at();

alter table public.lng_booking_type_phases enable row level security;

-- All staff can read — the schedule grid, conflict checker, and
-- reschedule slot picker need the phase shape.
drop policy if exists lng_booking_type_phases_read on public.lng_booking_type_phases;
create policy lng_booking_type_phases_read
  on public.lng_booking_type_phases
  for select to authenticated using (true);

-- Writes admin-only, mirrors lng_booking_type_config policy.
drop policy if exists lng_booking_type_phases_admin_write on public.lng_booking_type_phases;
create policy lng_booking_type_phases_admin_write
  on public.lng_booking_type_phases
  for all to authenticated
  using (public.auth_is_lng_admin() or public.auth_is_super_admin())
  with check (public.auth_is_lng_admin() or public.auth_is_super_admin());

comment on table public.lng_booking_type_phases is
  'Per-phase definition for a booking type. Hung off lng_booking_type_config — a parent row''s phase set defines the service''s shape; a child row''s phase rows are per-phase_index duration overrides only. patient_required is structural and cannot be overridden by children. See ADR-006.';

comment on column public.lng_booking_type_phases.patient_required is
  'Structural flag: is the patient physically present during this phase? Active = true → chair pool held + solid schedule block. Passive = false → patient may leave + hatched schedule block. Children cannot override (enforced at the application layer).';

comment on column public.lng_booking_type_phases.phase_index is
  '1-based ordering within the booking. Phase 1 happens first. The (config_id, phase_index) tuple is unique — child override rows reuse the parent''s phase_index values.';

-- ── 2. lng_booking_type_phase_pools ────────────────────────────────
-- Per-phase pool consumption. A row (phase_id, pool_id) means: while
-- this phase is in flight, it occupies 1 unit of capacity in this
-- pool. Replaces lng_booking_service_pools at finer grain. The old
-- service-level table is retained until M5/M6 migrate the conflict
-- checker fully off it.
--
-- Pool consumption is NOT inherited from parent → child config in
-- v1: each phase row owns its own pool list directly. (Child override
-- rows in v1 only retune durations — they don't redefine pool
-- consumption. AQ in slice spec.)

create table if not exists public.lng_booking_type_phase_pools (
  phase_id    uuid not null
                references public.lng_booking_type_phases(id)
                on delete cascade,
  pool_id     text not null
                references public.lng_booking_resource_pools(id)
                on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (phase_id, pool_id)
);

-- Index for the conflict checker: given a pool, find every phase
-- that consumes it. Symmetric with lng_booking_service_pools_pool_idx.
create index if not exists lng_booking_type_phase_pools_pool_idx
  on public.lng_booking_type_phase_pools (pool_id);

alter table public.lng_booking_type_phase_pools enable row level security;

drop policy if exists lng_booking_type_phase_pools_read on public.lng_booking_type_phase_pools;
create policy lng_booking_type_phase_pools_read
  on public.lng_booking_type_phase_pools
  for select to authenticated using (true);

drop policy if exists lng_booking_type_phase_pools_admin_write on public.lng_booking_type_phase_pools;
create policy lng_booking_type_phase_pools_admin_write
  on public.lng_booking_type_phase_pools
  for all to authenticated
  using (public.auth_is_lng_admin() or public.auth_is_super_admin())
  with check (public.auth_is_lng_admin() or public.auth_is_super_admin());

comment on table public.lng_booking_type_phase_pools is
  'Per-phase pool consumption. Replaces lng_booking_service_pools at finer grain — instead of "service X consumes these pools for the whole booking", we say "phase Y of service X consumes these pools while phase Y is in flight". The conflict checker (M5) walks this junction.';

-- ── 3. Seed: default 1-phase per existing parent config ────────────
-- Every parent config row gets one phase that mirrors today's
-- behaviour. After this seed, the resolver can return phase data
-- for every booking type without anything observably changing.
--
-- Label is the service's display name (Title Case) so the admin
-- ribbon reads naturally on day one. Admin can rename later.

insert into public.lng_booking_type_phases (
  config_id, phase_index, label, patient_required,
  duration_min, duration_max, duration_default
)
select
  c.id,
  1,
  case c.service_type
    when 'denture_repair'         then 'Denture repair'
    when 'click_in_veneers'       then 'Click-in veneers'
    when 'same_day_appliance'     then 'Same-day appliance'
    when 'impression_appointment' then 'Impression appointment'
    when 'other'                  then 'Booking'
  end,
  true,
  c.duration_min,
  c.duration_max,
  c.duration_default
from public.lng_booking_type_config c
where c.repair_variant is null
  and c.product_key   is null
  and c.arch          is null
on conflict (config_id, phase_index) do nothing;

-- ── 4. Seed: phase pools from existing service-level pool list ─────
-- For every freshly-seeded phase (the parent's phase 1), copy the
-- service-level pool consumption rows into the phase-level junction.
-- After this seed, every parent config has phase-level pool data
-- equivalent to its current service-level pool data.

insert into public.lng_booking_type_phase_pools (phase_id, pool_id)
select p.id, sp.pool_id
  from public.lng_booking_type_phases p
  join public.lng_booking_type_config c on c.id = p.config_id
  join public.lng_booking_service_pools sp on sp.service_type = c.service_type
 where p.phase_index = 1
   and c.repair_variant is null
   and c.product_key   is null
   and c.arch          is null
on conflict (phase_id, pool_id) do nothing;

-- ── Rollback ───────────────────────────────────────────────────────
-- Run in reverse order against Supabase Studio SQL editor if needed.
-- All CASCADEs handle dependent objects automatically.
--
-- drop policy if exists lng_booking_type_phase_pools_admin_write on public.lng_booking_type_phase_pools;
-- drop policy if exists lng_booking_type_phase_pools_read         on public.lng_booking_type_phase_pools;
-- drop index  if exists public.lng_booking_type_phase_pools_pool_idx;
-- drop table  if exists public.lng_booking_type_phase_pools;
--
-- drop policy  if exists lng_booking_type_phases_admin_write on public.lng_booking_type_phases;
-- drop policy  if exists lng_booking_type_phases_read         on public.lng_booking_type_phases;
-- drop trigger if exists lng_booking_type_phases_set_updated_at on public.lng_booking_type_phases;
-- drop index   if exists public.lng_booking_type_phases_config_order_idx;
-- drop index   if exists public.lng_booking_type_phases_config_idx;
-- drop table   if exists public.lng_booking_type_phases;
