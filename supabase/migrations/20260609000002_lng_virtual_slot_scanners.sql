-- 20260609000002_lng_virtual_slot_scanners.sql
--
-- Makes virtual_impression_appointment availability host-aware.
--
-- Before this migration both slot scanners walked a single working_hours
-- block (per-type or clinic-wide) and called lng_booking_check_conflict.
-- For virtual that meant slots appeared across the whole clinic day and,
-- because virtual claims no resource pool, nothing capped concurrency.
--
-- Now, for virtual_impression_appointment ONLY, both scanners delegate
-- to lng_virtual_available_slots, which offers a slot iff at least one
-- clinician is on shift AND free for it (lng_meet_hosts_available from
-- 20260609000001). Capacity therefore equals the number of on-shift,
-- free clinicians — two working at 10:00 means two bookable 10:00 slots.
--
-- Every other service type is byte-for-byte the body from
-- 20260525000001; only an early virtual branch is added. In-person
-- resource pools and the clinic-hours fallback are untouched.
--
--   • lng_widget_available_slots  → public widget (calendar, first
--     opening, time picker, self-serve reschedule, Checkpoint modal).
--     Virtual branch passes self_serve_only = true so special/temp
--     clinicians never surface to customers, and host_id = null.
--   • lng_booking_available_slots → staff Schedule sheets. Gains a
--     trailing p_meet_host_id so staff can view ONE clinician's real
--     availability (the "customer can only do Sunday, check the special
--     clinician, book the Sunday" flow). Virtual branch passes
--     self_serve_only = false so staff see staff-only clinicians too.
--
-- Apply order: shadow first (verify), then Meridian.

-- ─────────────────────────────────────────────────────────────────
-- 0. lng_virtual_available_slots — host-aware slot generator
-- ─────────────────────────────────────────────────────────────────
-- Walks the day inside the bounding window of the candidate hosts'
-- effective windows (weekly + 'available' overrides) and emits each
-- step where lng_meet_hosts_available returns at least one host. The
-- helper itself enforces on-shift coverage, 'off' overrides, the
-- self_serve filter, the host filter, and the per-host free check.
create or replace function public.lng_virtual_available_slots(
  p_date            date,
  p_duration        int,
  p_step_minutes    int,
  p_earliest_start  timestamptz,
  p_exclude_appointment_id uuid    default null,
  p_self_serve_only boolean default true,
  p_host_id         uuid    default null
)
returns table (start_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_dow         int;
  v_min_start   time;
  v_max_end     time;
  v_open_total  int;
  v_close_total int;
  v_minute      int;
  v_cand_start  timestamptz;
  v_cand_end    timestamptz;
begin
  if p_duration is null or p_duration <= 0 then
    return;
  end if;

  v_dow := ((extract(dow from p_date)::int + 6) % 7);  -- 0=Mon..6=Sun

  -- Bounding window for the day across every candidate host's weekly
  -- windows and 'available' overrides. NULL = nobody works this day for
  -- this self_serve/host filter, so there are no slots.
  select min(s), max(e)
    into v_min_start, v_max_end
    from (
      select wh.start_local as s, wh.end_local as e
        from public.lng_meet_host_hours wh
        join public.lng_meet_hosts h on h.id = wh.host_id
       where h.is_active
         and (not p_self_serve_only or h.self_serve)
         and (p_host_id is null or h.id = p_host_id)
         and wh.day_of_week = v_dow
      union all
      select o.start_local, o.end_local
        from public.lng_meet_host_overrides o
        join public.lng_meet_hosts h on h.id = o.host_id
       where h.is_active
         and (not p_self_serve_only or h.self_serve)
         and (p_host_id is null or h.id = p_host_id)
         and o.override_date = p_date
         and o.kind = 'available'
    ) w;

  if v_min_start is null then
    return;
  end if;

  v_open_total  := extract(hour from v_min_start)::int * 60
                 + extract(minute from v_min_start)::int;
  v_close_total := extract(hour from v_max_end)::int * 60
                 + extract(minute from v_max_end)::int;

  v_minute := v_open_total;
  while v_minute + p_duration <= v_close_total loop
    v_cand_start := timezone('Europe/London',
      (p_date + make_time(v_minute / 60, v_minute % 60, 0))::timestamp);
    v_cand_end := v_cand_start + make_interval(mins => p_duration);

    if v_cand_start >= p_earliest_start
       and exists (
         select 1 from public.lng_meet_hosts_available(
           v_cand_start,
           v_cand_end,
           p_self_serve_only,
           p_exclude_appointment_id,
           p_host_id
         )
       )
    then
      start_at := v_cand_start;
      return next;
    end if;

    v_minute := v_minute + p_step_minutes;
  end loop;

  return;
end;
$$;

revoke all on function public.lng_virtual_available_slots(date, int, int, timestamptz, uuid, boolean, uuid) from public;
grant execute on function public.lng_virtual_available_slots(date, int, int, timestamptz, uuid, boolean, uuid) to anon, authenticated, service_role;

comment on function public.lng_virtual_available_slots(date, int, int, timestamptz, uuid, boolean, uuid) is
  'Host-aware slot generator for virtual_impression_appointment. Emits each step on p_date where at least one clinician is on shift and free (lng_meet_hosts_available). p_self_serve_only=true hides staff-only clinicians; p_host_id narrows to one clinician for the staff picker. Honours p_earliest_start (min notice).';

-- ─────────────────────────────────────────────────────────────────
-- 1. Customer-side: lng_widget_available_slots (+ virtual branch)
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
          true,   -- self_serve_only
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

comment on function public.lng_widget_available_slots(uuid, text, date, text, text, text, uuid, text[]) is
  'Customer widget slot resolver. virtual_impression_appointment is host-aware via lng_virtual_available_slots (self_serve only). Every other type: effective opening hours = booking-type working_hours when set, otherwise lng_settings.clinic.opening_hours (Mon-first 7-element array). Honours lunch break, post-block extent, conflict checker, min_notice. Cart-aware for denture_repair. Inherited by the widget calendar, first-opening banner, time picker, reschedule, and Checkpoint modal.';

-- ─────────────────────────────────────────────────────────────────
-- 2. Staff-side: lng_booking_available_slots (+ p_meet_host_id, virtual branch)
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
  p_step_minutes           int  default 15,
  p_meet_host_id           uuid default null
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

  -- ── Virtual branch ──
  -- Staff path: include staff-only clinicians (self_serve_only = false)
  -- and, when the staff member has picked a specific clinician, narrow
  -- to that host so the time list shows only their real availability.
  if p_service_type = 'virtual_impression_appointment' then
    return query
      select to_char(timezone('Europe/London', s.start_at), 'HH24:MI')
        from public.lng_virtual_available_slots(
          p_date,
          v_duration,
          p_step_minutes,
          v_earliest_start,
          p_exclude_appointment_id,
          false,           -- self_serve_only: staff see everyone
          p_meet_host_id   -- optional single-clinician filter
        ) s;
    return;
  end if;

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
  uuid, text, date, uuid, text, text, text, int, uuid
) from public;
grant execute on function public.lng_booking_available_slots(
  uuid, text, date, uuid, text, text, text, int, uuid
) to authenticated;

comment on function public.lng_booking_available_slots(
  uuid, text, date, uuid, text, text, text, int, uuid
) is
  'Staff-side availability resolver for the Schedule sheets. virtual_impression_appointment is host-aware via lng_virtual_available_slots (staff see staff-only clinicians; p_meet_host_id narrows to one clinician). Every other type uses booking-type working_hours then clinic hours, with lunch break, extent, conflict checker, and min_notice. p_exclude_appointment_id supports Reschedule.';

NOTIFY pgrst, 'reload schema';

-- ── Rollback ──────────────────────────────────────────────────────
-- Re-apply 20260525000001_lng_slot_scanners_per_type_hours.sql (restores
-- both scanners to the clinic-hours-only bodies) and:
--   drop function if exists public.lng_booking_available_slots(uuid, text, date, uuid, text, text, text, int, uuid);
--   drop function if exists public.lng_virtual_available_slots(date, int, int, timestamptz, uuid, boolean, uuid);
