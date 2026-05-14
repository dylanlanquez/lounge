-- 20260514000003_lng_booking_slots_clinic_hours.sql
--
-- Single source of truth for working hours.
--
-- Until now there were two: per-service
-- lng_booking_type_config.working_hours (read by the staff side)
-- and clinic-wide lng_settings.clinic.opening_hours (read by the
-- widget + email templates). Operator just configured the clinic
-- one in admin and was surprised the staff sheet still showed the
-- per-service defaults.
--
-- From this migration onward the staff side reads the clinic-wide
-- settings, same as the widget. Per-service working_hours stays in
-- the column for now (column drop is a separate migration) but
-- nothing references it any more.
--
-- Schema being read:
--   lng_settings WHERE key='clinic.opening_hours' AND location_id IS NULL
--   value is a 7-element JSONB array, Mon-first:
--     { "open": "HH:MM", "close": "HH:MM", "break": ["HH:MM","HH:MM"]? }
--   OR { "closed": true }
--
-- Behaviour preserved:
--   • Optional lunch break — start in [break_start, break_end) is
--     skipped (slots that span across lunch from before are kept,
--     matching the widget).
--   • End-vs-close uses GREATEST(duration_default, block_duration_
--     minutes) so the post-block Try-in return is protected too.
--   • Optional p_exclude_appointment_id supports the Reschedule
--     sheet.
--
-- Rollback: re-apply 20260514000002.

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

  if v_resolved is null or v_resolved.duration_default is null then
    return;
  end if;
  v_duration := v_resolved.duration_default;
  v_extent := greatest(
    v_resolved.duration_default,
    coalesce(v_resolved.block_duration_minutes, v_resolved.duration_default)
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
  'Staff-side availability resolver. Reads opening hours from lng_settings.clinic.opening_hours (Mon-first array, matching the widget RPC and email templates). Skips lunch starts and rejects slots whose GREATEST(duration_default, block_duration_minutes) extent lands past close. Optional p_exclude_appointment_id supports the Reschedule sheet.';
