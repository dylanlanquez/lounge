-- Past-time filter for lng_widget_available_slots
--
-- The widget's slot generator iterates from clinic-open to
-- clinic-close and returns every non-conflicting candidate. It
-- doesn't know about the current clock time, so asking for today's
-- slots at 5pm still returns 9am, 10am, … — every slot that
-- *would* have been available if asked at midnight. Two callers
-- pay for this:
--
--   • lng_widget_first_available iterates day-by-day, takes the
--     first day with a non-empty slot list, and returns its
--     earliest. On today it picks 9am even when 9am is hours past.
--     The customer-facing calendar then pins to today, the client
--     filters all the past slots, and the patient sees "Today's
--     slots have all passed" as the first thing on the picker —
--     instead of being walked forward to the actual next bookable
--     day.
--
--   • The widget's slot list filtered past slots client-side as
--     a defensive measure, but that was a band-aid: it only fixed
--     the visible list, not the first-available scan that drives
--     the initial selectedDate.
--
-- Fix: skip candidates whose start has already arrived. Adds a
-- single predicate to the conditional inside the loop — every
-- other behaviour (conflict check, break-around, post-block
-- extent, lunch skip, opening-hours read) is unchanged.
--
-- Future dates are unaffected: current_timestamp is by definition
-- before any slot on a future date. The customer's clock-skew
-- relative to the server is negligible compared to the 15-minute
-- slot grid — a few seconds of skew can't push a slot from "valid"
-- to "expired" because slot starts are aligned to the quarter-hour.
--
-- Idempotent: full CREATE OR REPLACE, drops the prior signature so
-- a re-apply lands cleanly.
--
-- Rollback: re-apply 20260514000004_lng_widget_slots_parity.sql.

drop function if exists public.lng_widget_available_slots(uuid, text, date, text, text, text, uuid);

create or replace function public.lng_widget_available_slots(
  p_location_id            uuid,
  p_service_type           text,
  p_date                   date,
  p_repair_variant         text default null,
  p_product_key            text default null,
  p_arch                   text default null,
  p_exclude_appointment_id uuid default null
)
returns table (start_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_resolved      record;
  v_duration      int;
  v_extent        int;
  v_dow           int;
  v_step_minutes  int := 15;
  v_cand_start    timestamptz;
  v_cand_end      timestamptz;
  v_close_at      timestamptz;
  v_break_start   timestamptz;
  v_break_end     timestamptz;
  v_has_conflict  boolean;
  v_location_id   uuid;
  v_hours_arr     jsonb;
  v_day           jsonb;
  v_open_text     text;
  v_close_text    text;
  v_break         jsonb;
  v_break_open    text;
  v_break_close   text;
  v_open_minutes  int;
  v_close_minutes int;
  v_minute_of_day int;
  v_now           timestamptz := current_timestamp;
begin
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

  select duration_default, block_duration_minutes
    into v_resolved
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
  v_extent := greatest(
    v_resolved.duration_default,
    coalesce(v_resolved.block_duration_minutes, v_resolved.duration_default)
  );

  select value into v_hours_arr
  from public.lng_settings
  where key = 'clinic.opening_hours' and location_id is null;

  if v_hours_arr is null or jsonb_typeof(v_hours_arr) <> 'array' or jsonb_array_length(v_hours_arr) <> 7 then
    v_hours_arr := jsonb_build_array(
      jsonb_build_object('open', '09:00', 'close', '18:00', 'break', jsonb_build_array('13:00', '14:00')),
      jsonb_build_object('open', '09:00', 'close', '18:00', 'break', jsonb_build_array('13:00', '14:00')),
      jsonb_build_object('open', '09:00', 'close', '18:00', 'break', jsonb_build_array('13:00', '14:00')),
      jsonb_build_object('open', '09:00', 'close', '18:00', 'break', jsonb_build_array('13:00', '14:00')),
      jsonb_build_object('open', '09:00', 'close', '18:00', 'break', jsonb_build_array('13:00', '14:00')),
      jsonb_build_object('open', '10:00', 'close', '16:00'),
      jsonb_build_object('closed', true)
    );
  end if;

  v_dow := extract(dow from p_date)::int;
  v_day := v_hours_arr -> ((v_dow + 6) % 7);

  if v_day is null or (v_day ? 'closed' and (v_day ->> 'closed')::boolean = true) then
    return;
  end if;

  v_open_text  := v_day ->> 'open';
  v_close_text := v_day ->> 'close';
  if v_open_text is null or v_close_text is null then
    return;
  end if;

  v_break := v_day -> 'break';
  if v_break is not null and jsonb_typeof(v_break) = 'array' and jsonb_array_length(v_break) = 2 then
    v_break_open  := v_break ->> 0;
    v_break_close := v_break ->> 1;
  else
    v_break_open  := null;
    v_break_close := null;
  end if;

  v_close_at := timezone('Europe/London', (p_date + v_close_text::time)::timestamp);
  if v_break_open is not null then
    v_break_start := timezone('Europe/London', (p_date + v_break_open::time)::timestamp);
    v_break_end   := timezone('Europe/London', (p_date + v_break_close::time)::timestamp);
  end if;

  v_open_minutes  := extract(hour from v_open_text::time)::int * 60
                   + extract(minute from v_open_text::time)::int;
  v_close_minutes := extract(hour from v_close_text::time)::int * 60
                   + extract(minute from v_close_text::time)::int;

  v_minute_of_day := v_open_minutes;
  while v_minute_of_day < v_close_minutes loop
    v_cand_start := timezone(
      'Europe/London',
      (p_date + make_interval(mins => v_minute_of_day))::timestamp
    );
    v_cand_end := v_cand_start + make_interval(mins => v_duration);

    -- Past-time guard: skip candidates whose start is already in
    -- the past. Future dates are unaffected (every slot is after
    -- v_now by construction). On today, this is what walks the
    -- first-available scan past today when today's openings have
    -- all elapsed — instead of returning today's 9am at 5pm.
    if v_cand_start > v_now
       and v_cand_start + make_interval(mins => v_extent) <= v_close_at
       and (v_break_start is null or v_cand_start < v_break_start or v_cand_start >= v_break_end)
    then
      select exists (
        select 1
        from public.lng_booking_check_conflict(
          v_location_id,
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
        start_at := v_cand_start;
        return next;
      end if;
    end if;

    v_minute_of_day := v_minute_of_day + v_step_minutes;
  end loop;
  return;
end;
$$;

revoke all on function public.lng_widget_available_slots(uuid, text, date, text, text, text, uuid) from public;
grant execute on function public.lng_widget_available_slots(uuid, text, date, text, text, text, uuid) to anon, authenticated, service_role;

comment on function public.lng_widget_available_slots(uuid, text, date, text, text, text, uuid) is
  'Customer-facing booking widget availability resolver. Skips past-time candidates so today only returns slots that haven''t started yet — keeps lng_widget_first_available walking forward when today''s openings have all elapsed. Reads clinic.opening_hours from lng_settings; skips lunch starts; rejects slots whose GREATEST(duration_default, block_duration_minutes) extent lands past close. Optional p_exclude_appointment_id lets the reschedule flow keep the patient''s current slot in the picker.';
