-- 20260514000002_lng_booking_slots_lunch_and_end.sql
--
-- Two corrections to lng_booking_available_slots (introduced
-- yesterday in 20260514000001):
--
--   1. Honour an optional lunch break on the resolved working hours.
--      The widget RPC has done this for weeks; the staff one didn't.
--      Reads `working_hours -> dow_key -> 'break'` as either null or
--      a `{ "start": "HH:MM", "end": "HH:MM" }` object. Slots whose
--      START falls inside the break window are skipped. Slots that
--      *span* the break still appear — same rule the widget uses, so
--      a 60-min appointment starting at 11:30 isn't forbidden by a
--      12:00–13:00 lunch.
--
--   2. Refuse slots whose patient-affecting END lands past close. A
--      90-min same-day appliance whose phases sum to 135 (Book-in 5
--      + Impression 5 + Manufacture 2h + Try-in 5) puts the patient
--      back at minute 135 for the Try-in. The conflict check only
--      sees the 90-min appointment block, so the receptionist could
--      pick 16:15 with a 17:00 close and watch ReturnSegmentHints
--      render "Patient back at 18:25 for Try-in" — clinic shut.
--      End-vs-close uses the GREATER of duration_default (the
--      appointment block) and block_duration_minutes (phase sum) so
--      the last patient-facing minute is the one that gates the
--      slot.
--
-- Signature is unchanged so the JS wrapper at
-- src/lib/queries/bookingAvailableSlots.ts and the staff sheets are
-- untouched. `drop function` is conditional to keep this re-runnable
-- against a fresh shadow.
--
-- Rollback: re-apply 20260514000001's CREATE OR REPLACE definition.

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
  v_resolved       record;
  v_duration       int;
  v_extent         int;  -- minutes from start to the last patient-facing point
  v_dow            int;
  v_dow_key        text;
  v_day_hours      jsonb;
  v_break          jsonb;
  v_open_hour      int;
  v_open_min       int;
  v_close_hour     int;
  v_close_min      int;
  v_open_total     int;
  v_close_total    int;
  v_break_start    int;
  v_break_end      int;
  v_minute_total   int;
  v_hour           int;
  v_minute         int;
  v_cand_start     timestamptz;
  v_cand_end       timestamptz;
  v_close_at       timestamptz;
  v_has_conflict   boolean;
begin
  -- ── Resolve duration + working_hours via the canonical resolver ──
  select working_hours, duration_default, block_duration_minutes
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
  -- Extent = the last patient-facing minute. For services without
  -- post-block phases (block_duration_minutes <= duration_default),
  -- this is just duration_default. For same-day appliance / virtual
  -- impression where the block is shorter than the phase sum (the
  -- final Try-in lands after the in-clinic block), it's the phase
  -- sum so the slot rejection lines up with what ReturnSegmentHints
  -- shows the receptionist.
  v_extent := greatest(
    v_resolved.duration_default,
    coalesce(v_resolved.block_duration_minutes, v_resolved.duration_default)
  );

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

  v_close_at := timezone('Europe/London',
    (p_date + make_time(v_close_hour, v_close_min, 0))::timestamp);

  -- ── Optional lunch break ─────────────────────────────────────────
  -- `break` is { start, end }; both fields required if the key is
  -- present. Ignore the break when start >= end (defensive; the form
  -- now refuses to save those, but legacy rows might exist).
  v_break := v_day_hours -> 'break';
  v_break_start := null;
  v_break_end   := null;
  if v_break is not null and v_break <> 'null'::jsonb then
    v_break_start := (split_part(v_break ->> 'start', ':', 1)::int) * 60
                   + (split_part(v_break ->> 'start', ':', 2)::int);
    v_break_end   := (split_part(v_break ->> 'end',   ':', 1)::int) * 60
                   + (split_part(v_break ->> 'end',   ':', 2)::int);
    if v_break_end <= v_break_start then
      v_break_start := null;
      v_break_end   := null;
    end if;
  end if;

  -- ── Walk the grid ────────────────────────────────────────────────
  v_minute_total := v_open_total;
  while v_minute_total < v_close_total loop
    v_hour   := v_minute_total / 60;
    v_minute := v_minute_total % 60;

    -- Skip starts inside the lunch break.
    if v_break_start is not null
       and v_minute_total >= v_break_start
       and v_minute_total <  v_break_end then
      v_minute_total := v_minute_total + p_step_minutes;
      continue;
    end if;

    v_cand_start := timezone('Europe/London',
      (p_date + make_time(v_hour, v_minute, 0))::timestamp);
    v_cand_end := v_cand_start + make_interval(mins => v_duration);

    -- Refuse slots whose latest patient-facing minute (block end OR
    -- post-block return) lands past close. v_extent already captures
    -- the GREATER of the two so a single comparison covers both.
    if v_cand_start + make_interval(mins => v_extent) > v_close_at then
      v_minute_total := v_minute_total + p_step_minutes;
      continue;
    end if;

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
  'Staff-side availability resolver. Returns HH:MM slots within the resolved working_hours for p_date, minus any start that falls inside the optional lunch break and any slot whose end would land past close. Reuses lng_booking_check_conflict for the conflict filter. Optional p_exclude_appointment_id supports the Reschedule sheet.';
