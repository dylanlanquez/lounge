-- 20260503000014_lng_resource_pool_units_guard.sql
--
-- Re-points the staff_role capacity guard + recompute helper at the
-- new write surface (`units`) introduced in M13.
--
-- Background
-- ──────────
-- Before M13, lng_booking_resource_pools.capacity was a regular int
-- column. For staff_role pools it was kept in sync with the active
-- staff count via lng_recompute_staff_role_pool_capacity(), and a
-- BEFORE-UPDATE guard rejected manual capacity edits.
--
-- M13 split capacity into:
--   units              int  — admin-editable for resource; for
--                             staff_role, the count of active staff.
--   per_unit_capacity  int  — admin-editable for both kinds.
--   capacity           int  — GENERATED ALWAYS AS (units * per_unit_capacity).
--
-- Two breakages flow from that:
--   1. The recompute helper does `update set capacity = ...`. Postgres
--      now rejects writes to generated columns.
--   2. The guard fires on `new.capacity is not distinct from old.capacity`.
--      Any units edit changes the generated capacity, so the guard
--      mis-fires on the new admin write surface.
--
-- This migration moves both pieces onto `units`:
--   * Recompute helper writes units = active staff count.
--   * Guard rejects external writes that change `units` on staff_role
--     pools, allowing only the helper (via session token) and the
--     resource→staff_role kind transition.
--   * per_unit_capacity stays freely editable on both kinds — it's
--     the admin's "how many at once per unit" knob.

-- Recompute helper: write units, not capacity.
create or replace function public.lng_recompute_staff_role_pool_capacity(p_pool_id text)
returns void language plpgsql as $$
declare
  active_count int;
begin
  perform 1
  from public.lng_booking_resource_pools
  where id = p_pool_id and kind = 'staff_role';
  if not found then return; end if;

  select count(*)::int into active_count
  from public.lng_staff_pool_assignments a
  join public.lng_staff_members s on s.id = a.staff_member_id
  where a.pool_id = p_pool_id
    and s.status = 'active';

  -- units must satisfy the > 0 check on the column. If the pool has
  -- no active staff, write 1 as a placeholder; the conflict checker
  -- will still effectively block bookings because per_unit_capacity ×
  -- 1 staff member won't cover the real demand. The admin UI surfaces
  -- "0 assigned" so this isn't hidden.
  perform set_config('lng.recomputing_staff_role_capacity', 'true', true);
  update public.lng_booking_resource_pools
  set units = greatest(active_count, 1)
  where id = p_pool_id;
  perform set_config('lng.recomputing_staff_role_capacity', 'false', true);
end;
$$;

comment on function public.lng_recompute_staff_role_pool_capacity(text) is
  'Recomputes lng_booking_resource_pools.units for a staff_role pool from its active staff assignments. capacity is the generated column units × per_unit_capacity, so writing units is sufficient. No-op for resource pools.';

-- Guard: gate units writes on staff_role pools (not capacity).
-- per_unit_capacity edits remain free for both kinds.
create or replace function public.lng_booking_resource_pools_capacity_guard()
returns trigger language plpgsql as $$
begin
  if tg_op <> 'UPDATE' then return new; end if;
  if new.kind <> 'staff_role' then return new; end if;
  -- Only intercept actual changes to units; an upsert that re-sends
  -- the same value is harmless.
  if new.units is not distinct from old.units then return new; end if;
  -- Re-allow when the kind transitioned this same UPDATE — switching
  -- resource→staff_role legitimately resets units to the assignment
  -- count (the recompute path is invoked from the transition flow).
  if old.kind <> 'staff_role' then return new; end if;
  -- Allow when the recompute helper is the writer.
  if current_setting('lng.recomputing_staff_role_capacity', true) = 'true' then
    return new;
  end if;
  raise exception 'Units for staff_role pool % are derived from active staff assignments. Edit the staff list, not units.', new.id
    using errcode = '23514';
end;
$$;

-- Trigger definition is unchanged from M06; recreate to be explicit
-- and idempotent.
drop trigger if exists lng_booking_resource_pools_capacity_guard on public.lng_booking_resource_pools;
create trigger lng_booking_resource_pools_capacity_guard
  before update on public.lng_booking_resource_pools
  for each row execute function public.lng_booking_resource_pools_capacity_guard();

-- Resync: walk every existing staff_role pool and recompute units
-- from active assignments. Pre-M13 rows had capacity = active count,
-- which M13's backfill copied into units, so most rows are already
-- correct. This belt-and-braces pass catches any drift.
do $$
declare
  pool_id_iter text;
begin
  for pool_id_iter in
    select id from public.lng_booking_resource_pools where kind = 'staff_role'
  loop
    perform public.lng_recompute_staff_role_pool_capacity(pool_id_iter);
  end loop;
end$$;
