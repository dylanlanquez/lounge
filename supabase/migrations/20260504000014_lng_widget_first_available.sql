-- ─────────────────────────────────────────────────────────────────────────────
-- Lounge — widget first-available slot scan
--
-- The Time step's "Our first opening" banner needs the soonest
-- bookable slot for the patient's chosen service. The client's
-- firstAvailable() helper still uses the static-stub generator
-- because doing 60 days × 36 candidates per day = 2,160 conflict
-- checks client-side would melt the page.
--
-- This function pushes that scan server-side: iterate forward up
-- to 60 days, call lng_widget_available_slots for each, return
-- the first non-empty day's earliest start_at. Anon-callable, so
-- the patient's first paint can render an accurate banner.
--
-- Empty return when no slot exists in the next 60 days (e.g. the
-- service is configured but the conflict pool is full for two
-- months — vanishingly rare). Caller treats absent rows as "no
-- banner".
--
-- Rollback:
--   drop function public.lng_widget_first_available(uuid, text, text, text, text);
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.lng_widget_first_available(
  p_location_id    uuid,
  p_service_type   text,
  p_repair_variant text default null,
  p_product_key    text default null,
  p_arch           text default null
)
returns table (
  date     date,
  start_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
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
      p_arch
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
$$;

revoke all on function public.lng_widget_first_available(uuid, text, text, text, text) from public;
grant execute on function public.lng_widget_first_available(uuid, text, text, text, text) to anon, authenticated, service_role;

comment on function public.lng_widget_first_available(uuid, text, text, text, text) is
  'Customer-facing booking widget — first available slot for a service. Scans up to 60 days forward, calling lng_widget_available_slots and returning the first non-empty day''s earliest start_at. Drives the "Our first opening" banner on the Time step.';
