-- 20260518000003_lng_overlap_guard_lock.sql
--
-- Final-mile race-safety on top of the lng_appointments_overlap_guard
-- (20260518000002). Without this, two transactions inserting
-- appointments at the same location AT THE SAME TIME can both pass
-- their guard checks: the default read-committed isolation level
-- means each transaction's conflict check only sees rows the OTHER
-- transaction has already committed. If they're truly simultaneous,
-- neither sees the other's pending row and both succeed.
--
-- Acquiring a transaction-scoped advisory lock keyed by the
-- appointment's location_id at the top of the guard serialises
-- concurrent writes to the same location. The lock is held until
-- the transaction commits (or rolls back), so:
--
--   T1: lock(loc) → check → ok → commit → release
--   T2: lock(loc) blocks until T1 releases → check sees T1 → raise
--
-- Lock is per-location, not global, so two locations can still
-- write concurrently. pg_advisory_xact_lock auto-releases at txn
-- end, so a raised exception (or any other failure) doesn't leave
-- the lock dangling.
--
-- Why hashtext(location_id::text) — pg_advisory_xact_lock takes a
-- bigint. hashtext returns int4, which Postgres widens to bigint
-- without collision concerns for our handful of locations.

create or replace function public.lng_appointments_overlap_guard_trg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  conflict_count int;
  conflicts_json jsonb;
  is_walkin      boolean;
  is_calendly    boolean;
begin
  -- Only active rows can collide. Terminal statuses skip the check.
  if new.status not in ('booked', 'arrived', 'in_progress') then
    return new;
  end if;

  -- A row without a service_type has no phases (the materialiser
  -- short-circuits) and therefore nothing to check. Walk-in markers
  -- are the main example today.
  if new.service_type is null then
    return new;
  end if;

  -- Serialise concurrent writes to the same location. Held to the
  -- end of the current transaction; auto-released on commit OR
  -- rollback, so a raised OVERLAP doesn't leak the lock.
  perform pg_advisory_xact_lock(hashtext(new.location_id::text)::bigint);

  select count(*) filter (where conflict_kind is not null),
         coalesce(
           jsonb_agg(
             jsonb_build_object(
               'conflict_kind',     conflict_kind,
               'pool_id',           pool_id,
               'pool_capacity',     pool_capacity,
               'current_count',     current_count,
               'phase_index',       phase_index,
               'phase_label',       phase_label,
               'conflict_start_at', conflict_start_at,
               'conflict_end_at',   conflict_end_at
             )
           ) filter (where conflict_kind is not null),
           '[]'::jsonb
         )
    into conflict_count, conflicts_json
    from public.lng_booking_check_conflict(
      new.location_id,
      new.service_type,
      new.start_at,
      new.end_at,
      new.id,
      new.repair_variant,
      new.product_key,
      new.arch
    );

  if conflict_count = 0 then
    return new;
  end if;

  is_walkin   := new.walk_in_id is not null;
  is_calendly := new.source = 'calendly';

  if is_walkin or is_calendly then
    insert into public.lng_system_failures (severity, source, message, context)
    values (
      'warning',
      'lng_appointments_overlap_guard',
      case
        when is_walkin   then 'Walk-in saved despite overlap with an existing booking'
        when is_calendly then 'Calendly booking saved despite overlap with an existing booking'
      end,
      jsonb_build_object(
        'appointment_id', new.id,
        'patient_id',     new.patient_id,
        'service_type',   new.service_type,
        'start_at',       new.start_at,
        'end_at',         new.end_at,
        'source',         new.source,
        'walk_in_id',     new.walk_in_id,
        'conflicts',      conflicts_json
      )
    );
    return new;
  end if;

  raise exception 'OVERLAP: appointment % overlaps an existing booking. Conflicts: %', new.id, conflicts_json
    using errcode = '23P01';
end;
$$;

comment on function public.lng_appointments_overlap_guard_trg() is
  'AFTER INSERT/UPDATE constraint trigger on lng_appointments. Acquires a per-location pg_advisory_xact_lock to serialise concurrent writes, then re-runs lng_booking_check_conflict against the just-materialised phases. Walk-in / Calendly bypasses log to lng_system_failures with severity warning instead of raising. Everything else raises with SQLSTATE 23P01. See migrations 20260518000002 + 20260518000003.';

-- ── Rollback ──────────────────────────────────────────────────────
-- Re-apply 20260518000002 to restore the lock-free version.
