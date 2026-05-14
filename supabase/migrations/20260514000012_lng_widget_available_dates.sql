-- Per-day availability scan for the widget calendar
--
-- The customer-facing date picker had no way of knowing which days
-- in the visible month actually had bookable slots. It rendered
-- every weekday in opening hours as clickable, and the patient
-- only discovered a day was empty by tapping it and seeing
-- "Nothing free on this day." The right UX is to disable
-- empty days up front — but that needs per-day availability data
-- the existing lng_widget_available_slots(single-date) and
-- lng_widget_first_available(first-only) RPCs don't expose.
--
-- This function fills that gap. Given a window of dates and the
-- same axis pins the slot scanner uses, it returns the subset of
-- dates that have at least one non-conflicting future slot. The
-- client calls it once per visible month and uses the result to
-- enable / disable calendar cells.
--
-- Internally it loops the same lng_widget_available_slots that
-- powers the slot list (with LIMIT 1 so we stop on the first
-- non-conflicting candidate per day). That means the past-time
-- filter, lunch-break skip, post-block extent check, and conflict
-- check are all honoured — every behaviour stays in one place.
--
-- Anon-callable (the customer's first paint needs it). 60-day
-- window cap on the requested range so a careless caller can't
-- hammer the database.
--
-- Rollback:
--   drop function public.lng_widget_available_dates(uuid, text, text, text, text, date, date);

create or replace function public.lng_widget_available_dates(
  p_location_id    uuid,
  p_service_type   text,
  p_repair_variant text default null,
  p_product_key    text default null,
  p_arch           text default null,
  p_from           date default null,
  p_to             date default null
)
returns table (date date)
language plpgsql
security definer
set search_path = public
as $$
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
        null
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
$$;

revoke all on function public.lng_widget_available_dates(uuid, text, text, text, text, date, date) from public;
grant execute on function public.lng_widget_available_dates(uuid, text, text, text, text, date, date) to anon, authenticated, service_role;

comment on function public.lng_widget_available_dates(uuid, text, text, text, text, date, date) is
  'Customer-facing booking widget — returns the subset of dates in [p_from, p_to] (capped at 60 days) that have at least one bookable slot for the resolved booking-type. Powers the calendar grid''s per-day enabled state. Internally loops lng_widget_available_slots with LIMIT 1 per day so every behaviour (past-time filter, conflicts, lunch break, post-block extent) is inherited from the slot scanner.';
