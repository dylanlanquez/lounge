-- 20260523000002_lng_slot_scanners_notice.sql
--
-- Wires the new lng_booking_type_config.min_notice_minutes column
-- (added in 20260523000001) into the two slot scanners. After this
-- migration:
--
--   • lng_widget_available_slots — used by the customer widget time
--     picker, the widget calendar (via lng_widget_available_dates),
--     the "Our first opening" banner (via lng_widget_first_available),
--     the widget reschedule flow, and Checkpoint's Book Appointment
--     modal — refuses any candidate whose start is sooner than
--     now + min_notice.
--
--   • lng_booking_available_slots — used by the staff New Booking
--     sheet and Reschedule sheet — gains the same gate.
--
-- Both functions keep every other behaviour byte-for-byte from their
-- canonical versions (20260517000009 for the widget, 20260514000001
-- for the booking RPC). Only:
--   1. The resolver select now also pulls min_notice_minutes.
--   2. v_min_notice / v_earliest_start are computed once after the
--      resolver returns.
--   3. The candidate-start check uses v_earliest_start instead of
--      v_now.
--
-- Inclusive `>=` so a 30-min notice allows the 1:30pm slot at exactly
-- 1:00pm (natural reading: "at least 30 minutes from now"). NULL
-- min_notice coalesces to 0 → v_earliest_start = v_now, matching the
-- existing past-time guard.
--
-- Apply order: shadow first, then Meridian. Rollback: re-run
-- 20260517000009_lng_slot_cart_aware.sql and
-- 20260514000001_lng_booking_available_slots.sql.

-- ─────────────────────────────────────────────────────────────────
-- 1. Customer-side: lng_widget_available_slots (cart-aware variant)
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

  -- Cart-aware variant pick for denture_repair: when the caller
  -- supplied an array of variants in the cart, find the heaviest
  -- one (most pool claims) and use it for phase resolution. Legacy
  -- single-variant callers (or any non-denture_repair service)
  -- skip this branch and use p_repair_variant as before.
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

  select duration_default, block_duration_minutes, min_notice_minutes
    into v_resolved
    from public.lng_booking_type_resolve(
      p_service_type,
      v_effective_variant,
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

  -- Notice gate: candidates must start no sooner than now + notice.
  -- NULL → 0, matching the existing past-time behaviour. Computed
  -- once outside the loop because both v_now and v_min_notice are
  -- loop-invariant.
  v_min_notice     := coalesce(v_resolved.min_notice_minutes, 0);
  v_earliest_start := v_now + make_interval(mins => v_min_notice);

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

    -- Notice / past-time guard: the candidate must start at or after
    -- v_earliest_start (= now + min_notice; falls back to now when no
    -- notice is configured, matching the prior past-time behaviour).
    -- Future dates are unaffected for any reasonable notice window —
    -- every slot on a future date sits well past now + notice.
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
  'Customer widget slot resolver. Cart-aware: pass p_repair_variants for a denture_repair booking and the function uses lng_denture_repair_effective_variant() to resolve the most restrictive variant before phase / conflict resolution. Honours the resolver''s min_notice_minutes so notice-gated services (virtual_impression_appointment, etc.) never surface a slot sooner than now + notice. The widget calendar, "first opening" banner, time picker, reschedule flow, and Checkpoint Book Appointment modal all inherit this gate.';

-- ─────────────────────────────────────────────────────────────────
-- 2. Staff-side: lng_booking_available_slots
-- ─────────────────────────────────────────────────────────────────
-- Same change shape as the widget function. The staff variant
-- previously had no past-time guard at all — the NewBookingSheet did
-- its own client-side isPastSlot check. Adding the notice gate here
-- also closes that gap (notice = 0 → v_earliest_start = v_now, so
-- past slots stop appearing in the picker).

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
  v_now           timestamptz := current_timestamp;
  v_min_notice    int;
  v_earliest_start timestamptz;
begin
  -- Resolve duration + working_hours + notice via the canonical
  -- resolver. Same source of truth the NewBookingSheet reads on the
  -- client, so a child override (denture repair_variant, product_key,
  -- arch) shifts every input in lock step.
  select working_hours, duration_default, min_notice_minutes
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

  -- Notice / past-time guard, identical to the widget scanner.
  v_min_notice     := coalesce(v_resolved.min_notice_minutes, 0);
  v_earliest_start := v_now + make_interval(mins => v_min_notice);

  -- Map Postgres dow (0=Sun..6=Sat) to our jsonb key.
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

  v_open_hour  := split_part(v_day_hours ->> 'open',  ':', 1)::int;
  v_open_min   := split_part(v_day_hours ->> 'open',  ':', 2)::int;
  v_close_hour := split_part(v_day_hours ->> 'close', ':', 1)::int;
  v_close_min  := split_part(v_day_hours ->> 'close', ':', 2)::int;
  v_open_total  := v_open_hour  * 60 + v_open_min;
  v_close_total := v_close_hour * 60 + v_close_min;

  if v_close_total <= v_open_total then
    return;
  end if;

  v_minute_total := v_open_total;
  while v_minute_total < v_close_total loop
    v_hour   := v_minute_total / 60;
    v_minute := v_minute_total % 60;

    v_cand_start := timezone('Europe/London',
      (p_date + make_time(v_hour, v_minute, 0))::timestamp);
    v_cand_end := v_cand_start + make_interval(mins => v_duration);

    -- Skip candidates that fall inside the notice window (or in the
    -- past when no notice is configured). The reschedule sheet's
    -- exclude_appointment_id still lets the row's own current slot
    -- through the conflict check below — but the candidate has to
    -- clear the notice gate first.
    if v_cand_start >= v_earliest_start then
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
  'Staff-side availability resolver for the Schedule sheets. Returns HH:MM 24-hour slot strings within the resolved working_hours for p_date that are clear of conflicts per lng_booking_check_conflict AND that satisfy the booking type''s min_notice_minutes (NULL = no notice). Optional p_exclude_appointment_id lets the Reschedule sheet treat the row being moved as not occupying its current slot.';
