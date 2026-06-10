-- 20260610000001_lng_overlap_guard_footprint_change.sql
--
-- ── The bug ───────────────────────────────────────────────────────
-- Starting an already-booked appointment failed with:
--
--   OVERLAP: appointment <id> overlaps an existing booking.
--   Conflicts: [{"pool_id":"consult-room","phase_index":2,
--   "phase_label":"Impressions","conflict_kind":"pool_at_capacity",
--   "current_count":1,"pool_capacity":1, ...}]
--
-- The patient was in the chair, consent signed, ready to go — and the
-- system refused to start the appointment.
--
-- ── Root cause ────────────────────────────────────────────────────
-- Both overlap guards are CONSTRAINT TRIGGERs whose column list
-- includes `status`, so they fire on every status transition:
--
--   * zz_appointments_overlap_guard      -> lng_appointments_overlap_guard_trg
--       (in-person per-pool capacity; consult-room is one such pool)
--   * zz_virtual_clinician_overlap_guard -> lng_virtual_clinician_guard_trg
--       (virtual impression clinician double-book)
--
-- markAppointmentArrived() flips booked -> arrived. markVirtualMeetingJoined()
-- flips booked -> joined. Both are pure status writes — start_at, end_at,
-- service_type, etc. are untouched. The guard re-runs its conflict check
-- (which excludes the row's OWN id) and re-discovers a PRE-EXISTING
-- overlap with a DIFFERENT booking — current_count = 1 in the report is
-- that other appointment. It then raises 23P01 and the transition is
-- rejected.
--
-- A status flip among active states (booked / arrived / joined) cannot
-- create a new overlap: the row was ALREADY consuming its pool while
-- booked, and was already counted by every other surface. Re-checking
-- on a status-only write can only re-discover a conflict the write did
-- not cause, and then block a legitimate operational transition at the
-- worst possible moment (the patient is present and the slot was
-- validated when the booking was made).
--
-- ── The correct rule ──────────────────────────────────────────────
-- A double-booking guard must validate only when an appointment's slot
-- footprint is being ESTABLISHED or CHANGED:
--
--   * INSERT                         — a new active row may overlap.
--   * UPDATE of a footprint column   — reschedule (start_at/end_at), or
--                                      a scope change that alters which
--                                      pools/phases/clinician apply
--                                      (service_type, repair_variant,
--                                      product_key, arch, location_id;
--                                      clinician_staff_member_id for the
--                                      virtual guard).
--
-- A status-only UPDATE (booked -> arrived, booked -> joined, and the
-- terminal -> active reversal that 20260526000001 special-cased) leaves
-- the footprint unchanged and is therefore skipped. This generalises and
-- SUBSUMES 20260526000001_lng_overlap_guard_skip_reversal: a reversal
-- with no reschedule has an unchanged footprint and is skipped exactly as
-- before; a reversal that ALSO moves the slot (footprint changed) is now
-- correctly re-validated against its new time, which the old narrow
-- old.status-in-(terminal) skip wrongly let through.
--
-- All genuine double-booking prevention is preserved: every create path
-- (INSERT) and every reschedule / scope edit (footprint UPDATE) still
-- runs the full phase-aware conflict check under the per-location /
-- per-clinician advisory lock. Walk-in (walk_in_id) and Calendly
-- (source = calendly) keep their log-and-save bypass on the general
-- guard. Nothing about the checker, the lock, or the bypass changes —
-- only WHEN the check runs.
--
-- ── Why both guards in one migration ──────────────────────────────
-- They are the same defect in two places. Fixing only the in-person
-- guard would leave markVirtualMeetingJoined() able to hit the identical
-- block the moment a clinician has a pre-existing overlapping virtual
-- booking. Correct once, everywhere.
--
-- Idempotent: CREATE OR REPLACE on both functions. No trigger or
-- signature changes, so the existing constraint triggers keep pointing
-- at the updated bodies.
--
-- Apply order (per CLAUDE.md): shadow first (verify), then Meridian.

-- ── 1. In-person per-pool overlap guard ───────────────────────────
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
  -- joined is the virtual analogue of arrived — both consume pools.
  if new.status not in ('booked', 'arrived', 'joined') then
    return new;
  end if;

  -- A row without a service_type has no phases (the materialiser
  -- short-circuits) and therefore nothing to check. Walk-in markers
  -- are the main example today.
  if new.service_type is null then
    return new;
  end if;

  -- Footprint-change gate. Only validate when the appointment's slot
  -- footprint is being established (INSERT) or changed (a footprint
  -- column actually differs from OLD). A status-only UPDATE — Start
  -- appointment (booked -> arrived), virtual join (booked -> joined),
  -- or a terminal -> active reversal with no reschedule — leaves the
  -- footprint untouched and cannot introduce a new overlap, so it is
  -- skipped. This subsumes 20260526000001's narrower reversal skip.
  if tg_op = 'UPDATE'
     and new.start_at       is not distinct from old.start_at
     and new.end_at         is not distinct from old.end_at
     and new.service_type   is not distinct from old.service_type
     and new.repair_variant is not distinct from old.repair_variant
     and new.product_key    is not distinct from old.product_key
     and new.arch           is not distinct from old.arch
     and new.location_id    is not distinct from old.location_id
  then
    return new;
  end if;

  -- Serialise concurrent writes to the same location. Held to the end
  -- of the current transaction; auto-released on commit OR rollback.
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
  'AFTER INSERT/UPDATE constraint trigger on lng_appointments. Validates only when the slot footprint is established (INSERT) or changed (UPDATE of start_at/end_at/service_type/repair_variant/product_key/arch/location_id) — status-only transitions (Start appointment, virtual join, terminal->active reversal) are skipped because they cannot create a new overlap. Footprint-change gate added 20260610000001; subsumes the 20260526000001 reversal skip. When it does check: acquires a per-location pg_advisory_xact_lock then re-runs lng_booking_check_conflict (active set = booked/arrived/joined). Walk-in / Calendly bypasses log to lng_system_failures; everything else raises SQLSTATE 23P01.';

-- ── 2. Virtual impression clinician double-book guard ─────────────
create or replace function public.lng_virtual_clinician_guard_trg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_overlap int;
begin
  if new.service_type is distinct from 'virtual_impression_appointment' then return new; end if;
  if new.status not in ('booked', 'arrived', 'joined') then return new; end if;
  if new.clinician_staff_member_id is null then return new; end if;

  -- Footprint-change gate (same principle as the in-person guard). The
  -- virtual footprint is the clinician + the time window. A status-only
  -- UPDATE — virtual join (booked -> joined), arrival, or a terminal ->
  -- active reversal with no reschedule and no clinician change — cannot
  -- create a new clinician double-book, so it is skipped. Assigning or
  -- changing the clinician (clinician_staff_member_id distinct from OLD)
  -- or moving the slot still validates. This subsumes the previous
  -- old.status-in-(terminal) reversal skip.
  if tg_op = 'UPDATE'
     and new.start_at                  is not distinct from old.start_at
     and new.end_at                    is not distinct from old.end_at
     and new.clinician_staff_member_id is not distinct from old.clinician_staff_member_id
     and new.service_type              is not distinct from old.service_type
  then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext(new.clinician_staff_member_id::text)::bigint);

  select count(*) into v_overlap
    from public.lng_appointments a
   where a.clinician_staff_member_id = new.clinician_staff_member_id
     and a.id <> new.id
     and a.service_type = 'virtual_impression_appointment'
     and a.status in ('booked', 'arrived', 'joined')
     and a.start_at < new.end_at and a.end_at > new.start_at;

  if v_overlap > 0 then
    raise exception
      'OVERLAP: clinician % already has a virtual appointment overlapping % to %',
      new.clinician_staff_member_id, new.start_at, new.end_at
      using errcode = '23P01';
  end if;
  return new;
end;
$$;

comment on function public.lng_virtual_clinician_guard_trg() is
  'AFTER INSERT/UPDATE constraint trigger. For virtual_impression_appointment rows with a clinician_staff_member_id, validates only when the slot footprint is established (INSERT) or changed (UPDATE of start_at/end_at/clinician_staff_member_id/service_type) — status-only transitions (virtual join booked->joined, reversal with no reschedule) are skipped because they cannot create a new double-book. Footprint-change gate added 20260610000001. When it checks: raises 23P01 if another active (booked/arrived/joined) virtual appointment for the same clinician overlaps. The DB-level guarantee a clinician is never double-booked.';

NOTIFY pgrst, 'reload schema';

-- ── Rollback ──────────────────────────────────────────────────────
-- Re-apply 20260526000001 (restores lng_appointments_overlap_guard_trg
-- to the reversal-skip version) and 20260609000006 section 7 (restores
-- lng_virtual_clinician_guard_trg to the reversal-skip version). Note
-- that doing so reinstates the start-appointment / virtual-join block
-- this migration fixes.
