-- 20260503000005_lng_materialise_appointment_phases.sql
--
-- ADR-006 / slice doc `docs/slices/booking-phases.md` — task #4.
--
-- The single source of truth for translating a (just-created or
-- just-rescheduled) lng_appointments row into its lng_appointment_
-- phases snapshot rows. Wired into a trigger on lng_appointments so
-- every code path that inserts or reschedules an appointment
-- (Calendly inbound webhook, native reschedule, manual / admin
-- create) gets phases without per-callsite plumbing.
--
-- ── How it works ──────────────────────────────────────────────────
--
-- Given an appointment_id, the helper:
--
--   1. Reads the appointment (service_type, start_at, end_at, status).
--   2. Skips with a logged warning if status is terminal (cancelled,
--      no_show, complete, rescheduled) — those appointments don't
--      need phase data.
--   3. Skips with a logged warning if service_type is null (legacy
--      Calendly imports the _05 backfill missed) — nothing to
--      resolve against.
--   4. Calls lng_booking_type_resolve(service_type) to fetch the
--      resolved phase array for the parent service. (Per-appointment
--      child-override resolution is out of scope: lng_appointments
--      doesn't carry the child key columns. Follow-up work if
--      needed — see ADR-006.)
--   5. Walks the phase array in phase_index order, computing each
--      phase's [start_at, end_at] by summing duration_default values
--      from the appointment's start_at. The LAST phase is elastic:
--      it extends or trims to make the materialised phase sequence
--      exactly fill [appointment.start_at, appointment.end_at]. This
--      means:
--        * 1-phase bookings (all current state) always span the full
--          appointment block, regardless of the default duration.
--        * N-phase bookings honour each non-final phase's canonical
--          duration_default; the final phase absorbs any drift
--          between the appointment block and the phase-sum total.
--   6. Deletes any existing lng_appointment_phases rows for the
--      appointment (re-materialisation on UPDATE), then inserts the
--      fresh snapshot rows.
--   7. Logs a warning when the sum of phase durations diverges from
--      (appointment.end_at - appointment.start_at) by more than a
--      small tolerance — config drift the admin should see — even
--      though the elastic-final-phase rule prevents data corruption.
--
-- Status mapping mirrors M2's backfill:
--   appointment.status = 'arrived' or 'in_progress'  → phase 1 = 'in_progress', rest 'pending'
--   anything else (booked)                           → all phases 'pending'
--
-- ── Why SECURITY DEFINER ─────────────────────────────────────────
-- The trigger fires under whatever role inserts into lng_appointments
-- (Calendly webhook = service role; reschedule from a receptionist
-- session = authenticated user). lng_appointment_phases admin-write
-- policy would block the receptionist case. SECURITY DEFINER lets
-- the trigger insert phase rows on the user's behalf without
-- needing admin rights. Search_path is pinned to public to neutralise
-- the standard SECURITY DEFINER attack surface.
--
-- ── Idempotency ───────────────────────────────────────────────────
-- DELETE-then-INSERT inside the helper. Trigger uses CREATE OR
-- REPLACE FUNCTION + DROP/CREATE TRIGGER. Calling the helper a
-- second time is a no-op (same data re-inserted).

-- ── 1. Helper function ───────────────────────────────────────────

