-- 20260609000003_lng_virtual_host_overlap_guard.sql
--
-- Database-level guarantee that one clinician can't be double-booked.
--
-- Virtual appointments claim no resource pool, so the existing overlap
-- guard (zz_appointments_overlap_guard, which re-runs
-- lng_booking_check_conflict) is a no-op for them — virtual had no
-- DB-level overlap protection at all. With per-clinician hours now
-- driving availability and capacity equal to the number of on-shift
-- clinicians, the integrity rule is simply: a given meet_host_id can
-- hold at most one active virtual appointment over any interval.
--
-- The app already pre-checks this (the booking edge functions pick a
-- free host via lng_meet_hosts_available). This trigger is the safety
-- net for the same race the in-person guard exists for: two staff, or a
-- staff booking and a self-serve reschedule, landing the same clinician
-- on overlapping times in the same instant. It mirrors the in-person
-- guard's shape — constraint trigger, per-key advisory lock, reversal
-- skip, SQLSTATE 23P01 so the app surfaces a "slot was just taken"
-- and the edge function falls through to the next host.
--
-- Scope: virtual_impression_appointment rows with a non-null
-- meet_host_id. Legacy / service-account rows (meet_host_id NULL) are
-- skipped — there's no host identity to double-book. On-shift coverage
-- is NOT enforced here (it gates availability, but staff retain manual
-- placement); this guard only prevents the same clinician overlapping
-- themselves.
--
-- Active set = booked / arrived / joined. 'joined' is the virtual
-- analogue of 'arrived' (20260506000017): once the call is opened the
-- appointment still occupies the clinician. Counting it here is what
-- makes the guard correct for virtual regardless of the unrelated
-- 'joined' omission in the current lng_booking_check_conflict body
-- (see note at the bottom of this file).
--
-- Idempotent: CREATE OR REPLACE + DROP/CREATE TRIGGER.

create or replace function public.lng_virtual_host_guard_trg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_overlap int;
begin
  -- Only virtual rows with an assigned host participate.
  if new.service_type is distinct from 'virtual_impression_appointment' then
    return new;
  end if;
  if new.status not in ('booked', 'arrived', 'joined') then
    return new;
  end if;
  if new.meet_host_id is null then
    return new;
  end if;

  -- Reversals (terminal -> active) restore a slot the appointment
  -- already held; don't re-validate, matching the in-person guard.
  if tg_op = 'UPDATE'
     and old.status in ('no_show', 'cancelled', 'rescheduled') then
    return new;
  end if;

  -- Serialise concurrent writes for the same clinician so two
  -- overlapping inserts can't both pass the count below.
  perform pg_advisory_xact_lock(hashtext(new.meet_host_id::text)::bigint);

  select count(*)
    into v_overlap
    from public.lng_appointments a
   where a.meet_host_id = new.meet_host_id
     and a.id <> new.id
     and a.service_type = 'virtual_impression_appointment'
     and a.status in ('booked', 'arrived', 'joined')
     and a.start_at < new.end_at
     and a.end_at   > new.start_at;

  if v_overlap > 0 then
    raise exception
      'OVERLAP: meet host % already has a virtual appointment overlapping % to %',
      new.meet_host_id, new.start_at, new.end_at
      using errcode = '23P01';
  end if;

  return new;
end;
$$;

revoke all on function public.lng_virtual_host_guard_trg() from public;

comment on function public.lng_virtual_host_guard_trg() is
  'AFTER INSERT/UPDATE constraint trigger on lng_appointments. For virtual_impression_appointment rows with a meet_host_id, acquires a per-host advisory lock and raises 23P01 if another active (booked/arrived/joined) virtual appointment for the same host overlaps. Reversals from terminal states skip. The DB-level guarantee that a clinician is never double-booked.';

drop trigger if exists zz_virtual_host_overlap_guard on public.lng_appointments;
create constraint trigger zz_virtual_host_overlap_guard
  after insert or update of start_at, end_at, status, meet_host_id, service_type
  on public.lng_appointments
  initially immediate
  for each row
  execute function public.lng_virtual_host_guard_trg();

-- ── Note: pre-existing 'joined' omission in lng_booking_check_conflict ──
-- 20260518000006 added 'joined' to the active set in
-- lng_booking_check_conflict; 20260523000003 (the min-notice rewrite)
-- copied the older body and reverted it to ('booked','arrived',
-- 'in_progress'), dropping 'joined' and re-adding the retired
-- 'in_progress'. That regression does not affect virtual overlap once
-- this guard is in place (virtual claims no pool and this guard counts
-- 'joined' directly), but it should be fixed in the in-person checker on
-- its own. Tracked separately — not bundled here to keep this change
-- scoped to the clinician-hours feature.

NOTIFY pgrst, 'reload schema';

-- ── Rollback ──────────────────────────────────────────────────────
-- drop trigger if exists zz_virtual_host_overlap_guard on public.lng_appointments;
-- drop function if exists public.lng_virtual_host_guard_trg();
