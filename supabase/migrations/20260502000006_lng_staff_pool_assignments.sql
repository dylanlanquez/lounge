-- 20260502000006_lng_staff_pool_assignments.sql
--
-- Staff-driven capacity for staff-role pools.
--
-- Until now, lng_booking_resource_pools.capacity was always an
-- explicit number the admin typed in — true for both physical
-- resources (chairs, lab bench) and abstract staff roles (impression
-- takers, denture techs). For staff roles that's the wrong source of
-- truth: real capacity is the count of actual staff members on the
-- team in that role, and it should drop automatically when a staff
-- member leaves or is deactivated.
--
-- This migration introduces lng_staff_pool_assignments — a many-to-
-- many between lng_staff_members and the staff_role-flavoured rows of
-- lng_booking_resource_pools. The set of assignments DRIVES the pool's
-- capacity through a trigger: capacity = count(distinct active staff
-- assigned). Resource-flavoured pools are untouched.
--
-- Why drive capacity through a trigger rather than expose a derived
-- view: the existing booking conflict checker (lng_booking_check_conflicts)
-- reads capacity directly from lng_booking_resource_pools.capacity. By
-- writing the derived value back to the same column, the engine works
-- without any change. This is a deliberate "single column, computed
-- from one or many sources depending on kind" pattern.
--
-- Edge cases handled:
--   • Adding/removing a staff↔pool assignment recomputes that pool.
--   • Flipping a staff member's status active⇄inactive recomputes
--     every pool they're assigned to.
--   • Deleting a staff member cascades the assignments away, which
--     re-triggers the recompute.
--   • Deleting a pool cascades the assignments away (nothing left to
--     recompute).
--   • Direct UPDATE of capacity on a staff_role pool is BLOCKED — the
--     admin can't smuggle a number through the row editor; assignments
--     are the only path. Resource-pool capacity edits are unaffected.
--
-- Rollback:
--   drop trigger if exists lng_staff_members_recompute_pool_caps on public.lng_staff_members;
--   drop trigger if exists lng_staff_pool_assignments_recompute on public.lng_staff_pool_assignments;
--   drop trigger if exists lng_booking_resource_pools_capacity_guard on public.lng_booking_resource_pools;
--   drop function if exists public.lng_recompute_staff_role_pool_capacity(text);
--   drop function if exists public.lng_staff_pool_assignments_after_change();
--   drop function if exists public.lng_staff_members_after_status_change();
--   drop function if exists public.lng_booking_resource_pools_capacity_guard();
--   drop table if exists public.lng_staff_pool_assignments;

-- ── 0. Relax capacity check on resource pools for staff_role rows ─
--
-- The original constraint required capacity > 0. That was right when
-- every pool was admin-set, but a staff_role pool with no staff
-- assigned is legitimately at 0 (and the conflict checker correctly
-- blocks all bookings consuming it until the admin assigns staff).
-- Keep the > 0 floor for resource pools — a "0 chairs" pool would
-- silently block everything with no obvious "no chairs configured"
-- empty state. Staff_role gets >= 0 so the recompute trigger can
-- legitimately land on 0 when nobody is assigned.

alter table public.lng_booking_resource_pools
  drop constraint if exists lng_booking_resource_pools_capacity_check;

alter table public.lng_booking_resource_pools
  add constraint lng_booking_resource_pools_capacity_check
  check (
    (kind = 'resource'   and capacity > 0)
    or (kind = 'staff_role' and capacity >= 0)
  );

-- ── 1. lng_staff_pool_assignments ─────────────────────────────────

create table if not exists public.lng_staff_pool_assignments (
  staff_member_id  uuid not null references public.lng_staff_members(id) on delete cascade,
  pool_id          text not null references public.lng_booking_resource_pools(id) on delete cascade,
  assigned_at      timestamptz not null default now(),
  assigned_by      uuid references public.accounts(id) on delete set null,
  primary key (staff_member_id, pool_id)
);

create index if not exists lng_staff_pool_assignments_pool_idx
  on public.lng_staff_pool_assignments (pool_id);
create index if not exists lng_staff_pool_assignments_staff_idx
  on public.lng_staff_pool_assignments (staff_member_id);

alter table public.lng_staff_pool_assignments enable row level security;

drop policy if exists lng_staff_pool_assignments_read on public.lng_staff_pool_assignments;
create policy lng_staff_pool_assignments_read
  on public.lng_staff_pool_assignments
  for select to authenticated using (true);

