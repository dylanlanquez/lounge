-- 20260518000007_lng_auto_ref_walk_in_discriminator.sql
--
-- The auto-ref trigger that stamps LAP references at insert time was
-- using `source = 'manual'` as the "skip" discriminator. That was
-- correct when `source = 'manual'` exclusively meant "walk-in marker
-- row created by createWalkInVisit()" — those skip ref generation
-- because the canonical LAP lives on the lng_walk_ins row.
--
-- But `source = 'manual'` is now overloaded by THREE distinct flows:
--
--   1. createWalkInVisit         — walk-in marker, walk_in_id IS NOT NULL,
--                                  LAP lives on lng_walk_ins. SKIP correctly.
--   2. createAppointment          — Schedule's "New Booking" button.
--                                  walk_in_id IS NULL. Needs a fresh LAP.
--   3. rescheduleAppointment      — Lounge staff reschedule sheet.
--                                  walk_in_id IS NULL. Needs a fresh LAP.
--
-- The old discriminator silently swallowed flows 2 and 3. Every
-- in-clinic appointment booked from Schedule or rescheduled from the
-- detail surface landed without a LAP. Confirmed in production:
-- a queue of source='manual', walk_in_id IS NULL, appointment_ref IS NULL
-- rows accumulated.
--
-- The architecturally correct discriminator is `walk_in_id IS NULL` —
-- which IS the actual property that distinguishes the "walk-in marker
-- whose LAP lives elsewhere" case from every other appointment.
--
-- Migration in one go:
--   1. Replace the trigger function with the new discriminator.
--   2. Backfill every source='manual' AND walk_in_id IS NULL AND
--      appointment_ref IS NULL row with a fresh ref, ordered by
--      (start_at, created_at) so refs run chronologically.
--
-- Idempotent (CREATE OR REPLACE FUNCTION + filtered backfill).

create or replace function public.lng_appointments_auto_ref()
returns trigger
language plpgsql
as $$
begin
  -- Skip the LAP only for walk-in marker rows. Walk-in markers carry
  -- walk_in_id IS NOT NULL and their canonical reference lives on
  -- lng_walk_ins.appointment_ref. Every other row gets one.
  if new.appointment_ref is null and new.walk_in_id is null then
    new.appointment_ref := public.generate_appointment_ref();
  end if;
  return new;
end;
$$;

-- ── Backfill stranded LAPs ───────────────────────────────────────
-- Order by start_at to keep refs chronologically meaningful (LAP-N is
-- always for an earlier slot than LAP-N+1).
do $$
declare
  r record;
begin
  for r in
    select id
      from public.lng_appointments
     where appointment_ref is null
       and walk_in_id is null
     order by start_at, created_at
  loop
    update public.lng_appointments
       set appointment_ref = public.generate_appointment_ref()
     where id = r.id;
  end loop;
end$$;

-- ── Rollback ──────────────────────────────────────────────────────
-- Re-apply 20260506000018 to restore the source-based discriminator.
