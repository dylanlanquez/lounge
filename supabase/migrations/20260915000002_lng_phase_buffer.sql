-- 20260915000002_lng_phase_buffer.sql
--
-- Buffer after a booking. Dylan, 15 Sep 2026: "we need an option in
-- booking types for buffer option between calls".
--
-- A buffer is time after a booking ends during which its resources are
-- still held, so the next booking of that kind cannot start straight
-- away. For voice calls that is the agent's wrap-up: notes, the next
-- number, a breath. Patients never see it.
--
-- ── Model ──────────────────────────────────────────────────────────
-- A buffer is a PHASE (ADR-006), flagged is_buffer, always
-- patient_required = false, last in the sequence, holding the pools of
-- the phase before it. Nothing else changes: the conflict checker, both
-- slot scanners, the appointment phase materialiser and the Down time
-- sheet already treat every phase the same way, so a buffer holds its
-- pools with zero special cases. The flag exists so the admin UI can
-- offer "Buffer after" as one control rather than a hand-made phase,
-- and so patient-facing surfaces (the email timeline) can leave it out.
--
-- At most one buffer per config row. Children can override its
-- duration like any other phase; whether a phase IS a buffer is
-- structural and always read from the parent phase (a child row only
-- says so for a child-only phase).
--
-- The resolver and the materialiser below are the production
-- definitions (pg_get_functiondef, 15 Sep 2026) with the is_buffer
-- field carried through; nothing else in them changes.

begin;

alter table public.lng_booking_type_phases
  add column if not exists is_buffer boolean not null default false;
comment on column public.lng_booking_type_phases.is_buffer is
  'True for the trailing buffer phase: resources stay held after the booking, the patient is never present, never shown to the patient. At most one per config row.';

alter table public.lng_booking_type_phases
  drop constraint if exists lng_booking_type_phases_buffer_is_passive;
alter table public.lng_booking_type_phases
  add constraint lng_booking_type_phases_buffer_is_passive
  check (not is_buffer or not patient_required);

create unique index if not exists lng_booking_type_phases_one_buffer_per_config
  on public.lng_booking_type_phases (config_id) where is_buffer;

alter table public.lng_appointment_phases
  add column if not exists is_buffer boolean not null default false;
comment on column public.lng_appointment_phases.is_buffer is
  'Copied from the booking type phase at materialisation. Buffer phases are held time after the booking; patient-facing timelines skip them.';

-- ── Resolver: carry is_buffer in the phases JSON ──────────────────
CREATE OR REPLACE FUNCTION public.lng_booking_type_resolve(p_service_type text, p_repair_variant text DEFAULT NULL::text, p_product_key text DEFAULT NULL::text, p_arch text DEFAULT NULL::text)
 RETURNS TABLE(service_type text, repair_variant text, product_key text, arch text, working_hours jsonb, duration_min integer, duration_max integer, duration_default integer, max_concurrent integer, pool_ids text[], notes text, source text, phases jsonb, block_duration_minutes integer, patient_facing_min_minutes integer, patient_facing_max_minutes integer, min_notice_minutes integer)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  child_row             public.lng_booking_type_config;
  parent_row            public.lng_booking_type_config;
  pools                 text[];
  resolved_phases       jsonb;
  block_total           int;
  pf_min                int;
  pf_max                int;
  notice                int;
