-- 20260517000010_lng_address_postcode_repair_variant.sql
--
-- Two coordinated changes that touch the same surfaces:
--
--   1. Append postcode to every widget-facing address string.
--      The locations row already stores postcode (editable in Admin
--      > Branding) but every helper / view / RPC that composed the
--      "address, city" pair dropped it. Customers were getting
--      "BioCity, Motherwell, North Lanarkshire, Glasgow" on the
--      Success modal + manage page + emails with no ML1 5UH.
--
--   2. Add repair_variant to each item in repair_items JSONB
--      returned by the manage-page lookup. The customer-facing
--      manage page reschedule flow falls back to the appointment
--      row's single repair_variant when picking slots — fine for
--      a single-line cart, but a multi-line denture-repair cart
--      that includes Relining isn't honoured because the row
--      only carries the first / effective variant. With repair_
--      variant now per item, the Manage page can ship the full
--      distinct-variants array to SlotPicker the same way the new-
--      booking Time step does (M17 cart-aware slot RPC).
--
-- Surfaces updated:
--
--   • lng_widget_locations VIEW
--   • lng_widget_manage_token(uuid) RPC
--   • lng_widget_lookup_booking(uuid) RPC
--   • lng_widget_lookup_appointment_id(text) RPC
--
-- The email edge functions construct their own location string
-- via `locationFreeform()` and are patched in a separate commit
-- in the same shipping batch.
--
-- Idempotent: CREATE OR REPLACE on the view + RPCs.
-- ─────────────────────────────────────────────────────────────────

-- ── 1. lng_widget_locations view ─────────────────────────────────

-- Existing column set: id, name, city, address_line, phone. We
-- preserve that exact shape (callers select named fields) and only
-- patch address_line to include postcode.
drop view if exists public.lng_widget_locations;

create view public.lng_widget_locations as
select
  l.id,
  l.name,
  l.city,
  -- Address line safe to drop on a customer surface. Order matches
  -- a UK postal address: street → city → postcode. Empty / null
  -- fields are stripped via concat_ws and a defensive trim cleans
  -- up any leading-or-trailing comma the concat leaves behind.
  trim(both ', ' from concat_ws(
    ', ',
    nullif(l.address,  ''),
    nullif(l.city,     ''),
    nullif(l.postcode, '')
  )) as address_line,
  l.phone
from public.locations l
where l.type = 'lab'
  and coalesce(l.is_venneir, false) = true
order by l.name;

grant select on public.lng_widget_locations to anon, authenticated, service_role;

comment on view public.lng_widget_locations is
  'Anon-readable subset of the locations table that the booking widget reads at mount. Includes postcode in address_line (M17).';

-- ── 2. lng_widget_manage_token RPC ───────────────────────────────

