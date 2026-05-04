-- ─────────────────────────────────────────────────────────────────────────────
-- Lounge — opening hours sourced from lng_settings
--
-- The widget's slot generator (lng_widget_available_slots) had
-- opening hours hardcoded (9-6 weekdays minus 13-14 lunch, 10-4
-- Saturday, Sun closed). The email-templates code already reads
-- `clinic.opening_hours` from lng_settings — but with a thinner
-- schema (open/close per day, no lunch break) and stale defaults
-- (9-5 weekdays, closed weekends).
--
-- This migration unifies the two: the slot RPC now reads
-- `clinic.opening_hours` and the schema gains an optional `break`
-- tuple for lunch / mid-day closures. The existing setting value
-- is updated to match the widget's prior hardcoded defaults so
-- nothing in production changes — admin can now edit the JSON in
-- one place and both the slot picker and the email "opening hours
-- today" line reflect it.
--
-- Schema:
--   [
--     mon, tue, wed, thu, fri, sat, sun  // 7 entries, in this order
--   ]
--   each entry is either:
--     { "closed": true }
--   or:
--     { "open": "HH:MM", "close": "HH:MM", "break": ["HH:MM","HH:MM"]? }
--
-- The break tuple is optional — when absent, the day has no
-- mid-day closure.
--
-- Rollback: revert the function body (function signature
-- unchanged) and restore the prior seed value.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Update default value ──────────────────────────────────────
update public.lng_settings
set value = jsonb_build_array(
  jsonb_build_object('open', '09:00', 'close', '18:00', 'break', jsonb_build_array('13:00', '14:00')),
  jsonb_build_object('open', '09:00', 'close', '18:00', 'break', jsonb_build_array('13:00', '14:00')),
  jsonb_build_object('open', '09:00', 'close', '18:00', 'break', jsonb_build_array('13:00', '14:00')),
  jsonb_build_object('open', '09:00', 'close', '18:00', 'break', jsonb_build_array('13:00', '14:00')),
  jsonb_build_object('open', '09:00', 'close', '18:00', 'break', jsonb_build_array('13:00', '14:00')),
  jsonb_build_object('open', '10:00', 'close', '16:00'),
  jsonb_build_object('closed', true)
)
where key = 'clinic.opening_hours' and location_id is null;

-- ── Replace the slot generator to read from lng_settings ──────
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
  v_step_minutes  int := 15;
  v_minute        int;
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
begin
  -- Phase 2c widget runs single-location. Resolve a stub id to
  -- the default Venneir lab — same fallback widget-create-
  -- appointment uses.
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

  -- Duration via the booking-type resolver.
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

  -- Read clinic opening hours from lng_settings. Falls back to
  -- the previous hardcoded defaults if the setting is missing or
  -- malformed (defensive — the settings row is seeded but a
  -- future operator could nuke it).
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

  -- Pick the right day. Postgres extract(dow) returns 0=Sun, ...
  -- 6=Sat. The setting array is Mon-first (Mon=0, ..., Sun=6).
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

  -- Convert open/close to minutes-of-day so we can iterate at the
  -- step granularity without faffing with timestamps.
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

    -- Reject candidates that:
    --   • Don't finish before close
    --   • Start during the lunch break (matches the prior client-
    --     side stub: skip starts during lunch but allow slots that
    --     span across it from before)
    if v_cand_end <= v_close_at
       and (v_break_start is null or v_cand_start < v_break_start or v_cand_start >= v_break_end)
    then
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

    v_minute_of_day := v_minute_of_day + v_step_minutes;
  end loop;
  return;
end;
$$;

revoke all on function public.lng_widget_available_slots(uuid, text, date, text, text, text) from public;
grant execute on function public.lng_widget_available_slots(uuid, text, date, text, text, text) to anon, authenticated, service_role;

comment on function public.lng_widget_available_slots(uuid, text, date, text, text, text) is
  'Customer-facing booking widget availability resolver. Reads clinic.opening_hours from lng_settings (seeded with sane defaults) — admin can edit per-day open/close/break in admin without redeploying. Filters candidate slots through lng_booking_check_conflict.';
