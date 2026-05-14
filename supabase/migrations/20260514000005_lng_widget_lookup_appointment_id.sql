-- 20260514000005_lng_widget_lookup_appointment_id.sql
--
-- Surface lng_appointments.id from the manage-page lookup. The
-- widget's reschedule flow needs to pass it to
-- lng_widget_available_slots as the exclude_appointment_id so the
-- patient's current slot doesn't conflict with itself.
--
-- The token (manage_token) is already an unguessable secret keyed
-- 1:1 to the appointment row — returning the row's UUID alongside
-- it doesn't leak anything new about the appointment that the
-- patient holding the token couldn't already see, and the column
-- is never used to construct a deep link or anything externally
-- guessable.
--
-- Rollback: re-apply 20260504000017.

drop function if exists public.lng_widget_lookup_booking(uuid);

create or replace function public.lng_widget_lookup_booking(
  p_token uuid
)
returns table (
  id                  uuid,
  appointment_ref     text,
  status              text,
  service_type        text,
  service_label       text,
  start_at            timestamptz,
  end_at              timestamptz,
  location_id         uuid,
  location_name       text,
  location_address    text,
  patient_first_name  text,
  deposit_status      text,
  deposit_pence       int,
  deposit_currency    text,
  repair_variant      text,
  product_key         text,
  arch                text,
  cancellable         boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  select
    a.id,
    a.appointment_ref,
    a.status,
    a.service_type,
    coalesce(nullif(a.event_type_label, ''), a.service_type) as service_label,
    a.start_at,
    a.end_at,
    a.location_id,
    coalesce(l.name, 'Venneir Lounge')                       as location_name,
    trim(both ', ' from concat_ws(', ',
      nullif(l.address, ''),
      nullif(l.city, '')
    ))                                                        as location_address,
    p.first_name                                              as patient_first_name,
    a.deposit_status,
    a.deposit_pence,
    a.deposit_currency,
    a.repair_variant,
    a.product_key,
    a.arch,
    (a.status = 'booked' and a.start_at > now())              as cancellable
  from public.lng_appointments a
  left join public.locations l on l.id = a.location_id
  left join public.patients p on p.id = a.patient_id
  where a.manage_token = p_token
  limit 1;
end;
$$;

revoke all on function public.lng_widget_lookup_booking(uuid) from public;
grant execute on function public.lng_widget_lookup_booking(uuid) to anon, authenticated, service_role;

comment on function public.lng_widget_lookup_booking(uuid) is
  'Token-keyed lookup for the customer manage page. Returns the booking row''s id (uuid) so the widget reschedule flow can exclude it from conflict checks, plus all patient-visible fields. Security: returns only the row that matches the token; never any other patient''s data.';
