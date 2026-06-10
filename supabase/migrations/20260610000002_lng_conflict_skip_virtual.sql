-- 20260610000002_lng_conflict_skip_virtual.sql
--
-- Virtual impression appointments are governed entirely by the
-- PER-CLINICIAN model, keyed on lng_appointments.clinician_staff_member_id:
--   * availability  -> lng_clinicians_available / lng_virtual_available_slots
--   * no-double-book -> lng_virtual_clinician_guard_trg (AFTER trigger)
--
-- They also still carried a legacy phase pool, 'virtual-impression-clinician'
-- (capacity 1), so lng_booking_check_conflict counted them like a shared
-- physical resource. With multiple named clinicians that pool is WRONG: it
-- serialises every clinician into a single slot, and it DISAGREES with the
-- per-clinician model. Concretely, this caused:
--   * the New Booking "Slot conflicts" banner to fire on a time the slot
--     list + clinician picker had just shown as free (a different clinician,
--     or a legacy clinician-less booking, consumed the shared pool);
--   * the DB overlap guard (which also calls this function) to REJECT a
--     legitimate second-clinician booking on Save;
--   * two clinicians being unable to run two concurrent calls at all.
--
-- Fix: exclude virtual_impression_appointment from the pool-based conflict
-- checker. The per-clinician guard is the sole, correct gate. Every live
-- creation path assigns a clinician (widget + Checkpoint via
-- widget-create-appointment, which 409s when none is free; staff New
-- Booking requires one); legacy clinician-less rows were backfilled to a
-- clinician. Calendly virtual bookings are dormant (last 2026-05-20) and
-- would simply be ungated by the pool — acceptable and noted.
--
-- Reproduces the live function verbatim with one early-return added after
-- begin. Idempotent (CREATE OR REPLACE). Apply: shadow first, then Meridian.

CREATE OR REPLACE FUNCTION public.lng_booking_check_conflict(p_location_id uuid, p_service_type text, p_start_at timestamp with time zone, p_end_at timestamp with time zone, p_exclude_appointment_id uuid DEFAULT NULL::uuid, p_repair_variant text DEFAULT NULL::text, p_product_key text DEFAULT NULL::text, p_arch text DEFAULT NULL::text)
 RETURNS TABLE(conflict_kind text, pool_id text, pool_capacity integer, current_count integer, phase_index integer, phase_label text, conflict_start_at timestamp with time zone, conflict_end_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  resolved              record;
  phase                 jsonb;
  cursor_at             timestamptz;
  next_at               timestamptz;
  phase_dur             int;
  max_phase_idx         int;
  pool_text             text;
  pool_cap              int;
  cnt                   int;
  max_concurrent_for_s  int;
  v_notice              int;
  v_earliest            timestamptz;
begin
  -- Virtual impressions are governed by the per-clinician model
  -- (lng_clinicians_available + lng_virtual_clinician_guard_trg), not by
  -- the shared pool. Skip the pool-based check so the two models cannot
  -- contradict each other. See migration header.
  if p_service_type = 'virtual_impression_appointment' then
    return;
  end if;

  select phases, block_duration_minutes, min_notice_minutes
    into resolved
    from public.lng_booking_type_resolve(
      p_service_type, p_repair_variant, p_product_key, p_arch
    );

  -- ── Notice gate (from 20260523000003) ──
  v_notice := coalesce(resolved.min_notice_minutes, 0);
  if v_notice > 0 then
    v_earliest := now() + make_interval(mins => v_notice);
    if p_start_at < v_earliest then
      conflict_kind     := 'min_notice';
      pool_id           := null;
      pool_capacity     := v_notice;
      current_count     := null;
      phase_index       := null;
      phase_label       := null;
      conflict_start_at := now();
      conflict_end_at   := v_earliest;
      return next;
      return;
    end if;
  end if;

  if resolved.phases is null
     or jsonb_array_length(resolved.phases) = 0 then
    return;
  end if;

  select max((elt->>'phase_index')::int)
    into max_phase_idx
    from jsonb_array_elements(resolved.phases) elt;

  cursor_at := p_start_at;

  for phase in select elt
                 from jsonb_array_elements(resolved.phases) elt
                order by (elt->>'phase_index')::int
  loop
    phase_dur := coalesce((phase->>'duration_default')::int, 0);

    if (phase->>'phase_index')::int = max_phase_idx then
      next_at := p_end_at;
    else
      next_at := cursor_at + (phase_dur * interval '1 minute');
      if next_at > p_end_at then
        next_at := p_end_at;
      end if;
    end if;

    if next_at <= cursor_at then
      exit;
    end if;

    for pool_text in
      select value
        from jsonb_array_elements_text(phase->'pool_ids')
    loop
      select capacity into pool_cap
        from public.lng_booking_resource_pools
       where id = pool_text;

      if pool_cap is null then
        continue;
      end if;

      -- active set includes 'joined' (restored — see header).
      select count(*) into cnt
        from public.lng_appointment_phases ap
        join public.lng_appointments a on a.id = ap.appointment_id
       where a.location_id = p_location_id
         and a.status in ('booked', 'arrived', 'joined')
         and ap.status in ('pending', 'in_progress')
         and (p_exclude_appointment_id is null or a.id <> p_exclude_appointment_id)
         and ap.start_at < next_at
         and ap.end_at   > cursor_at
         and pool_text   = any(ap.pool_ids);

      if cnt + 1 > pool_cap then
        conflict_kind     := 'pool_at_capacity';
        pool_id           := pool_text;
        pool_capacity     := pool_cap;
        current_count     := cnt;
        phase_index       := (phase->>'phase_index')::int;
        phase_label       := phase->>'label';
        conflict_start_at := cursor_at;
        conflict_end_at   := next_at;
        return next;
      end if;
    end loop;

    cursor_at := next_at;
    exit when cursor_at >= p_end_at;
  end loop;

  -- Whole-appointment max_concurrent — same status set.
  select c.max_concurrent into max_concurrent_for_s
    from public.lng_booking_type_config c
   where c.service_type    = p_service_type
     and c.repair_variant is null
     and c.product_key    is null
     and c.arch           is null
   limit 1;

  if max_concurrent_for_s is not null then
    select count(*) into cnt
      from public.lng_appointments a
     where a.location_id  = p_location_id
       and a.start_at    <  p_end_at
       and a.end_at      >  p_start_at
       and a.status in ('booked', 'arrived', 'joined')
       and a.service_type = p_service_type
       and (p_exclude_appointment_id is null or a.id <> p_exclude_appointment_id);
    if cnt + 1 > max_concurrent_for_s then
      conflict_kind     := 'max_concurrent';
      pool_id           := null;
      pool_capacity     := max_concurrent_for_s;
      current_count     := cnt;
      phase_index       := null;
      phase_label       := null;
      conflict_start_at := p_start_at;
      conflict_end_at   := p_end_at;
      return next;
    end if;
  end if;

  return;
end;
$function$;


comment on function public.lng_booking_check_conflict(uuid, text, timestamptz, timestamptz, uuid, text, text, text) is
  'Phase-aware pool conflict checker. Excludes virtual_impression_appointment (added 20260610000002): virtual is governed solely by the per-clinician model (lng_clinicians_available + lng_virtual_clinician_guard_trg). Active set = booked/arrived/joined. Also enforces min_notice.';

NOTIFY pgrst, 'reload schema';

-- ── Rollback ──────────────────────────────────────────────────────
-- Remove the early-return for virtual_impression_appointment (re-apply
-- the prior definition). Note this reinstates the false-conflict bug.
