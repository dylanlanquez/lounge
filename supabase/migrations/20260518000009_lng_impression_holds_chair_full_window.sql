-- 20260518000009_lng_impression_holds_chair_full_window.sql
--
-- Two corrections after the same-day chair-hold migration
-- (20260518000008) and the materialiser drift-warning noise problem:
--
-- ── 1. same_day_appliance / missing_tooth Manufacture phase ──────
-- Migration 20260518000008 attached consult-room to the parent
-- same_day_appliance Manufacture phase. The `missing_tooth` child
-- override row has its OWN Manufacture phase (per ADR-006 child
-- override semantics — when a child phase row exists, all its fields
-- replace the parent's), and that row still carried empty pool_ids.
-- A same_day_appliance + missing_tooth booking therefore still
-- released the chair during Manufacture. Attaching consult-room
-- here gives the same end-to-end chair hold as the parent flow.
--
-- ── 2. Phase-drift warning severity ──────────────────────────────
-- lng_materialise_appointment_phases logged a `warning` when the
-- sum of phase durations diverged from the appointment block by
-- more than 5 minutes. The appointment timeline surfaces every row
-- in lng_system_failures with severity warning/error/critical as
-- "System failure". That meant a healthy patient appointment whose
-- service had a known config drift (e.g. virtual_impression's
-- duration_default = 30 min vs phases summing to 20 min, ten minutes
-- of slack) showed up to staff as "System failure: Phase duration
-- sum diverges from appointment block by more than 5 minutes". Loud
-- alarm bell on a working booking.
--
-- The drift signal is genuinely useful for ops — config that's
-- drifted should be visible to whoever maintains the booking-type
-- ribbon. But not on the patient-facing timeline as a failure.
-- Drop the severity to `info` so:
--   * the row stays in lng_system_failures and can be queried by
--     Admin tooling that filters for drift
--   * the appointment timeline (which only renders warning + error
--     + critical) stops surfacing it as a system failure
--
-- The same downgrade applies to the sibling
-- "Phase config overruns appointment block, non-final phase trimmed
-- to fit" message, which is a direct consequence of the same drift.

-- ── 1. same_day_appliance missing_tooth Manufacture holds chair ──
insert into public.lng_booking_type_phase_pools (phase_id, pool_id)
select p.id, 'consult-room'
  from public.lng_booking_type_phases p
  join public.lng_booking_type_config c on c.id = p.config_id
 where c.service_type = 'same_day_appliance'
   and c.product_key  = 'missing_tooth'
   and p.label        = 'Manufacture'
on conflict (phase_id, pool_id) do nothing;

-- ── 2. Re-materialise active same_day_appliance / missing_tooth rows
do $$
declare
  r record;
begin
  for r in
    select a.id
      from public.lng_appointments a
     where a.status in ('booked', 'arrived', 'joined')
       and a.service_type = 'same_day_appliance'
       and a.product_key  = 'missing_tooth'
     order by a.start_at, a.created_at
  loop
    perform public.lng_materialise_appointment_phases(r.id);
  end loop;
end$$;

-- ── 3. Demote the phase-drift warning to info ────────────────────
-- Function body is reproduced from the prior version verbatim with
-- two `insert` calls changed: severity 'warning' → 'info' for the
-- drift and trim diagnostics. Every other branch keeps its existing
-- severity (real failures still surface).
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
    return;
  end if;

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

  total_phase_min := coalesce(resolved.block_duration_minutes, 0);
  appt_block_min  := greatest(extract(epoch from (appt.end_at - appt.start_at)) / 60, 0)::int;
  drift_min       := total_phase_min - appt_block_min;

  if abs(drift_min) > 5 then
    insert into public.lng_system_failures (severity, source, message, context)
    values (
      'info',  -- ↳ downgraded from 'warning'. See header comment.
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

  delete from public.lng_appointment_phases
   where appointment_id = appt.id;

  initial_status := case
    when appt.status in ('arrived', 'joined') then 'in_progress'
    else 'pending'
  end;

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
      next_at := appt.end_at;
      if next_at <= cursor_at then
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

      if next_at >= appt.end_at then
        next_at := appt.end_at;
        insert into public.lng_system_failures (severity, source, message, context)
        values (
          'info',  -- ↳ downgraded from 'warning'. See header comment.
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
      case when (phase->>'phase_index')::int = 1 then initial_status else 'pending' end
    );

    any_inserted := true;
    cursor_at := next_at;

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

-- ── 4. Suppress historical drift / trim warnings on the timeline ─
update public.lng_system_failures
   set severity = 'info'
 where source = 'lng_materialise_appointment_phases'
   and severity = 'warning'
   and message in (
     'Phase duration sum diverges from appointment block by more than 5 minutes',
     'Phase config overruns appointment block, non-final phase trimmed to fit'
   );

-- ── Rollback ──────────────────────────────────────────────────────
-- 1. delete from lng_booking_type_phase_pools where (phase_id, pool_id) matches the missing_tooth Manufacture row above
-- 2. re-apply 20260518000006's materialise function definition
-- 3. (optional) reverse the historical severity downgrade
