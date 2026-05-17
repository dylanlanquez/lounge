-- Adds join_url to the manage-page lookup RPC so virtual impression
-- appointments can render the Google Meet link on book.venneir.com/manage
-- instead of the lab address (which is meaningless for a virtual booking).
--
-- Rollback: revert the function body to drop the join_url column.

drop function if exists public.lng_widget_lookup_booking(uuid);

create or replace function public.lng_widget_lookup_booking(
  p_token uuid
)
returns table (
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
  cancellable         boolean,
  join_url            text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  select
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
    (a.status = 'booked' and a.start_at > now())              as cancellable,
    a.join_url                                                as join_url
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
  'Patient-side booking lookup for the manage page. Anon-callable. Returns service / location / time / status / deposit / axes (for the reschedule slot picker) + Google Meet join_url for virtual bookings. Never returns email, phone, notes, staff assignments, or any other patient''s row.';
