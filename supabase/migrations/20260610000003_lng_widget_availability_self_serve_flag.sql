-- 20260610000003_lng_widget_availability_self_serve_flag.sql
--
-- Checkpoint is a STAFF booking surface, so it must be able to book
-- staff-only virtual impression clinicians — including at times when
-- ONLY a staff-only clinician is on shift. But the three anon widget
-- availability RPCs (slots / dates / first-available) hard-coded
-- self_serve_only = true in their virtual branch, so staff-only
-- clinicians' hours never surfaced as bookable slots/days on Checkpoint
-- (or in the picker's underlying calendar).
--
-- Add p_self_serve_only (default TRUE) to all three and thread it into
-- the virtual branch. Default true keeps the public customer widget
-- (venneir.com / denture-services.co.uk) exactly as-is; Checkpoint now
-- passes false to see staff-only clinicians' full availability. The
-- per-clinician overlap guard + lng_clinicians_available still gate who
-- is actually free, and lng_clinicians_available (the picker source) is
-- already self_serve_only=false on Checkpoint.
--
-- Signatures change (a param is added), so each function is DROPped and
-- recreated (plpgsql callers late-bind, so the cross-calls between these
-- three resolve fine). Grants re-applied. Bodies are the live prod
-- definitions, verbatim, with only the param added + threaded.
--
-- Apply: shadow first (verify), then Meridian.

drop function if exists public.lng_widget_available_slots(uuid, text, date, text, text, text, uuid, text[]);
drop function if exists public.lng_widget_available_dates(uuid, text, text, text, text, date, date);
drop function if exists public.lng_widget_first_available(uuid, text, text, text, text);

CREATE OR REPLACE FUNCTION public.lng_widget_available_slots(p_location_id uuid, p_service_type text, p_date date, p_repair_variant text DEFAULT NULL::text, p_product_key text DEFAULT NULL::text, p_arch text DEFAULT NULL::text, p_exclude_appointment_id uuid DEFAULT NULL::uuid, p_repair_variants text[] DEFAULT NULL::text[], p_self_serve_only boolean DEFAULT true)
 RETURNS TABLE(start_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- ── Virtual branch ──
  -- Availability is driven by per-clinician hours, not clinic hours.
  -- Public widget: self_serve only (special/temp clinicians hidden),
  -- no host filter. Inherited by available_dates + first_available.
  if p_service_type = 'virtual_impression_appointment' then
    return query
      select s.start_at
        from public.lng_virtual_available_slots(
          p_date,
          v_duration,
          v_step_minutes,
          v_earliest_start,
          p_exclude_appointment_id,
          p_self_serve_only,   -- self_serve_only (public widget=true; Checkpoint passes false)
          null    -- host_id
        ) s;
    return;
  end if;

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

CREATE OR REPLACE FUNCTION public.lng_widget_available_dates(p_location_id uuid, p_service_type text, p_repair_variant text DEFAULT NULL::text, p_product_key text DEFAULT NULL::text, p_arch text DEFAULT NULL::text, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_self_serve_only boolean DEFAULT true)
 RETURNS TABLE(date date)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_from   date;
  v_to     date;
  v_cursor date;
  v_first  timestamptz;
begin
  -- Window defaults: from today (clinic timezone) through 60 days
  -- out. Cap the requested range at 60 days even if the caller
  -- asks for more — avoids accidental "scan the next year"
  -- requests from a malformed UI.
  v_from := coalesce(
    p_from,
    (current_timestamp at time zone 'Europe/London')::date
  );
  v_to := coalesce(p_to, v_from + 60);
  if v_to > v_from + 60 then
    v_to := v_from + 60;
  end if;
  if v_to < v_from then
    return;
  end if;

  v_cursor := v_from;
  while v_cursor <= v_to loop
    select s.start_at
      into v_first
      from public.lng_widget_available_slots(
        p_location_id,
        p_service_type,
        v_cursor,
        p_repair_variant,
        p_product_key,
        p_arch,
        null,
        null,
        p_self_serve_only
      ) s
      limit 1;
    if v_first is not null then
      date := v_cursor;
      return next;
    end if;
    v_cursor := v_cursor + 1;
  end loop;
  return;
end;
$function$;

CREATE OR REPLACE FUNCTION public.lng_widget_first_available(p_location_id uuid, p_service_type text, p_repair_variant text DEFAULT NULL::text, p_product_key text DEFAULT NULL::text, p_arch text DEFAULT NULL::text, p_self_serve_only boolean DEFAULT true)
 RETURNS TABLE(date date, start_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_cursor date;
  v_first  timestamptz;
begin
  -- Scan up to 60 days forward from today (clinic timezone). The
  -- inner availability function does its own timezone math so we
  -- can pass a plain date.
  v_cursor := (current_timestamp at time zone 'Europe/London')::date;
  for i in 0..60 loop
    select s.start_at into v_first
    from public.lng_widget_available_slots(
      p_location_id,
      p_service_type,
      v_cursor,
      p_repair_variant,
      p_product_key,
      p_arch,
      null,
      null,
      p_self_serve_only
    ) s
    order by s.start_at asc
    limit 1;
    if v_first is not null then
      date := v_cursor;
      start_at := v_first;
      return next;
      return;
    end if;
    v_cursor := v_cursor + 1;
  end loop;
  return;
end;
$function$;

-- Re-grant (DROP cleared privileges). These are SECURITY DEFINER anon
-- RPCs used by the public widget AND Checkpoint.
grant execute on function public.lng_widget_available_slots(uuid, text, date, text, text, text, uuid, text[], boolean) to anon, authenticated, service_role;
grant execute on function public.lng_widget_available_dates(uuid, text, text, text, text, date, date, boolean) to anon, authenticated, service_role;
grant execute on function public.lng_widget_first_available(uuid, text, text, text, text, boolean) to anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

-- ── Rollback ──────────────────────────────────────────────────────
-- Re-apply the prior definitions (drop the boolean-arg overloads, restore
-- the versions that hard-code self_serve_only=true in the virtual branch).
