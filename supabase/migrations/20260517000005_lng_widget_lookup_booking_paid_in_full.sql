-- ─────────────────────────────────────────────────────────────────────────────
-- Lounge — extend manage-page lookup with paid_in_full_at_booking
--
-- The customer self-serve manage page already shows "Deposit
-- paid · £25.00" when the patient paid a deposit at booking time.
-- It DOESN'T currently show anything when the patient paid the
-- full balance at booking via the widget's "Pay now in full"
-- option — that signal lives on lng_appointments.paid_in_full_at_booking
-- but isn't returned by the lookup RPC, so the manage page can't
-- distinguish "deposit paid" from "paid in full".
--
-- This migration extends the lookup RPC with that one boolean.
-- Manage.tsx renders "Paid in full at booking" when true, and
-- falls back to the existing "Deposit paid · £…" copy otherwise.
--
-- Same token-gated security boundary; same data-shape rules
-- (no PII, no other patient's row).
--
-- Rollback: drop the column from the return shape and recreate
-- the function without it.
-- ─────────────────────────────────────────────────────────────────────────────

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
    trim(both ', ' from concat_ws(', ',
      nullif(l.address, ''),
      nullif(l.city, '')
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
          'line_total_pence', r.line_total_pence
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
  'Patient-side booking lookup for the manage page. Anon-callable. Returns service / location / time / status / deposit (including paid-in-full flag) / axes / repair items / upgrades — never email, phone, notes, staff assignments, or any other patient''s row.';
