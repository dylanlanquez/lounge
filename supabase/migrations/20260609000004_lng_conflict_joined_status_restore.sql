-- 20260609000004_lng_conflict_joined_status_restore.sql
--
-- Restores 'joined' to the active-appointment set in
-- lng_booking_check_conflict — a regression, not a new feature.
--
-- History:
--   • 20260518000006 added 'joined' (the virtual analogue of 'arrived')
--     to both status filters in lng_booking_check_conflict, and dropped
--     the retired 'in_progress' (forbidden by the column CHECK since
--     20260505000004). Without 'joined', a joined virtual appointment is
--     invisible to overlap detection.
--   • 20260523000003 (the min-notice rewrite) was built by copying the
--     older 20260503000006 body and adding the notice gate. That copy
--     carried the pre-fix status set, silently reverting 20260518000006
--     — re-introducing ('booked','arrived','in_progress').
--
-- This migration re-applies the 20260523000003 body verbatim (min-notice
-- gate preserved) with the only change being the status set restored to
-- ('booked','arrived','joined') in both the per-phase pool count and the
-- whole-appointment max_concurrent count.
--
-- Standalone and separable from the clinician-hours feature: the virtual
-- host-overlap guard (20260609000003) already counts 'joined', so virtual
-- double-booking is covered regardless. This fixes the in-person checker
-- so any joined virtual row is visible to pool/max_concurrent overlap
-- detection again.
--
-- Apply order: shadow first (verify), then Meridian.
-- Rollback: re-apply 20260523000003_lng_check_conflict_notice.sql.

drop function if exists public.lng_booking_check_conflict(uuid, text, timestamptz, timestamptz, uuid, text, text, text);

create or replace function public.lng_booking_check_conflict(
  p_location_id            uuid,
  p_service_type           text,
  p_start_at               timestamptz,
  p_end_at                 timestamptz,
  p_exclude_appointment_id uuid default null,
  p_repair_variant         text default null,
  p_product_key            text default null,
  p_arch                   text default null
)
returns table (
  conflict_kind     text,
  pool_id           text,
  pool_capacity     int,
  current_count     int,
  phase_index       int,
  phase_label       text,
  conflict_start_at timestamptz,
  conflict_end_at   timestamptz
)
language plpgsql
stable
security invoker
set search_path = public
as $$
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
$$;

revoke all on function public.lng_booking_check_conflict(uuid, text, timestamptz, timestamptz, uuid, text, text, text) from public;
grant execute on function public.lng_booking_check_conflict(uuid, text, timestamptz, timestamptz, uuid, text, text, text) to authenticated;

comment on function public.lng_booking_check_conflict(uuid, text, timestamptz, timestamptz, uuid, text, text, text) is
  'Phase-aware booking conflict checker. Active appointments = status in (booked, arrived, joined). Emits min_notice (notice window), pool_at_capacity (per overlapping phase pool), max_concurrent (whole-appointment cap). joined restored in 20260609000004 after 20260523000003 inadvertently reverted 20260518000006. See ADR-006.';

NOTIFY pgrst, 'reload schema';
