-- 20260609000008_lng_clinician_available_dates.sql
--
-- Per-clinician available-dates scanner for the booking calendar. Virtual
-- impression availability is the CLINICIAN's, not the clinic's, so the
-- New Booking / Reschedule date pickers must dim days the clinician isn't
-- working (rather than offering every day and then saying "clinic closed",
-- which is wrong — the clinician can work hours the clinic doesn't, e.g.
-- a different office / timezone).
--
-- Mirrors lng_widget_available_dates but keyed on a clinician: for each
-- day in the window, returns it when that clinician has at least one
-- bookable slot (lng_virtual_available_slots). 60-day cap, clinic TZ.
--
-- Additive; safe to apply any time. Apply: shadow first, then Meridian.

create or replace function public.lng_clinician_available_dates(
  p_staff_member_id uuid    default null,
  p_self_serve_only boolean default false,
  p_from            date    default null,
  p_to              date    default null
)
returns table (date date)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_from     date;
  v_to       date;
  v_cursor   date;
  v_duration int;
begin
  v_from := coalesce(p_from, (timezone('Europe/London', now()))::date);
  v_to   := coalesce(p_to, v_from + 60);
  -- Cap the scan window so a runaway range can't hammer the DB.
  if v_to > v_from + 60 then
    v_to := v_from + 60;
  end if;

  select duration_default
    into v_duration
    from public.lng_booking_type_resolve('virtual_impression_appointment', null, null, null);
  v_duration := coalesce(v_duration, 30);

  v_cursor := v_from;
  while v_cursor <= v_to loop
    if exists (
      select 1
        from public.lng_virtual_available_slots(
          v_cursor, v_duration, 15, now(), null, p_self_serve_only, p_staff_member_id
        )
      limit 1
    ) then
      date := v_cursor;
      return next;
    end if;
    v_cursor := v_cursor + 1;
  end loop;
  return;
end;
$$;

revoke all on function public.lng_clinician_available_dates(uuid, boolean, date, date) from public;
grant execute on function public.lng_clinician_available_dates(uuid, boolean, date, date) to anon, authenticated, service_role;
comment on function public.lng_clinician_available_dates(uuid, boolean, date, date) is
  'Dates in [p_from, p_to] (60-day cap, clinic TZ) where the given virtual impression clinician has at least one bookable slot. p_self_serve_only filters staff-only clinicians; p_staff_member_id null = any clinician. Drives the booking calendar''s per-day enabled state for virtual impressions.';

NOTIFY pgrst, 'reload schema';
