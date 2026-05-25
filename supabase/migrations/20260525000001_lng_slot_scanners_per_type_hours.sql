-- 20260525000001_lng_slot_scanners_per_type_hours.sql
--
-- Fixes a regression introduced by 20260523000002 (min-notice gate)
-- where both slot scanners lost per-booking-type working_hours:
--
--   1. lng_widget_available_slots dropped working_hours from the
--      resolver select and always read lng_settings.clinic.opening_hours.
--      Per-type hours had no effect on the customer widget.
--
--   2. lng_booking_available_slots read working_hours from the resolver
--      but parsed it with object keys ('mon','tue'...) instead of the
--      Mon-first 7-element array indexing the data actually uses.
--      Any booking type with per-type hours returned zero slots on the
--      staff booking sheet.
--
-- Both functions are restored to the correct fallback chain from
-- 20260518000001 (per-type → clinic-wide, array format) with the
-- min-notice gate from 20260523000002 preserved.
--
-- Apply order: shadow first, then Meridian.

-- ─────────────────────────────────────────────────────────────────
-- 1. Customer-side: lng_widget_available_slots
-- ─────────────────────────────────────────────────────────────────

create or replace function public.lng_widget_available_slots(
  p_location_id            uuid,
  p_service_type           text,
  p_date                   date,
  p_repair_variant         text  default null,
  p_product_key            text  default null,
  p_arch                   text  default null,
  p_exclude_appointment_id uuid  default null,
  p_repair_variants        text[] default null
)
returns table(start_at timestamp with time zone)
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_resolved          record;
  v_duration          int;
  v_extent            int;
  v_dow               int;
  v_step_minutes      int := 15;
  v_cand_start        timestamptz;
  v_cand_end          timestamptz;
  v_close_at          timestamptz;
  v_break_start       timestamptz;
  v_break_end         timestamptz;
  v_has_conflict      boolean;
  v_location_id       uuid;
  v_hours_arr         jsonb;
  v_day               jsonb;
  v_open_text         text;
  v_close_text        text;
  v_break             jsonb;
  v_break_open        text;
  v_break_close       text;
  v_open_minutes      int;
  v_close_minutes     int;
  v_minute_of_day     int;
  v_now               timestamptz := current_timestamp;
  v_min_notice        int;
  v_earliest_start    timestamptz;
  v_effective_variant text;
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

  if p_service_type = 'denture_repair'
     and p_repair_variants is not null
     and array_length(p_repair_variants, 1) is not null
  then
    v_effective_variant :=
      public.lng_denture_repair_effective_variant(p_repair_variants);
    if v_effective_variant is null then
      v_effective_variant := p_repair_variant;
    end if;
  else
    v_effective_variant := p_repair_variant;
  end if;

  select duration_default, block_duration_minutes, working_hours, min_notice_minutes
    into v_resolved
    from public.lng_booking_type_resolve(
      p_service_type,
      v_effective_variant,
      p_product_key,
      p_arch
    );

  v_duration := coalesce(v_resolved.duration_default, v_resolved.block_duration_minutes);
  if v_resolved is null or v_duration is null then
    return;
  end if;
  v_extent := greatest(
    v_duration,
    coalesce(v_resolved.block_duration_minutes, v_duration)
  );

  v_min_notice     := coalesce(v_resolved.min_notice_minutes, 0);
  v_earliest_start := v_now + make_interval(mins => v_min_notice);

  -- Per-type hours first, clinic-wide second. Both use the same
  -- Mon-first 7-element array shape.
  v_hours_arr := v_resolved.working_hours;
  if v_hours_arr is null then
    select value into v_hours_arr
      from public.lng_settings
     where key = 'clinic.opening_hours' and location_id is null;
  end if;

  if v_hours_arr is null
     or jsonb_typeof(v_hours_arr) <> 'array'
     or jsonb_array_length(v_hours_arr) <> 7 then
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

    if v_cand_start >= v_earliest_start
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
          v_effective_variant,
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

comment on function public.lng_widget_available_slots(uuid, text, date, text, text, text, uuid, text[]) is
  'Customer widget slot resolver. Effective opening hours = booking-type working_hours (resolver-merged child -> parent) when set, otherwise lng_settings.clinic.opening_hours. Both sources use the same Mon-first 7-element array shape. Cart-aware for denture_repair via lng_denture_repair_effective_variant when p_repair_variants supplied. Honours min_notice_minutes from the resolver. The widget calendar, first-opening banner, time picker, reschedule flow, and Checkpoint Book Appointment modal all inherit this gate.';

