-- 20260813000003_lng_visits_sync_schedule_status.sql
--
-- Closes the class of bug that 20260813000001 and 20260813000002
-- repaired case by case, so it cannot reappear from a path nobody has
-- written yet.
--
-- ── What kept going wrong ────────────────────────────────────────
-- A visit and the schedule row that represents it live in two tables.
-- lng_visits.status is the operational truth; the calendar reads
-- lng_appointments.status. Every writer that moved a visit to a
-- terminal state had to remember to move the schedule row with it, and
-- three of them did not:
--
--   • completeVisit() (client) only flipped lng_appointments when the
--     visit carried an appointment_id. A walk-in visit never does —
--     the exactly-one constraint forces walk_in_id — so its calendar
--     marker sat on 'arrived' forever. 12 rows, oldest 20 May 2026.
--   • completeVisit() again, on a booked appointment (10 Jul 2026):
--     the update ran but its result was never checked, and Supabase
--     returns RLS / constraint failures in the response object rather
--     than rejecting. The failure was swallowed. 1 row.
--   • lng_end_visit_early / lng_remove_cart_line never touched
--     lng_appointments at all. 12 rows.
--
-- 25 stranded rows in total, every one of them rendering an "Arrived"
-- pill at full strength because isAppointmentDimmed refuses to dim an
-- 'arrived' row at any age.
--
-- ── The fix ──────────────────────────────────────────────────────
-- Stop asking each writer to remember. A trigger on lng_visits derives
-- the schedule status from the visit status inside the same
-- transaction, so the two cannot diverge no matter which client path,
-- RPC, or future feature moves the visit.
--
-- Mapping (lng_visits.status is one of exactly four values):
--   arrived                              -> arrived
--   complete | unsuitable | ended_early  -> complete
--
-- 'complete' for all three terminal states is Dylan's call, recorded in
-- 20260813000002: the schedule will read "Complete" for a booking where
-- the patient walked out. lng_visits keeps the accurate record
-- (visit_end_reason / visit_end_note) and VisitDetail's header shows it.
--
-- ── What it deliberately will not overwrite ──────────────────────
-- Only rows on 'booked', 'arrived', 'joined' or 'complete' are touched.
-- 'cancelled', 'no_show' and 'rescheduled' are deliberate operator
-- decisions about the booking, not derivable from the visit, and a
-- visit status change must not silently undo one. 'complete' is in the
-- allowed set so lng_reverse_visit_end can pull a resumed visit's row
-- back to 'arrived'.
--
-- ── Relationship to the existing writers ─────────────────────────
-- completeVisit() and the two RPCs keep their explicit updates. They
-- now land on the same value the trigger derives, so the second write
-- is a no-op (the trigger guards on `status is distinct from`), and the
-- app stays correct on an environment where this migration has not yet
-- been applied. The trigger is the backstop, not the only writer.
--
-- ── Apply order (per CLAUDE.md) ──────────────────────────────────
-- Write -> shadow (verify) -> Meridian. Apply after 20260813000001 and
-- 20260813000002, which carry the backfills for the 25 existing rows.
-- No destructive operations: one function, one trigger.

create or replace function public.lng_visits_sync_schedule_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target text;
begin
  -- `after update of status` still fires when the column is written
  -- with its current value, which every unrelated visit update does
  -- not do but a defensive caller might. Nothing to sync in that case.
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return new;
  end if;

  v_target := case new.status
                when 'arrived' then 'arrived'
                else 'complete'
              end;

  -- A visit identifies its schedule row one of two ways and never
  -- both: appointment_id for a booked appointment, or walk_in_id for
  -- the calendar marker in lng_appointments that carries the FK back
  -- to lng_walk_ins.
  if new.appointment_id is not null then
    update public.lng_appointments
       set status = v_target
     where id = new.appointment_id
       and status is distinct from v_target
       and status in ('booked', 'arrived', 'joined', 'complete');
  elsif new.walk_in_id is not null then
    update public.lng_appointments
       set status = v_target
     where walk_in_id = new.walk_in_id
       and status is distinct from v_target
       and status in ('booked', 'arrived', 'joined', 'complete');
  end if;

  return new;
end;
$$;

revoke all on function public.lng_visits_sync_schedule_status() from public;

comment on function public.lng_visits_sync_schedule_status() is
  'Trigger body. Derives lng_appointments.status from lng_visits.status (arrived -> arrived; complete/unsuitable/ended_early -> complete) so the schedule can never be left showing an Arrived pill for a visit that has finished. Resolves the schedule row via appointment_id or, for walk-ins, the calendar marker keyed on walk_in_id. Leaves cancelled / no_show / rescheduled rows alone.';

drop trigger if exists lng_visits_sync_schedule_status_trg on public.lng_visits;

create trigger lng_visits_sync_schedule_status_trg
after insert or update of status on public.lng_visits
for each row
execute function public.lng_visits_sync_schedule_status();

-- ── Safety net backfill ──────────────────────────────────────────
-- 20260813000001 and 20260813000002 already move the 25 known rows.
-- This repeats the same narrow match so applying this file to an
-- environment that skipped one of them still converges. Scoped to
-- rows still on 'arrived', so it cannot disturb a booking that was
-- later cancelled or rescheduled by hand. Idempotent.

update public.lng_appointments a
   set status = 'complete'
  from public.lng_visits v
 where a.status = 'arrived'
   and v.appointment_id = a.id
   and v.status in ('complete', 'unsuitable', 'ended_early');

update public.lng_appointments a
   set status = 'complete'
  from public.lng_visits v
 where a.status = 'arrived'
   and a.walk_in_id is not null
   and v.walk_in_id = a.walk_in_id
   and v.status in ('complete', 'unsuitable', 'ended_early');

-- ── Rollback ─────────────────────────────────────────────────────
-- drop trigger if exists lng_visits_sync_schedule_status_trg on public.lng_visits;
-- drop function if exists public.lng_visits_sync_schedule_status();
-- The backfill is not reversible in isolation: after the fact a
-- flipped row cannot be told apart from one that was legitimately
-- completed. Re-derive from lng_visits.status if it ever needs undoing.