create or replace function public.lng_widget_manage_token(
  p_appointment_id uuid
)
returns table (
  manage_token       uuid,
  location_address   text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  select
    a.manage_token,
    trim(both ', ' from concat_ws(
      ', ',
      nullif(l.address,  ''),
      nullif(l.city,     ''),
      nullif(l.postcode, '')
    )) as location_address
  from public.lng_appointments a
  left join public.locations l on l.id = a.location_id
  where a.id = p_appointment_id
  limit 1;
end;
$$;

grant execute on function public.lng_widget_manage_token(uuid) to authenticated, service_role;

comment on function public.lng_widget_manage_token(uuid) is
  'Staff-only lookup that returns the appointment''s manage_token + composed location address (incl. postcode, M17). Used by the staff-side resend-confirmation flow.';

-- ── 3. lng_widget_lookup_booking RPC ─────────────────────────────

drop function if exists public.lng_widget_lookup_booking(uuid);

create or replace function public.lng_widget_lookup_booking(
  p_token uuid
)
returns table (
  appointment_ref          text,
  status                   text,
  service_type             text,
  service_label            text,
  start_at                 timestamptz,
  end_at                   timestamptz,
  location_id              uuid,
  location_name            text,
  location_address         text,
  patient_first_name       text,
  deposit_status           text,
  deposit_pence            int,
  deposit_currency         text,
  paid_in_full_at_booking  boolean,
  repair_variant           text,
  product_key              text,
  arch                     text,
  cancellable              boolean,
  repair_items             jsonb,
  upgrades                 jsonb
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
    trim(both ', ' from concat_ws(
      ', ',
      nullif(l.address,  ''),
      nullif(l.city,     ''),
      nullif(l.postcode, '')
    ))                                                        as location_address,
    p.first_name                                              as patient_first_name,
    a.deposit_status,
    a.deposit_pence,
    a.deposit_currency,
    coalesce(a.paid_in_full_at_booking, false)                as paid_in_full_at_booking,
    a.repair_variant,
    a.product_key,
    a.arch,
    (a.status = 'booked' and a.start_at > now())              as cancellable,
    coalesce(
      (
        select jsonb_agg(jsonb_build_object(
          'name',             r.name,
          'arch',             r.arch,
          'unit_label',       r.unit_label,
          'quantity',         r.quantity,
          'line_total_pence', r.line_total_pence,
          -- M17: per-line variant so the manage-page reschedule
          -- slot picker can honour every variant's pool claims,
          -- not just the appointment row's effective variant.
          'repair_variant',   r.repair_variant
        ) order by r.created_at)
        from public.lng_appointment_repair_items r
        where r.appointment_id = a.id
      ),
      '[]'::jsonb
    )                                                         as repair_items,
    coalesce(
      (
        select jsonb_agg(jsonb_build_object(
          'name',                 u.name,
          'resolved_price_pence', u.resolved_price_pence
        ) order by u.created_at)
        from public.lng_appointment_upgrade_selections u
        where u.appointment_id = a.id
      ),
      '[]'::jsonb
    )                                                         as upgrades
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
  'Patient-side booking lookup for the manage page. Anon-callable. Address now includes postcode (M17); repair_items now carries repair_variant per line so the reschedule slot picker can be cart-aware.';

-- ── 4. lng_widget_lookup_appointment_id RPC ──────────────────────

create or replace function public.lng_widget_lookup_appointment_id(
  p_appointment_ref text
)
returns table (
  appointment_ref          text,
  status                   text,
  service_type             text,
  service_label            text,
  start_at                 timestamptz,
  end_at                   timestamptz,
  location_id              uuid,
  location_name            text,
  location_address         text,
  patient_first_name       text,
  deposit_status           text,
  deposit_pence            int,
  deposit_currency         text,
  paid_in_full_at_booking  boolean,
  repair_variant           text,
  product_key              text,
  arch                     text,
  cancellable              boolean,
  repair_items             jsonb,
  upgrades                 jsonb
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
    trim(both ', ' from concat_ws(
      ', ',
      nullif(l.address,  ''),
      nullif(l.city,     ''),
      nullif(l.postcode, '')
    ))                                                        as location_address,
    p.first_name                                              as patient_first_name,
    a.deposit_status,
    a.deposit_pence,
    a.deposit_currency,
    coalesce(a.paid_in_full_at_booking, false)                as paid_in_full_at_booking,
    a.repair_variant,
    a.product_key,
    a.arch,
    (a.status = 'booked' and a.start_at > now())              as cancellable,
    coalesce(
      (
        select jsonb_agg(jsonb_build_object(
          'name',             r.name,
          'arch',             r.arch,
          'unit_label',       r.unit_label,
          'quantity',         r.quantity,
          'line_total_pence', r.line_total_pence,
          'repair_variant',   r.repair_variant
        ) order by r.created_at)
        from public.lng_appointment_repair_items r
        where r.appointment_id = a.id
      ),
      '[]'::jsonb
    )                                                         as repair_items,
    coalesce(
      (
        select jsonb_agg(jsonb_build_object(
          'name',                 u.name,
          'resolved_price_pence', u.resolved_price_pence
        ) order by u.created_at)
        from public.lng_appointment_upgrade_selections u
        where u.appointment_id = a.id
      ),
      '[]'::jsonb
    )                                                         as upgrades
  from public.lng_appointments a
  left join public.locations l on l.id = a.location_id
  left join public.patients p on p.id = a.patient_id
  where a.appointment_ref = p_appointment_ref
  limit 1;
end;
$$;

grant execute on function public.lng_widget_lookup_appointment_id(text) to authenticated, service_role;

comment on function public.lng_widget_lookup_appointment_id(text) is
  'Staff-side appointment lookup by appointment_ref (LAP-XXXXX). Same shape as lng_widget_lookup_booking; both include postcode in address (M17) and repair_variant on each repair_items entry.';
