-- 20260515000007_lng_booking_available_slots_phase_duration_fallback.sql
--
-- Companion to 20260515000006. The earlier migration patched the
-- WIDGET-side slot scanner (lng_widget_available_slots), but the
-- STAFF New Booking + Reschedule sheets call a different function
-- — lng_booking_available_slots — which had the exact same
-- null-duration bail. Result: virtual_impression_appointment still
-- showed "no free times" on the staff side after the widget fix.
--
-- Same root cause + same fix:
-- lng_booking_type_config.duration_default is NULL on services
-- where the appointment length is computed from phases (the "Video
-- call" phase declares 20 min, surfacing as
-- block_duration_minutes=20 on the resolver). Coalesce
-- duration_default → block_duration_minutes so the slot scan
-- proceeds; bail only when both are null.
--
-- The function's existing v_extent calculation already coalesced
-- to block_duration_minutes for the post-block extent check, so
-- the change keeps duration + extent agreeing on the same fallback.
--
-- Apply order per CLAUDE.md: shadow first, then production.
-- Rollback: re-run the prior version of this function from the
-- original create migration.

create or replace function public.lng_booking_available_slots(
  p_location_id          uuid,
  p_service_type         text,
  p_date                 date,
  p_exclude_appointment_id uuid    default null,
  p_repair_variant       text     default null,
  p_product_key          text     default null,
  p_arch                 text     default null,
  p_step_minutes         integer  default 15
)
returns table(slot_local text)
language plpgsql
stable
set search_path = public
as $function$
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
begin
  -- ── Duration + phases via the resolver ──────────────────────────
  select duration_default, block_duration_minutes
    into v_resolved
    from public.lng_booking_type_resolve(
      p_service_type,
      p_repair_variant,
      p_product_key,
      p_arch
    );

  -- Coalesce parent duration_default → phase-derived
  -- block_duration_minutes. virtual-impression and any other
  -- phase-driven service get their slot scan unblocked by this
  -- without changing per-row admin config. Bail only when BOTH are
  -- null — that's a genuine misconfiguration the operator should
  -- fix in admin, not silently absorb.
  v_duration := coalesce(v_resolved.duration_default, v_resolved.block_duration_minutes);
  if v_resolved is null or v_duration is null then
    return;
  end if;
  v_extent := greatest(
    v_duration,
    coalesce(v_resolved.block_duration_minutes, v_duration)
  );

  -- ── Read clinic-wide opening hours from lng_settings ────────────
  -- Mon-first array; same shape the widget reads. No fallback here
  -- — if the row is missing or malformed the receptionist sees an
  -- empty picker, which is the right loud failure for a clinic that
  -- hasn't configured its hours.
  select value into v_hours_arr
    from public.lng_settings
   where key = 'clinic.opening_hours' and location_id is null;

  if v_hours_arr is null
     or jsonb_typeof(v_hours_arr) <> 'array'
     or jsonb_array_length(v_hours_arr) <> 7 then
    return;
  end if;

  -- ── Pick the day ────────────────────────────────────────────────
  -- Postgres extract(dow) is 0=Sun..6=Sat; the array is Mon=0..Sun=6.
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

  -- ── Optional lunch break (tuple form: ["HH:MM","HH:MM"]) ────────
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

  -- ── Walk the grid ───────────────────────────────────────────────
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
$function$;

comment on function public.lng_booking_available_slots(uuid, text, date, uuid, text, text, text, integer) is
  'Bookable HH:MM slots for the staff New Booking + Reschedule sheets. Uses duration_default when set, else falls back to block_duration_minutes (sum of phases) so phase-driven services like virtual_impression_appointment surface availability. Honours conflict check, lunch-break skip, and post-block extent check. Sibling of lng_widget_available_slots — both keep the same duration-resolution rules.';
