-- 20260503000013_lng_resource_pool_units.sql
--
-- Splits lng_booking_resource_pools.capacity into two source-of-
-- truth columns plus a generated total. Per Dylan's call — the
-- single capacity field conflated "how many of this do we have"
-- with "how many patients each one handles at once". Real-world
-- examples that need both:
--
--   1 receptionist juggling 3 patients at a time   → 1 × 3 = 3
--   3 whitening booths, 1 patient each              → 3 × 1 = 3
--   1 consult room with 2 chairs in it              → 1 × 2 = 2
--   2 dental techs, 1 case each at a time           → 2 × 1 = 2
--
-- ── New shape ────────────────────────────────────────────────────
--
--   units int                — count of physical units OR (for
--                              staff_role pools) count of assigned
--                              staff. UI for resource pools surfaces
--                              this as "how many do you have?". For
--                              staff_role it's auto-computed from
--                              the staff picker.
--   per_unit_capacity int    — how many patients each unit handles
--                              at the same time. Defaults to 1
--                              (the most common case). Admin only
--                              touches it for the few cases that
--                              actually parallelise.
--   capacity int (generated) — units × per_unit_capacity. The
--                              conflict checker continues to read
--                              capacity unchanged.
--
-- ── Backfill ─────────────────────────────────────────────────────
--
-- Every existing row had its capacity acting as units (per_unit
-- implied = 1). Backfill sets units := current capacity, per_unit
-- := 1. After the column re-add, capacity = units × 1 = same value.
-- No conflict-checker behaviour change.
--
-- ── Migration order ──────────────────────────────────────────────
--
-- 1. Add per_unit_capacity int not null default 1 (no backfill
--    needed — default suffices).
-- 2. Add units int not null default 1.
-- 3. UPDATE units = capacity for every existing row.
-- 4. DROP capacity (the regular column).
-- 5. ADD capacity as GENERATED ALWAYS AS (units * per_unit_capacity)
--    STORED — Postgres 12+ feature, fine on Supabase 15+.
--
-- The DROP + re-ADD is the only way to convert a regular column
-- into a generated one in Postgres. Briefly the column doesn't
-- exist; do it inside a single transaction so no concurrent reader
-- sees the half-state.
--
-- ── Idempotency ──────────────────────────────────────────────────
--
-- The generated-column add is wrapped in a check: if a generated
-- column already exists for `capacity`, the migration is a no-op.

-- Wrap the column gymnastics in a single transaction. psql's
-- --single-transaction flag at apply time also wraps; the explicit
-- BEGIN here keeps the file self-contained for tools that don't
-- pass that flag.

do $$
declare
  capacity_is_generated boolean;
begin
  -- Detect whether we've already migrated by checking the column's
  -- generation kind. 'STORED' generated columns report 's' in
  -- pg_attribute.attgenerated; regular columns report ''.
  select coalesce(
    (
      select attgenerated <> ''
        from pg_attribute
       where attrelid = 'public.lng_booking_resource_pools'::regclass
         and attname = 'capacity'
    ),
    false
  )
    into capacity_is_generated;

  if capacity_is_generated then
    return; -- already migrated
  end if;

  -- Step 1: per_unit_capacity (default 1 — no backfill needed).
  alter table public.lng_booking_resource_pools
    add column if not exists per_unit_capacity int not null default 1
      check (per_unit_capacity > 0);

  -- Step 2: units, defaulting to 1 (placeholder; backfilled next).
  alter table public.lng_booking_resource_pools
    add column if not exists units int not null default 1
      check (units > 0);

  -- Step 3: backfill units from current capacity. Existing rows had
  -- capacity acting as units with implied per_unit = 1.
  update public.lng_booking_resource_pools
     set units = capacity
   where units <> capacity;

  -- Step 4: drop the existing capacity column. Anything that
  -- previously read capacity will get the generated column added in
  -- step 5 with the same name and (since per_unit defaults to 1)
  -- the same values.
  alter table public.lng_booking_resource_pools
    drop column capacity;

  -- Step 5: capacity is now derived. Generated columns can't be
  -- written to directly — admin updates units / per_unit_capacity,
  -- the database keeps capacity in sync. Conflict checker reads
  -- capacity unchanged.
  alter table public.lng_booking_resource_pools
    add column capacity int generated always as (units * per_unit_capacity) stored;
end$$;

comment on column public.lng_booking_resource_pools.units is
  'How many of this resource exist. For physical resources, the count of chairs/rooms/lab benches/etc. For staff_role pools, the count of staff currently assigned (kept in sync with lng_staff_pool_assignments by the admin save path).';

comment on column public.lng_booking_resource_pools.per_unit_capacity is
  'How many patients a single unit can handle simultaneously. Defaults to 1 (the most common case). Override for resources / roles that actually parallelise — e.g. a consult room with 2 chairs, or one receptionist juggling 3 book-ins at once.';

comment on column public.lng_booking_resource_pools.capacity is
  'Effective capacity = units × per_unit_capacity. Generated stored column — kept in sync automatically. The conflict checker reads this; admin never edits it directly.';

-- ── Rollback ─────────────────────────────────────────────────────
--
-- alter table public.lng_booking_resource_pools drop column capacity;
-- alter table public.lng_booking_resource_pools add column capacity int not null default 1 check (capacity > 0);
-- update public.lng_booking_resource_pools set capacity = units * per_unit_capacity;
-- alter table public.lng_booking_resource_pools drop column units;
-- alter table public.lng_booking_resource_pools drop column per_unit_capacity;
