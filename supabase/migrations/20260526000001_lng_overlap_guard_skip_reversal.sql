-- 20260526000001_lng_overlap_guard_skip_reversal.sql
--
-- Reversing a no-show, cancellation, or reschedule restores the
-- appointment to booked/arrived/joined. The overlap guard trigger
-- fires because the new status is in the active set, and then the
-- min_notice gate rejects it because the start time is in the past.
--
-- This is a false positive: the appointment already held its slot
-- before it was terminally flagged. The reversal is restoring the
-- prior state, not creating a new booking. Skip the conflict check
-- when OLD.status was terminal and NEW.status is active.
--
-- Idempotent: CREATE OR REPLACE.

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

  if new.service_type is null then
    return new;
  end if;

  -- Reversals: when the OLD status was terminal and we're restoring
  -- to an active state, skip the conflict check. The appointment
  -- already held this slot before it was cancelled/no-showed/
  -- rescheduled. Re-validating would fail on min_notice (start time
  -- is in the past) and potentially on pool counts that shifted
  -- while the row was terminal. The reversal is restoring prior
  -- state, not creating a new booking.
  if tg_op = 'UPDATE'
     and old.status in ('no_show', 'cancelled', 'rescheduled') then
    return new;
  end if;

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
  'AFTER INSERT/UPDATE constraint trigger on lng_appointments. Acquires a per-location pg_advisory_xact_lock, then re-runs lng_booking_check_conflict. Active set = booked / arrived / joined. Reversals from terminal states (no_show, cancelled, rescheduled) skip the check entirely — the appointment already held its slot. Walk-in / Calendly bypasses log to lng_system_failures; everything else raises with SQLSTATE 23P01.';

-- ── Rollback ──────────────────────────────────────────────────────
-- Revert to the version from 20260518000006:
--   Remove the tg_op = 'UPDATE' AND old.status in (...) early-return.