-- ─────────────────────────────────────────────────────────────────
-- 2. Staff-side: lng_booking_available_slots
-- ─────────────────────────────────────────────────────────────────

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
  v_extent        int;
  v_dow           int;
  v_hours_arr     jsonb;
  v_day           jsonb;
  v_open_text     text;
  v_close_text    text;
  v_break         jsonb;
  v_break_open    text;
  v_break_close   text;
  v_open_total    int;
  v_close_total   int;
  v_break_start   int;
  v_break_end     int;
  v_close_at      timestamptz;
  v_minute_total  int;
  v_hour          int;
  v_minute        int;
  v_cand_start    timestamptz;
  v_cand_end      timestamptz;
  v_has_conflict  boolean;
  v_now           timestamptz := current_timestamp;
  v_min_notice    int;
  v_earliest_start timestamptz;
begin
  select duration_default, block_duration_minutes, working_hours, min_notice_minutes
    into v_resolved
    from public.lng_booking_type_resolve(
      p_service_type,
      p_repair_variant,
      p_product_key,
      p_arch
    );

  if v_resolved is null then
    return;
  end if;
  v_duration := coalesce(v_resolved.duration_default, v_resolved.block_duration_minutes);
  if v_duration is null then
    return;
  end if;
  v_extent := greatest(
    v_duration,
    coalesce(v_resolved.block_duration_minutes, v_duration)
  );

  v_min_notice     := coalesce(v_resolved.min_notice_minutes, 0);
  v_earliest_start := v_now + make_interval(mins => v_min_notice);

  -- Per-type hours first, clinic-wide second. Same Mon-first
  -- 7-element array shape in both sources.
  v_hours_arr := v_resolved.working_hours;
  if v_hours_arr is null then
    select value into v_hours_arr
      from public.lng_settings
     where key = 'clinic.opening_hours' and location_id is null;
  end if;

  if v_hours_arr is null
     or jsonb_typeof(v_hours_arr) <> 'array'
     or jsonb_array_length(v_hours_arr) <> 7 then
    return;
  end if;

  v_dow := extract(dow from p_date)::int;
  v_day := v_hours_arr -> ((v_dow + 6) % 7);

  if v_day is null
     or (v_day ? 'closed' and (v_day ->> 'closed')::boolean = true) then
    return;
  end if;

  v_open_text  := v_day ->> 'open';
  v_close_text := v_day ->> 'close';
  if v_open_text is null or v_close_text is null then
    return;
  end if;

  v_open_total  := (split_part(v_open_text,  ':', 1)::int) * 60
                 + (split_part(v_open_text,  ':', 2)::int);
  v_close_total := (split_part(v_close_text, ':', 1)::int) * 60
                 + (split_part(v_close_text, ':', 2)::int);

  if v_close_total <= v_open_total then
    return;
  end if;

  v_close_at := timezone('Europe/London',
    (p_date + v_close_text::time)::timestamp);

  v_break := v_day -> 'break';
  v_break_start := null;
  v_break_end   := null;
  if v_break is not null
     and jsonb_typeof(v_break) = 'array'
     and jsonb_array_length(v_break) = 2 then
    v_break_open  := v_break ->> 0;
    v_break_close := v_break ->> 1;
    v_break_start := (split_part(v_break_open,  ':', 1)::int) * 60
                   + (split_part(v_break_open,  ':', 2)::int);
    v_break_end   := (split_part(v_break_close, ':', 1)::int) * 60
                   + (split_part(v_break_close, ':', 2)::int);
    if v_break_end <= v_break_start then
      v_break_start := null;
      v_break_end   := null;
    end if;
  end if;

  v_minute_total := v_open_total;
  while v_minute_total < v_close_total loop
    v_hour   := v_minute_total / 60;
    v_minute := v_minute_total % 60;

    if v_break_start is not null
       and v_minute_total >= v_break_start
       and v_minute_total <  v_break_end then
      v_minute_total := v_minute_total + p_step_minutes;
      continue;
    end if;

    v_cand_start := timezone('Europe/London',
      (p_date + make_time(v_hour, v_minute, 0))::timestamp);
    v_cand_end := v_cand_start + make_interval(mins => v_duration);

    if v_cand_start >= v_earliest_start
       and v_cand_start + make_interval(mins => v_extent) <= v_close_at then
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
  'Staff-side availability resolver for the Schedule sheets. Effective opening hours = booking-type working_hours (resolver-merged child -> parent) when set, otherwise lng_settings.clinic.opening_hours. Both sources use the same Mon-first 7-element array shape. Honours lunch break, post-block extent check, conflict checker, and min_notice_minutes. Optional p_exclude_appointment_id supports the Reschedule sheet.';
