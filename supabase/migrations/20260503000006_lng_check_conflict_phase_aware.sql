-- 20260503000006_lng_check_conflict_phase_aware.sql
--
-- ADR-006 / slice doc `docs/slices/booking-phases.md` — M5.
--
-- Rewrites lng_booking_check_conflict to walk the per-phase pool
-- consumption introduced by M1/M2 instead of the whole-block service
-- pool list. The conflict checker now answers the question that
-- matches operational reality:
--
--   "For each pool the candidate's PHASE consumes, count overlapping
--    EXISTING phase rows that consume the same pool. If count + 1
--    exceeds capacity → conflict."
--
-- Two real-world examples this fixes:
--
--   1. Denture repair has [15m active patient-in-chair] +
--      [20m bench, chair free]. Today's checker holds the chair for
--      35 minutes; the new checker holds the chair only for the
--      first 15. Two repairs starting 20 min apart now correctly
--      fit two chairs.
--
--   2. Click-in Veneers has [30m chair] + [4h lab bench, no chair]
--      + [20m chair]. Today's checker holds chair + lab for the
--      whole 5h window; the new checker correctly frees the chair
--      during the lab phase, so a denture repair can take that
--      chair without a false-positive conflict.
--
-- ── New signature ─────────────────────────────────────────────────
-- Adds three optional child-key params (repair_variant, product_key,
-- arch) so the resolver can pick up per-child duration overrides
-- when one applies. Returns three new fields per conflict:
--
--   phase_index     — which of the candidate's phases hit the limit
--   phase_label     — human-readable label of that phase
--   conflict_start_at,
--   conflict_end_at — the time bounds of the specific phase
--                     overlap, so the reschedule sheet can phrase
--                     the conflict in operator language ("Lab
--                     bench busy 14:00 to 17:30"). Returned as two
--                     separate timestamps (rather than a tstzrange)
--                     so the client doesn't need a range parser.
--
-- The legacy fields (conflict_kind, pool_id, pool_capacity,
-- current_count) are unchanged so existing client-side callers keep
-- working until they're updated to render the new fields.
--
-- ── Status semantics ──────────────────────────────────────────────
-- "Active" appointments = status in (booked, arrived, in_progress).
-- Same as before. Cancelled/no_show/complete/rescheduled don't
-- contribute to conflict counts.
--
-- "Active" phases = status in (pending, in_progress). Phases marked
-- complete or skipped don't count — they've already happened or
-- been waived. This is the per-phase analogue of the appointment
-- status filter.
--
-- ── Idempotency ───────────────────────────────────────────────────
-- DROP FUNCTION + CREATE OR REPLACE. Safe to re-run.

drop function if exists public.lng_booking_check_conflict(uuid, text, timestamptz, timestamptz, uuid);
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
begin
  -- ── Resolve candidate's phase shape ──
  select phases, block_duration_minutes
    into resolved
    from public.lng_booking_type_resolve(
      p_service_type, p_repair_variant, p_product_key, p_arch
    );

  if resolved.phases is null
     or jsonb_array_length(resolved.phases) = 0 then
    -- No phases configured for this service. Without phase data we
    -- have nothing to check pool consumption against. Return empty
    -- (no conflicts known); the caller treats this as "slot is
    -- free" which mirrors today's behaviour for a service with no
    -- pool list.
    return;
  end if;

  select max((elt->>'phase_index')::int)
    into max_phase_idx
    from jsonb_array_elements(resolved.phases) elt;

  cursor_at := p_start_at;

  -- ── Per-candidate-phase pool capacity checks ──
  for phase in select elt
                 from jsonb_array_elements(resolved.phases) elt
                order by (elt->>'phase_index')::int
  loop
    phase_dur := coalesce((phase->>'duration_default')::int, 0);

    -- Compute this candidate phase's [cursor_at, next_at) using the
    -- same elastic-final-phase rule as
    -- lng_materialise_appointment_phases — the candidate's
    -- materialised phases will end at p_end_at exactly, so the
    -- final phase absorbs any drift.
    if (phase->>'phase_index')::int = max_phase_idx then
      next_at := p_end_at;
    else
      next_at := cursor_at + (phase_dur * interval '1 minute');
      if next_at > p_end_at then
        next_at := p_end_at;
      end if;
    end if;

    if next_at <= cursor_at then
      -- Earlier phases consumed the whole window. Stop iterating.
      exit;
    end if;

    -- For each pool the candidate's phase consumes, count
    -- overlapping existing phase rows that consume the same pool.
    for pool_text in
      select value
        from jsonb_array_elements_text(phase->'pool_ids')
    loop
      select capacity into pool_cap
        from public.lng_booking_resource_pools
       where id = pool_text;

      -- Defensive: pool was deleted but still referenced. Skip.
      if pool_cap is null then
        continue;
      end if;

      select count(*) into cnt
        from public.lng_appointment_phases ap
        join public.lng_appointments a on a.id = ap.appointment_id
       where a.location_id = p_location_id
         and a.status in ('booked', 'arrived', 'in_progress')
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

  -- ── Per-service max_concurrent (whole-appointment overlap) ──
  -- Unchanged semantics: count appointments of the same service that
  -- overlap [p_start_at, p_end_at] in time. max_concurrent is a cap
  -- on simultaneous bookings of THIS service, independent of the
  -- pool model.
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
       and a.status in ('booked', 'arrived', 'in_progress')
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
  'Phase-aware booking conflict checker. Resolves the candidate''s phase shape, then per-phase counts overlapping lng_appointment_phases rows that consume the same pool. Returns one row per conflict with phase_index, phase_label, and conflict_window so callers can render operator-language copy ("Lab bench busy 14:00–17:30 (Click-in Veneers, Lab fabrication)"). Optional repair_variant/product_key/arch params let it pick up child-config duration overrides. See ADR-006.';

-- ── Rollback ──────────────────────────────────────────────────────
-- The previous version of this function was last shipped in
-- 20260501000005_lng_booking_conflict_check.sql; re-apply that file
-- to restore.