drop policy if exists lng_staff_pool_assignments_write on public.lng_staff_pool_assignments;
create policy lng_staff_pool_assignments_write
  on public.lng_staff_pool_assignments
  for all to authenticated
  using (public.auth_is_lng_admin() or public.auth_is_super_admin())
  with check (public.auth_is_lng_admin() or public.auth_is_super_admin());

comment on table public.lng_staff_pool_assignments is
  'Maps staff members to staff-role resource pools. Capacity of the pool is recomputed via trigger as count(active assignments). Resource-flavoured pools never appear here — assignments must reference a pool with kind=staff_role (enforced in the trigger; the FK alone can''t express that).';

-- Soft-enforce kind=staff_role at insert/update time. We can't put a
-- check constraint across tables, but a trigger refusing to insert
-- against a kind=resource pool gives a loud, immediate failure rather
-- than silent capacity weirdness.
create or replace function public.lng_staff_pool_assignments_validate_kind()
returns trigger language plpgsql as $$
declare
  pool_kind text;
begin
  select kind into pool_kind
  from public.lng_booking_resource_pools
  where id = new.pool_id;
  if pool_kind is distinct from 'staff_role' then
    raise exception 'Pool % is kind=%; staff can only be assigned to staff_role pools.', new.pool_id, coalesce(pool_kind, 'unknown')
      using errcode = '23514'; -- check_violation
  end if;
  return new;
end;
$$;

drop trigger if exists lng_staff_pool_assignments_validate_kind on public.lng_staff_pool_assignments;
create trigger lng_staff_pool_assignments_validate_kind
  before insert or update on public.lng_staff_pool_assignments
  for each row execute function public.lng_staff_pool_assignments_validate_kind();

-- ── 2. Recompute helper ───────────────────────────────────────────
--
-- Given a pool id, count the active staff members assigned and write
-- the result to lng_booking_resource_pools.capacity. No-ops for non-
-- staff_role pools so the function is safe to call indiscriminately.

create or replace function public.lng_recompute_staff_role_pool_capacity(p_pool_id text)
returns void language plpgsql as $$
declare
  active_count int;
begin
  -- Skip if the pool isn't staff-role-flavoured. Defence-in-depth so
  -- a stray call from somewhere unexpected can't clobber an admin-
  -- typed capacity on a resource pool.
  perform 1
  from public.lng_booking_resource_pools
  where id = p_pool_id and kind = 'staff_role';
  if not found then return; end if;

  select count(*)::int into active_count
  from public.lng_staff_pool_assignments a
  join public.lng_staff_members s on s.id = a.staff_member_id
  where a.pool_id = p_pool_id
    and s.status = 'active';

  update public.lng_booking_resource_pools
  set capacity = active_count
  where id = p_pool_id;
end;
$$;

comment on function public.lng_recompute_staff_role_pool_capacity(text) is
  'Recomputes lng_booking_resource_pools.capacity for a staff_role pool from its active staff assignments. No-op for resource pools.';

-- ── 3. Trigger on lng_staff_pool_assignments ──────────────────────

create or replace function public.lng_staff_pool_assignments_after_change()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    perform public.lng_recompute_staff_role_pool_capacity(old.pool_id);
    return old;
  end if;
  perform public.lng_recompute_staff_role_pool_capacity(new.pool_id);
  -- If pool_id changed (vanishingly rare; admin renamed via UI), also
  -- recompute the old one so the source pool drops by 1.
  if tg_op = 'UPDATE' and new.pool_id is distinct from old.pool_id then
    perform public.lng_recompute_staff_role_pool_capacity(old.pool_id);
  end if;
  return new;
end;
$$;

drop trigger if exists lng_staff_pool_assignments_recompute on public.lng_staff_pool_assignments;
create trigger lng_staff_pool_assignments_recompute
  after insert or update or delete on public.lng_staff_pool_assignments
  for each row execute function public.lng_staff_pool_assignments_after_change();

-- ── 4. Trigger on lng_staff_members.status changes ────────────────
--
-- A staff member flipping active⇄inactive must recompute every pool
-- they're assigned to. We don't fire on every UPDATE — only when the
-- status column actually changed, to avoid unnecessary work when an
-- admin edits flags or rotates timestamps.

create or replace function public.lng_staff_members_after_status_change()
returns trigger language plpgsql as $$
declare
  pool_id_iter text;