begin
  select * into parent_row
    from public.lng_booking_type_config c
   where c.service_type    = p_service_type
     and c.repair_variant is null
     and c.product_key    is null
     and c.arch           is null
   limit 1;

  if p_repair_variant is not null then
    select * into child_row
      from public.lng_booking_type_config c
     where c.service_type    = p_service_type
       and c.repair_variant  = p_repair_variant
       and c.product_key    is null
       and c.arch           is null
     limit 1;
  elsif p_product_key is not null then
    select * into child_row
      from public.lng_booking_type_config c
     where c.service_type    = p_service_type
       and c.repair_variant is null
       and c.product_key     = p_product_key
       and c.arch           is null
     limit 1;
  elsif p_arch is not null then
    select * into child_row
      from public.lng_booking_type_config c
     where c.service_type    = p_service_type
       and c.repair_variant is null
       and c.product_key    is null
       and c.arch            = p_arch
     limit 1;
  end if;

  -- Resolved phase array. Two sources combined, identical to M17:
  --
  --   1. Every parent phase, with the matching child phase row
  --      replacing all fields wholesale when present (M12 row-level
  --      override).
  --   2. Every child phase whose phase_index is NOT present on the
  --      parent — variant-only steps the parent doesn't have. All
  --      fields come from the child row directly.
  select coalesce(jsonb_agg(elt order by (elt->>'phase_index')::int), '[]'::jsonb)
    into resolved_phases
    from (
      select jsonb_build_object(
               'phase_index',      pp.phase_index,
               'label',            coalesce(cp.label, pp.label),
               'patient_required', coalesce(cp.patient_required, pp.patient_required),
               'is_buffer',        pp.is_buffer,
               'duration_min',     coalesce(cp.duration_min,     pp.duration_min),
               'duration_max',     coalesce(cp.duration_max,     pp.duration_max),
               'duration_default', coalesce(cp.duration_default, pp.duration_default),
               'pool_ids',         case
                 when cp.id is not null then coalesce(
                   (select array_agg(p2.pool_id order by p2.pool_id)
                      from public.lng_booking_type_phase_pools p2
                     where p2.phase_id = cp.id),
                   array[]::text[]
                 )
                 else coalesce(
                   (select array_agg(p2.pool_id order by p2.pool_id)
                      from public.lng_booking_type_phase_pools p2
                     where p2.phase_id = pp.id),
                   array[]::text[]
                 )
               end
             ) as elt
        from public.lng_booking_type_phases pp
        left join public.lng_booking_type_phases cp
               on child_row.id is not null
              and cp.config_id   = child_row.id
              and cp.phase_index = pp.phase_index
       where pp.config_id = parent_row.id

      union all

      select jsonb_build_object(
               'phase_index',      cp.phase_index,
               'label',            cp.label,
               'patient_required', cp.patient_required,
               'is_buffer',        cp.is_buffer,
               'duration_min',     cp.duration_min,
               'duration_max',     cp.duration_max,
               'duration_default', cp.duration_default,
               'pool_ids',         coalesce(
                 (select array_agg(p2.pool_id order by p2.pool_id)
                    from public.lng_booking_type_phase_pools p2
                   where p2.phase_id = cp.id),
                 array[]::text[]
               )
             ) as elt
        from public.lng_booking_type_phases cp
       where child_row.id is not null
         and cp.config_id = child_row.id
         and not exists (
           select 1
             from public.lng_booking_type_phases pp
            where pp.config_id   = parent_row.id
              and pp.phase_index = cp.phase_index
         )
    ) merged;

  -- Aggregated pool_ids (legacy field) — sourced from parent phase
  -- pools only. Same as M12 / M17.
  select coalesce(array_agg(distinct pool_id order by pool_id),
                  array[]::text[])
    into pools
    from (
      select pp.pool_id
        from public.lng_booking_type_phase_pools pp
        join public.lng_booking_type_phases ph on ph.id = pp.phase_id
       where ph.config_id = parent_row.id
    ) phase_pools;

  select coalesce(sum((elt->>'duration_default')::int), 0)
    into block_total
    from jsonb_array_elements(resolved_phases) elt;

  pf_min := coalesce(
    child_row.patient_facing_min_minutes,
    parent_row.patient_facing_min_minutes,
    nullif(block_total, 0)
  );

  pf_max := coalesce(
    child_row.patient_facing_max_minutes,
    parent_row.patient_facing_max_minutes
  );

  -- Notice: child wins when set, else parent. Stays NULL when
  -- neither side sets it — the slot scanners coalesce(NULL, 0) so a
  -- missing value means "no gate", matching today's behaviour.
  notice := coalesce(
    child_row.min_notice_minutes,
    parent_row.min_notice_minutes
  );

  return query
    select
      p_service_type                                                    as service_type,
      p_repair_variant                                                  as repair_variant,
      p_product_key                                                     as product_key,
      p_arch                                                            as arch,
      coalesce(child_row.working_hours,    parent_row.working_hours)    as working_hours,
      coalesce(child_row.duration_min,     parent_row.duration_min)     as duration_min,
      coalesce(child_row.duration_max,     parent_row.duration_max)     as duration_max,
      coalesce(child_row.duration_default, parent_row.duration_default) as duration_default,
      coalesce(child_row.max_concurrent,   parent_row.max_concurrent)   as max_concurrent,
      pools                                                             as pool_ids,
      coalesce(child_row.notes,            parent_row.notes)            as notes,
      case
        when child_row.id is not null then 'child'
        else 'parent'
      end                                                               as source,
      resolved_phases                                                   as phases,
      nullif(block_total, 0)                                            as block_duration_minutes,
      pf_min                                                            as patient_facing_min_minutes,
      pf_max                                                            as patient_facing_max_minutes,
      notice                                                            as min_notice_minutes;
end;
$function$;

-- ── Materialiser: copy is_buffer onto the appointment phase ───────
CREATE OR REPLACE FUNCTION public.lng_materialise_appointment_phases(p_appointment_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      'info',  -- ↳ downgraded from 'warning'. Drift is an ops signal,
               --   not a system failure. The appointment timeline
               --   only surfaces warning / error / critical, so this
               --   row stays queryable via the ops surface without
               --   alarming staff on a healthy patient timeline.
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
          'info',  -- ↳ downgraded from 'warning' for the same reason
                   --   as the drift insert above. Phase trimming is a
                   --   direct consequence of the same config drift; if
                   --   that's an info signal, this is too.
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
      appointment_id, phase_index, label, patient_required, is_buffer,
      pool_ids, start_at, end_at, status
    ) values (
      appt.id,
      (phase->>'phase_index')::int,
      phase->>'label',
      (phase->>'patient_required')::boolean,
      coalesce((phase->>'is_buffer')::boolean, false),
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
$function$;

commit;

notify pgrst, 'reload schema';

-- ── Rollback ──────────────────────────────────────────────────────
-- Re-apply the resolver from 20260523000001 and the materialiser from
-- 20260518000009, then:
-- drop index if exists public.lng_booking_type_phases_one_buffer_per_config;
-- alter table public.lng_booking_type_phases drop constraint if exists lng_booking_type_phases_buffer_is_passive;
-- alter table public.lng_booking_type_phases drop column if exists is_buffer;
-- alter table public.lng_appointment_phases drop column if exists is_buffer;
