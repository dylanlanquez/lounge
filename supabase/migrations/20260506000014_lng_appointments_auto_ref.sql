-- Auto-generate appointment_ref at INSERT time.
--
-- Previously the ref was stamped only during submitArrivalIntake().
-- That meant any appointment that skipped the physical arrival flow
-- (virtual sessions, Calendly no-shows, cancellations before arrival)
-- would never gain one. The fix is a BEFORE INSERT trigger so every
-- non-marker row gets a ref the moment it's written.
--
-- manual-source rows are the walk-in calendar markers created by
-- createWalkInVisit() — they're synthetic schedule-display entries
-- and the actual appointment_ref lives on the lng_walk_ins row.

-- ── BEFORE INSERT trigger ─────────────────────────────────────────────────────

create or replace function public.lng_appointments_auto_ref()
returns trigger
language plpgsql
as $$
begin
  if new.appointment_ref is null and new.source is distinct from 'manual' then
    new.appointment_ref := public.generate_appointment_ref();
  end if;
  return new;
end;
$$;

drop trigger if exists lng_appointments_auto_ref on public.lng_appointments;
create trigger lng_appointments_auto_ref
  before insert on public.lng_appointments
  for each row execute function public.lng_appointments_auto_ref();

-- ── Backfill existing NULL rows ───────────────────────────────────────────────
-- Assigns LAP refs to all Calendly rows that never got one, ordered by
-- start_at so refs run chronologically (LAP-00023 is an earlier booking
-- than LAP-00024, which makes support easier).

do $$
declare
  r record;
begin
  for r in
    select id
    from public.lng_appointments
    where appointment_ref is null
      and source != 'manual'
    order by start_at, created_at
  loop
    update public.lng_appointments
       set appointment_ref = public.generate_appointment_ref()
     where id = r.id;
  end loop;
end;
$$;
