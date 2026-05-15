-- 20260515000006_lng_widget_available_slots_phase_duration_fallback.sql
--
-- Bug: virtual_impression_appointment shows "no availability ever" on
-- both the booking widget and the staff New Booking sheet.
--
-- Root cause: lng_booking_type_config.duration_default is NULL for
-- virtual_impression_appointment because the appointment's actual
-- length is computed from its phases (the "Video call" phase
-- declares duration_default=20, surfacing as
-- block_duration_minutes=20 on the resolver). The slot scanner
-- (lng_widget_available_slots) bails out on NULL duration_default,
-- so it returns zero candidates and every downstream surface
-- (the slot list, lng_widget_first_available, lng_widget_available_dates)
-- thinks the service is fully booked forever.
--
-- Fix: fall back to block_duration_minutes when duration_default is
-- null. block_duration_minutes is the SUM of phases[].duration_default
-- (the actual block the calendar holds for the appointment), so it's
-- the natural source of truth when the parent column wasn't set.
-- Bail only when BOTH are null — that's a genuine "this booking
-- type has no duration" misconfiguration the operator should fix in
-- admin, not silently absorb.
--
-- The function's existing v_extent calculation already coalesces to
-- block_duration_minutes for the "post-block extent" check, so this
-- change is internally consistent — duration and extent now agree
-- on the same fallback source.
--
-- Apply order per CLAUDE.md: shadow first, then production.
-- Rollback: re-run the prior version of the function (find in
-- supabase/migrations/2026050*_lng_widget_available_slots*.sql).

create or replace function public.lng_widget_available_slots(
  p_location_id          uuid,
  p_service_type         text,
  p_date                 date,
  p_repair_variant       text default null,
  p_product_key          text default null,
  p_arch                 text default null,
  p_exclude_appointment_id uuid default null
)
returns table(start_at timestamp with time zone)
language plpgsql
security definer
set search_path = public
as $function$
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
  -- Coalesce to phase-derived block when the parent's duration_default
  -- isn't set. Virtual-impression appointments and any other
  -- phase-driven service get their slot scan unblocked by this
  -- without changing per-row admin config.
  v_duration := coalesce(v_resolved.duration_default, v_resolved.block_duration_minutes);
  if v_resolved is null or v_duration is null then
    return;
  end if;
  v_extent := greatest(
    v_duration,
    coalesce(v_resolved.block_duration_minutes, v_duration)
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
$function$;

comment on function public.lng_widget_available_slots(uuid, text, date, text, text, text, uuid) is
  'Bookable slots for a service on a given date. Uses duration_default when set, else falls back to block_duration_minutes (sum of phases) so phase-driven services like virtual_impression_appointment surface availability. Honours conflict check, past-time filter, lunch-break skip, and post-block extent check.';
