-- 20260501000005_lng_booking_conflict_check.sql
--
-- The conflict-check function the reschedule flow (PR-6) and the
-- future "book new appointment" flow will call to vet a candidate
-- slot. Plus the column the function reads from to know what each
-- existing booking is consuming.
--
-- ── Why this column exists on lng_appointments ─────────────────────
--
-- The conflict checker compares a candidate booking against every
-- already-booked appointment that overlaps it in time. To know
-- whether two bookings can co-exist, the checker has to know what
-- pools each one consumes. That mapping lives on the *service type*
-- (lng_booking_service_pools), which means each appointment has to
-- carry its own service_type so the join works.
--
-- For Lounge-native bookings (the future), service_type will be set
-- at insert time by the booking flow. For legacy Calendly imports
-- the column was never populated; this migration backfills it
-- best-effort from event_type_label and leaves anything we can't
-- infer as 'other' (consumes consult-room only — the conservative
-- assumption that keeps the conflict checker honest without
-- blocking every reschedule on stale data).
--
-- ── Conflict semantics ─────────────────────────────────────────────
--
-- Two rules, both must pass:
--
--   1. Pool capacity. For every pool the candidate's service
--      consumes, count appointments that overlap [start, end] in
--      time AND consume the same pool. If count + 1 > capacity, the
--      candidate is blocked.
--
--   2. Per-service max_concurrent. If the service has max_concurrent
--      set, count appointments of the same service overlapping in
--      time. If count + 1 > max_concurrent, the candidate is
--      blocked.
--
-- "Overlap" excludes terminal statuses (cancelled / no_show /
-- complete / rescheduled) and the optionally-excluded appointment
-- id (so a reschedule-in-place can vet the candidate against
-- everything *else*).

-- ── 1. service_type on lng_appointments ────────────────────────────

alter table public.lng_appointments
  add column if not exists service_type text
    check (
      service_type is null
      or service_type in (
        'denture_repair',
        'click_in_veneers',
        'same_day_appliance',
        'impression_appointment',
        'other'
      )
    );

-- Best-effort backfill from event_type_label. Strict matching on
-- known phrases; everything else falls to 'other' so the conflict
-- checker has *some* pool list to consult.
update public.lng_appointments
   set service_type = case
     when event_type_label ilike '%denture%repair%'         then 'denture_repair'
     when event_type_label ilike '%click%in%veneer%'        then 'click_in_veneers'
     when event_type_label ilike '%same%day%appliance%'
       or event_type_label ilike '%retainer%'
       or event_type_label ilike '%night%guard%'
       or event_type_label ilike '%day%guard%'
       or event_type_label ilike '%whitening%'              then 'same_day_appliance'
     when event_type_label ilike '%impression%'             then 'impression_appointment'
     else                                                       'other'
   end
 where service_type is null;

-- Compound index for the overlap probe. Filters on location +
-- active statuses + the time range; the conflict-check query hits
-- this on every reschedule attempt.
create index if not exists lng_appointments_overlap_idx
  on public.lng_appointments (location_id, start_at, end_at)
  where status in ('booked', 'arrived', 'in_progress');

comment on column public.lng_appointments.service_type is
  'Categorical service for conflict checking. Set at insert time for Lounge-native bookings; backfilled best-effort from event_type_label for legacy Calendly imports (unknown labels default to ''other'').';

-- ── 2. Conflict-check function ────────────────────────────────────
--
-- Returns one row per conflict. An empty result means the slot is
-- free. The caller renders the conflict reasons inline in the
-- reschedule sheet.

drop function if exists public.lng_booking_check_conflict(
  uuid, text, timestamptz, timestamptz, uuid
);

create or replace function public.lng_booking_check_conflict(
  p_location_id            uuid,
  p_service_type           text,
  p_start_at               timestamptz,
  p_end_at                 timestamptz,
  p_exclude_appointment_id uuid default null
)
returns table (
  conflict_kind   text,            -- 'pool_at_capacity' | 'max_concurrent'
  pool_id         text,            -- non-null only for 'pool_at_capacity'
  pool_capacity   int,
  current_count   int
)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  pool_row              record;
  cnt                   int;
  max_concurrent_for_s  int;
begin
  -- Pool capacity checks: one count per consumed pool.
  for pool_row in
    select sp.pool_id as pid, rp.capacity as cap
      from public.lng_booking_service_pools sp
      join public.lng_booking_resource_pools rp on rp.id = sp.pool_id
     where sp.service_type = p_service_type
  loop
    select count(*) into cnt
      from public.lng_appointments a
      join public.lng_booking_service_pools sp2 on sp2.service_type = a.service_type
     where a.location_id = p_location_id
       and a.start_at < p_end_at
       and a.end_at   > p_start_at
       and a.status in ('booked', 'arrived', 'in_progress')
       and (p_exclude_appointment_id is null or a.id <> p_exclude_appointment_id)
       and sp2.pool_id = pool_row.pid;
    if cnt + 1 > pool_row.cap then
      conflict_kind := 'pool_at_capacity';
      pool_id       := pool_row.pid;
      pool_capacity := pool_row.cap;
      current_count := cnt;
      return next;
    end if;
  end loop;

  -- Per-service max_concurrent (resolved from the parent row only;
  -- per-child overrides aren't applied to the appointment-level
  -- counter in v1 since the appointment has no child key).
  select c.max_concurrent into max_concurrent_for_s
    from public.lng_booking_type_config c
   where c.service_type = p_service_type
     and c.repair_variant is null
     and c.product_key is null
     and c.arch is null
   limit 1;

  if max_concurrent_for_s is not null then
    select count(*) into cnt
      from public.lng_appointments a
     where a.location_id = p_location_id
       and a.start_at < p_end_at
       and a.end_at   > p_start_at
       and a.status in ('booked', 'arrived', 'in_progress')
       and a.service_type = p_service_type
       and (p_exclude_appointment_id is null or a.id <> p_exclude_appointment_id);
    if cnt + 1 > max_concurrent_for_s then
      conflict_kind := 'max_concurrent';
      pool_id       := null;
      pool_capacity := max_concurrent_for_s;
      current_count := cnt;
      return next;
    end if;
  end if;

  return;
end;
$$;

revoke all on function public.lng_booking_check_conflict(uuid, text, timestamptz, timestamptz, uuid) from public;
grant execute on function public.lng_booking_check_conflict(uuid, text, timestamptz, timestamptz, uuid) to authenticated;

comment on function public.lng_booking_check_conflict(uuid, text, timestamptz, timestamptz, uuid) is
  'Conflict checker for the reschedule and new-booking flows. Returns one row per conflict (empty = slot is free). Two rules: pool capacity (per consumed pool) and per-service max_concurrent. Optional p_exclude_appointment_id lets a reschedule-in-place vet against everything *else*.';

-- ── Rollback ───────────────────────────────────────────────────────
-- drop function if exists public.lng_booking_check_conflict(uuid, text, timestamptz, timestamptz, uuid);
-- drop index if exists public.lng_appointments_overlap_idx;
-- alter table public.lng_appointments drop column if exists service_type;
