-- ─────────────────────────────────────────────────────────────────────────────
-- Lounge — extend manage-page lookup with location_id + axes
--
-- The reschedule flow on /widget/manage runs the SlotPicker
-- against the same axis pins the patient originally booked, so we
-- need the lookup RPC to surface them. Also surfacing location_id
-- (uuid) so the picker calls lng_widget_available_slots against
-- the right clinic — multi-location support already lives in
-- lng_widget_locations.
--
-- These fields are not PII; they're booking parameters the
-- patient picked themselves on Step 2-3 of the original flow.
-- Returning them is safe.
--
-- Rollback: revert the function body to drop the four new columns.
-- ─────────────────────────────────────────────────────────────────────────────

-- CREATE OR REPLACE can't change the return type, so drop and
-- recreate. Safe — the function is idempotent and re-grants below.
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
  cancellable         boolean
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
  'Patient-side booking lookup for the manage page. Anon-callable. Returns service / location / time / status / deposit / axes (for the reschedule slot picker) — never email, phone, notes, staff assignments, or any other patient''s row.';