begin
  if old.status is not distinct from new.status then
    return new;
  end if;
  for pool_id_iter in
    select pool_id from public.lng_staff_pool_assignments where staff_member_id = new.id
  loop
    perform public.lng_recompute_staff_role_pool_capacity(pool_id_iter);
  end loop;
  return new;
end;
$$;

drop trigger if exists lng_staff_members_recompute_pool_caps on public.lng_staff_members;
create trigger lng_staff_members_recompute_pool_caps
  after update on public.lng_staff_members
  for each row execute function public.lng_staff_members_after_status_change();

-- ── 5. Block direct capacity edits on staff_role pools ────────────
--
-- The pool editor lets the admin type a capacity. For staff_role
-- pools that's a footgun — they'd type "5", the trigger would never
-- recompute (no assignment changed), and the engine would silently
-- enforce the wrong cap until the next assignment edit. Guard at the
-- table level so the only way to change a staff_role pool's capacity
-- is to add/remove an assignment, OR to flip kind back to 'resource'.
--
-- The guard ALLOWS recompute writes from the helper (which sets a
-- session-level token before its update). Outside that token the
-- write is rejected.

create or replace function public.lng_booking_resource_pools_capacity_guard()
returns trigger language plpgsql as $$
begin
  -- Only worry about UPDATEs that change capacity on a staff_role row.
  if tg_op <> 'UPDATE' then return new; end if;
  if new.kind <> 'staff_role' then return new; end if;
  if new.capacity is not distinct from old.capacity then return new; end if;
  -- Re-allow if the row's kind transitioned this same UPDATE — switching
  -- from resource→staff_role legitimately resets capacity to the
  -- assignment count (the recompute helper will be invoked from the
  -- transition path the UI takes).
  if old.kind <> 'staff_role' then return new; end if;
  -- Allow when the recompute helper is the writer.
  if current_setting('lng.recomputing_staff_role_capacity', true) = 'true' then
    return new;
  end if;
  raise exception 'Capacity for staff_role pool % is derived from active staff assignments. Edit the staff list, not the capacity.', new.id
    using errcode = '23514';
end;
$$;

drop trigger if exists lng_booking_resource_pools_capacity_guard on public.lng_booking_resource_pools;
create trigger lng_booking_resource_pools_capacity_guard
  before update on public.lng_booking_resource_pools
  for each row execute function public.lng_booking_resource_pools_capacity_guard();

-- Re-issue the recompute helper so it sets the session token while
-- writing; the guard then waves the write through.
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

  perform set_config('lng.recomputing_staff_role_capacity', 'true', true);
  update public.lng_booking_resource_pools
  set capacity = active_count
  where id = p_pool_id;
  perform set_config('lng.recomputing_staff_role_capacity', 'false', true);
end;
$$;

-- ── 6. RPC: atomic replace-all assignments for a pool ─────────────
--
-- The admin "Manage staff" modal lets the user check/uncheck staff in
-- one screen and Save. Doing N inserts + M deletes from the client
-- would race against concurrent edits and produce half-applied state
-- on a network glitch. This RPC takes the desired final set and
-- diffs it against current rows in a single transaction.

create or replace function public.lng_set_staff_pool_assignments(
  p_pool_id text,
  p_staff_ids uuid[]
)
returns void language plpgsql security invoker as $$
declare
  actor_id uuid;
begin
  if not (public.auth_is_lng_admin() or public.auth_is_super_admin()) then
    raise exception 'Admin access required';
  end if;

  -- Pool must exist and be staff_role.
  perform 1
  from public.lng_booking_resource_pools
  where id = p_pool_id and kind = 'staff_role';
  if not found then
    raise exception 'Pool % does not exist or is not a staff_role pool.', p_pool_id;
  end if;

  actor_id := public.auth_account_id();

  -- Delete any current assignment that's not in the new set.
  delete from public.lng_staff_pool_assignments
  where pool_id = p_pool_id
    and staff_member_id <> all(coalesce(p_staff_ids, '{}'::uuid[]));

  -- Insert any in the new set that aren't already there.
  insert into public.lng_staff_pool_assignments (pool_id, staff_member_id, assigned_by)
  select p_pool_id, sid, actor_id
  from unnest(coalesce(p_staff_ids, '{}'::uuid[])) as t(sid)
  on conflict (staff_member_id, pool_id) do nothing;
end;
$$;

comment on function public.lng_set_staff_pool_assignments(text, uuid[]) is
  'Atomically replaces the staff↔pool assignment set for a staff_role pool. Diffs against current rows and inserts/deletes the difference; the recompute trigger fires per row.';