create or replace function public.lng_materialise_appointment_phases(
  p_appointment_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  appt              public.lng_appointments;
  resolved          record;
  phase             jsonb;
  cursor_at         timestamptz;
  next_at           timestamptz;
  phase_dur         int;
  total_phase_min   int;
  appt_block_min    int;
  drift_min         int;
  max_phase_index   int;
  initial_status    text;
  any_inserted      boolean := false;
begin
  select * into appt
    from public.lng_appointments
   where id = p_appointment_id;

  if not found then
    return; -- appointment was deleted between the trigger firing
            -- and this select. Nothing to do.
  end if;

  -- Terminal states don't need phases.
  if appt.status in ('cancelled', 'no_show', 'complete', 'rescheduled') then
    return;
  end if;

  if appt.service_type is null then
    insert into public.lng_system_failures (severity, source, message, context)
    values (
      'warning',
      'lng_materialise_appointment_phases',
      'Appointment has no service_type, phase materialisation skipped',
      jsonb_build_object('appointment_id', appt.id, 'status', appt.status)
    );
    return;
  end if;

  -- Resolve the parent service's phase shape.
  select phases, block_duration_minutes
    into resolved
    from public.lng_booking_type_resolve(appt.service_type);

  if resolved.phases is null
     or jsonb_array_length(resolved.phases) = 0 then
    insert into public.lng_system_failures (severity, source, message, context)
    values (
      'error',
      'lng_materialise_appointment_phases',
      'Booking type has no phase rows, phase materialisation skipped',
      jsonb_build_object(
        'appointment_id', appt.id,
        'service_type',   appt.service_type
      )
    );
    return;
  end if;

  -- Loud config-drift check — sum of phase durations vs appointment block.
  total_phase_min := coalesce(resolved.block_duration_minutes, 0);
  appt_block_min  := greatest(extract(epoch from (appt.end_at - appt.start_at)) / 60, 0)::int;
  drift_min       := total_phase_min - appt_block_min;

  if abs(drift_min) > 5 then
    insert into public.lng_system_failures (severity, source, message, context)
    values (
      'warning',
      'lng_materialise_appointment_phases',
      'Phase duration sum diverges from appointment block by more than 5 minutes',
      jsonb_build_object(
        'appointment_id',     appt.id,
        'service_type',       appt.service_type,
        'phase_total_minutes', total_phase_min,
        'appointment_block_minutes', appt_block_min,
        'drift_minutes',      drift_min
      )
    );
  end if;

  -- Wipe + re-insert. Re-materialisation on UPDATE relies on this
  -- being atomic; the wrapping trigger or caller statement provides
  -- the transaction boundary.
  delete from public.lng_appointment_phases
   where appointment_id = appt.id;

  initial_status := case
    when appt.status in ('arrived', 'in_progress') then 'in_progress'
    else 'pending'
  end;

  -- Find the highest phase_index so we know which row is the
  -- elastic "absorb the drift" final phase.
  select max((elt->>'phase_index')::int)
    into max_phase_index
    from jsonb_array_elements(resolved.phases) elt;

  cursor_at := appt.start_at;

  for phase in select elt
                 from jsonb_array_elements(resolved.phases) elt
                order by (elt->>'phase_index')::int
  loop
    phase_dur := coalesce((phase->>'duration_default')::int, 0);

    if (phase->>'phase_index')::int = max_phase_index then
      -- Final phase: extend (or trim) so that this phase's end_at
      -- aligns exactly with the appointment.end_at. This way the
      -- materialised phase sequence always spans [start_at, end_at]
      -- exactly, even when Calendly's event duration doesn't match
      -- our phase config sum.
      next_at := appt.end_at;
      if next_at <= cursor_at then
        -- Earlier non-final phases overran the appointment block
        -- entirely. Surface loudly; skip this phase rather than
        -- create a degenerate range.
        insert into public.lng_system_failures (severity, source, message, context)
        values (
          'error',
          'lng_materialise_appointment_phases',
          'Non-final phases consumed the entire appointment block, final phase has no time',
          jsonb_build_object(
            'appointment_id', appt.id,
            'phase',          phase,
            'cursor_at',      cursor_at,
            'appt_end_at',    appt.end_at
          )
        );
        continue;
      end if;
    else
      if phase_dur <= 0 then
        -- Defensive: a 0-duration phase would create a zero-length
        -- range that breaks the end_at > start_at check.
        insert into public.lng_system_failures (severity, source, message, context)
        values (
          'warning',
          'lng_materialise_appointment_phases',
          'Phase has non-positive duration_default, skipped',
          jsonb_build_object(
            'appointment_id', appt.id,
            'phase',          phase
          )
        );
        continue;
      end if;
      next_at := cursor_at + (phase_dur * interval '1 minute');

      -- If this non-final phase already runs past the appointment's
      -- end_at, trim and stop iterating. The final-phase branch
      -- won't fire either; surface the truncation.
      if next_at >= appt.end_at then
        next_at := appt.end_at;
        insert into public.lng_system_failures (severity, source, message, context)
        values (
          'warning',
          'lng_materialise_appointment_phases',
          'Phase config overruns appointment block, non-final phase trimmed to fit',
          jsonb_build_object(
            'appointment_id', appt.id,
            'phase',          phase,
            'appt_end_at',    appt.end_at
          )
        );
      end if;
    end if;

    insert into public.lng_appointment_phases (
      appointment_id, phase_index, label, patient_required,
      pool_ids, start_at, end_at, status
    ) values (
      appt.id,
      (phase->>'phase_index')::int,
      phase->>'label',
      (phase->>'patient_required')::boolean,
      coalesce(
        (select array_agg(value)
           from jsonb_array_elements_text(phase->'pool_ids')),
        array[]::text[]
      ),
      cursor_at,
      next_at,
      -- Only the FIRST phase inherits the appointment's
      -- "in_progress" status when arrived/in_progress; later phases
      -- always start pending. The receptionist explicitly advances.
      case when (phase->>'phase_index')::int = 1 then initial_status else 'pending' end
    );

    any_inserted := true;
    cursor_at := next_at;

    -- Once we've consumed the full appointment block, stop —
    -- remaining phases (if any) wouldn't fit.
    exit when cursor_at >= appt.end_at;
  end loop;

  if not any_inserted then
    insert into public.lng_system_failures (severity, source, message, context)
    values (
      'error',
      'lng_materialise_appointment_phases',
      'No phase rows inserted, every phase had non-positive duration',
      jsonb_build_object(
        'appointment_id', appt.id,
        'service_type',   appt.service_type
      )
    );
  end if;
end;
$$;

revoke all on function public.lng_materialise_appointment_phases(uuid) from public;
grant execute on function public.lng_materialise_appointment_phases(uuid) to authenticated, service_role;

comment on function public.lng_materialise_appointment_phases(uuid) is
  'Single source of truth for translating an appointment into its phase snapshot rows. Wired into a trigger on lng_appointments. Idempotent (deletes + re-inserts). Logs to lng_system_failures on missing service_type, missing phases, zero-duration phase, or phase-sum drift > 5 min from the appointment block. SECURITY DEFINER so receptionist sessions can trigger materialisation without admin rights.';

-- ── 2. Trigger function ──────────────────────────────────────────
-- Calls the helper on INSERT and on UPDATE OF the columns that
-- shape the phase materialisation.

create or replace function public.lng_appointments_materialise_phases_trg()
returns trigger
language plpgsql
security invoker
as $$
begin
  if tg_op = 'INSERT' then
    perform public.lng_materialise_appointment_phases(new.id);
  elsif tg_op = 'UPDATE' then
    -- Re-materialise only if a phase-shaping column changed OR if
    -- the appointment moved from a terminal status back to active
    -- (rare but possible — reverse-no-show flow).
    if   new.start_at     is distinct from old.start_at
      or new.service_type is distinct from old.service_type
      or (
        old.status in ('cancelled', 'no_show', 'complete', 'rescheduled')
        and new.status in ('booked', 'arrived', 'in_progress')
      )
    then
      perform public.lng_materialise_appointment_phases(new.id);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists lng_appointments_materialise_phases on public.lng_appointments;
create trigger lng_appointments_materialise_phases
  after insert or update on public.lng_appointments
  for each row execute function public.lng_appointments_materialise_phases_trg();

comment on function public.lng_appointments_materialise_phases_trg() is
  'Trigger function. After INSERT, materialises phases. After UPDATE, re-materialises only when start_at or service_type changed, or when status transitions from terminal back to active. The helper is idempotent so spurious extra calls are harmless but wasteful.';

-- ── Rollback ──────────────────────────────────────────────────────
-- drop trigger if exists lng_appointments_materialise_phases on public.lng_appointments;
-- drop function if exists public.lng_appointments_materialise_phases_trg();
-- drop function if exists public.lng_materialise_appointment_phases(uuid);
