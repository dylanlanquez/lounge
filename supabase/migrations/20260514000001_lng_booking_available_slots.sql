-- 20260514000001_lng_booking_available_slots.sql
--
-- Staff-side availability resolver for the Schedule's "New booking"
-- and "Reschedule" sheets. Sibling to lng_widget_available_slots
-- (which is for the unauth'd customer widget). Same idea: walk the
-- day's grid in step_minutes increments, filter each candidate
-- through lng_booking_check_conflict, return only the survivors so
-- the TimePicker can render real availability instead of every slot
-- and a "this one's actually booked" banner.
--
-- Differences vs the widget function:
--   * Reads working_hours from lng_booking_type_resolve, not a
--     hardcoded weekday table — staff bookings honour the same
--     admin-configured hours that the conflict check uses.
--   * Accepts an optional exclude_appointment_id so the Reschedule
--     sheet can show its current slot as "available" (the row being
--     moved doesn't conflict with itself).
--   * Returns HH:MM 24-hour strings (text) so the TimePicker can
--     match them to its grid without per-call timezone arithmetic
--     on the client. The conflict check still runs against the
--     correct timestamptz; the string is the pre-computed grid key.
--   * security invoker + authenticated only — staff-only feature,
--     no anon access. RLS on lng_appointments / lng_appointment_phases
--     still applies inside the conflict check (the staff member can
--     only see slots taken by patients at their own location).
--
-- Rollback:
--   drop function public.lng_booking_available_slots(
--     uuid, text, date, uuid, text, text, text, int);

drop function if exists public.lng_booking_available_slots(uuid, text, date, uuid, text, text, text, int);

create or replace function public.lng_booking_available_slots(
  p_location_id            uuid,
  p_service_type           text,
  p_date                   date,
  p_exclude_appointment_id uuid default null,
  p_repair_variant         text default null,
  p_product_key            text default null,
  p_arch                   text default null,
  p_step_minutes           int  default 15
)
returns table (slot_local text)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_resolved      record;
  v_duration      int;
  v_dow           int;
  v_dow_key       text;
  v_day_hours     jsonb;
  v_open_hour     int;
  v_open_min      int;
  v_close_hour    int;
  v_close_min     int;
  v_open_total    int;
  v_close_total   int;
  v_minute_total  int;
  v_hour          int;
  v_minute        int;
  v_cand_start    timestamptz;
  v_cand_end      timestamptz;
  v_has_conflict  boolean;
begin
  -- ── Resolve duration + working_hours via the canonical resolver ──
  -- Same source of truth the NewBookingSheet reads on the client,
  -- so a child override (denture repair_variant, product_key, arch)
  -- shifts both the slot grid AND the conflict-check window in lock
  -- step.
  select working_hours, duration_default
    into v_resolved
    from public.lng_booking_type_resolve(
      p_service_type,
      p_repair_variant,
      p_product_key,
      p_arch
    );

  if v_resolved is null
     or v_resolved.duration_default is null
     or v_resolved.working_hours is null then
    return;
  end if;
  v_duration := v_resolved.duration_default;

  -- ── Map Postgres dow (0=Sun..6=Sat) to our jsonb key ─────────────
  v_dow := extract(dow from p_date)::int;
  v_dow_key := case v_dow
    when 1 then 'mon'
    when 2 then 'tue'
    when 3 then 'wed'
    when 4 then 'thu'
    when 5 then 'fri'
    when 6 then 'sat'
    when 0 then 'sun'
  end;

  v_day_hours := v_resolved.working_hours -> v_dow_key;
  if v_day_hours is null or v_day_hours = 'null'::jsonb then
    -- Closed that day per admin config.
    return;
  end if;

  -- ── Parse open / close as 'HH:MM' into minute counts ─────────────
  v_open_hour  := split_part(v_day_hours ->> 'open',  ':', 1)::int;
  v_open_min   := split_part(v_day_hours ->> 'open',  ':', 2)::int;
  v_close_hour := split_part(v_day_hours ->> 'close', ':', 1)::int;
  v_close_min  := split_part(v_day_hours ->> 'close', ':', 2)::int;
  v_open_total  := v_open_hour  * 60 + v_open_min;
  v_close_total := v_close_hour * 60 + v_close_min;

  if v_close_total <= v_open_total then
    return;
  end if;

  -- ── Walk the grid ────────────────────────────────────────────────
  -- Match the staff sheet's existing inWorkingHours rule: start time
  -- must lie within [open, close). End time is not constrained — a
  -- 60-min booking starting at 17:45 against an 18:00 close is
  -- allowed today and stays allowed here so the picker doesn't
  -- silently disappear slots the form would otherwise let you pick.
  v_minute_total := v_open_total;
  while v_minute_total < v_close_total loop
    v_hour   := v_minute_total / 60;
    v_minute := v_minute_total % 60;

    v_cand_start := timezone('Europe/London',
      (p_date + make_time(v_hour, v_minute, 0))::timestamp);
    v_cand_end := v_cand_start + make_interval(mins => v_duration);

    select exists (
      select 1
      from public.lng_booking_check_conflict(
        p_location_id,
        p_service_type,
        v_cand_start,
        v_cand_end,
        p_exclude_appointment_id,
        p_repair_variant,
        p_product_key,
        p_arch
      )
    ) into v_has_conflict;

    if not v_has_conflict then
      slot_local := lpad(v_hour::text,   2, '0')
                 || ':'
                 || lpad(v_minute::text, 2, '0');
      return next;
    end if;

    v_minute_total := v_minute_total + p_step_minutes;
  end loop;

  return;
end;
$$;

revoke all on function public.lng_booking_available_slots(
  uuid, text, date, uuid, text, text, text, int
) from public;
grant execute on function public.lng_booking_available_slots(
  uuid, text, date, uuid, text, text, text, int
) to authenticated;

comment on function public.lng_booking_available_slots(
  uuid, text, date, uuid, text, text, text, int
) is
  'Staff-side availability resolver for the Schedule sheets. Returns HH:MM 24-hour slot strings within the resolved working_hours for p_date that are clear of conflicts per lng_booking_check_conflict. Optional p_exclude_appointment_id lets the Reschedule sheet treat the row being moved as not occupying its current slot.';
