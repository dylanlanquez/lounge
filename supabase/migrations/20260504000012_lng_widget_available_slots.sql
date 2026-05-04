-- ─────────────────────────────────────────────────────────────────────────────
-- Lounge — widget availability resolver
--
-- The customer-facing booking widget needs to show only slots the
-- clinic actually has free for the patient's chosen service. Until
-- now the widget generated slots client-side (src/widget/data.ts
-- generateSlots), so a patient could pick a slot that was already
-- booked and only find out at submit time when the conflict check
-- fired. That's correct, just ugly.
--
-- This function generates the same candidate grid the client used
-- (15-min step, opening hours hardcoded to match the stub) and
-- filters each candidate through the existing phase-aware
-- lng_booking_check_conflict — so the widget shows real availability
-- instead of a static time table.
--
-- Opening hours intentionally hardcoded for now: the v1 widget runs
-- single-clinic and these match the stub. Phase 6 multi-location
-- will move opening hours into lng_settings.clinic.opening_hours and
-- this function will read from there.
--
-- SECURITY DEFINER + GRANT EXECUTE TO anon: the patient is unauth'd
-- when calling this, so the function bypasses the lng_appointments
-- RLS that would otherwise hide all rows from the conflict check.
-- The function returns only timestamptz, never any patient PII.
--
-- Rollback:
--   drop function public.lng_widget_available_slots(uuid, text, date, text, text, text);
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.lng_widget_available_slots(
  p_location_id    uuid,
  p_service_type   text,
  p_date           date,
  p_repair_variant text default null,
  p_product_key    text default null,
  p_arch           text default null
)
returns table (start_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_resolved      record;
  v_duration      int;
  v_dow           int;
  v_open_hour     int;
  v_close_hour    int;
  v_skip_lunch    boolean;
  v_step_minutes  int := 15;
  v_hour          int;
  v_minute        int;
  v_cand_start    timestamptz;
  v_cand_end      timestamptz;
  v_close_at      timestamptz;
  v_has_conflict  boolean;
  v_location_id   uuid;
begin
  -- Phase 2c widget runs single-location. The client doesn't know
  -- the real Glasgow Lounge UUID (WIDGET_LOCATIONS uses a stub id),
  -- so accept null and resolve to the default Venneir lab — same
  -- fallback the widget-create-appointment edge function uses.
  if p_location_id is null then
    select id into v_location_id
    from public.locations
    where type = 'lab' and is_venneir = true
    order by name asc
    limit 1;
    if v_location_id is null then
      return;
    end if;
  else
    v_location_id := p_location_id;
  end if;
  -- Duration via the booking-type resolver (child overrides apply
  -- to the same axis pins the staff createAppointment uses).
  select * into v_resolved
  from public.lng_booking_type_resolve(
    p_service_type,
    p_repair_variant,
    p_product_key,
    p_arch
  );
  if v_resolved is null or v_resolved.duration_default is null then
    return;
  end if;
  v_duration := v_resolved.duration_default;

  -- Opening hours: Sunday closed, Saturday 10–16, weekdays 9–18 with
  -- a 13–14 lunch closure. extract(dow) returns 0=Sun, 6=Sat.
  v_dow := extract(dow from p_date)::int;
  if v_dow = 0 then
    return;
  end if;
  if v_dow = 6 then
    v_open_hour  := 10;
    v_close_hour := 16;
    v_skip_lunch := false;
  else
    v_open_hour  := 9;
    v_close_hour := 18;
    v_skip_lunch := true;
  end if;

  v_close_at := timezone('Europe/London',
    (p_date + make_time(v_close_hour, 0, 0))::timestamp);

  v_hour := v_open_hour;
  while v_hour < v_close_hour loop
    v_minute := 0;
    while v_minute < 60 loop
      -- Skip starts during the lunch hour entirely (matches the
      -- client-side stub). Slots that *span* lunch are still
      -- allowed if the candidate start is before 13:00 — same
      -- behaviour as generateSlots in src/widget/data.ts.
      if not (v_skip_lunch and v_hour = 13) then
        v_cand_start := timezone('Europe/London',
          (p_date + make_time(v_hour, v_minute, 0))::timestamp);
        v_cand_end := v_cand_start + make_interval(mins => v_duration);

        -- Slot must finish before close.
        if v_cand_end <= v_close_at then
          select exists (
            select 1
            from public.lng_booking_check_conflict(
              v_location_id,
              p_service_type,
              v_cand_start,
              v_cand_end,
              null,
              p_repair_variant,
              p_product_key,
              p_arch
            )
          ) into v_has_conflict;

          if not v_has_conflict then
            start_at := v_cand_start;
            return next;
          end if;
        end if;
      end if;
      v_minute := v_minute + v_step_minutes;
    end loop;
    v_hour := v_hour + 1;
  end loop;
  return;
end;
$$;

revoke all on function public.lng_widget_available_slots(uuid, text, date, text, text, text) from public;
grant execute on function public.lng_widget_available_slots(uuid, text, date, text, text, text) to anon, authenticated, service_role;

comment on function public.lng_widget_available_slots(uuid, text, date, text, text, text) is
  'Customer-facing booking widget availability resolver. Returns the candidate start times for p_date that are within opening hours (Sun closed, Sat 10–16, weekdays 9–18 minus 13–14 lunch) and clear of any conflicts per lng_booking_check_conflict. Opening hours hardcoded for the single-clinic v1; phase 6 will read from lng_settings.clinic.opening_hours.';
