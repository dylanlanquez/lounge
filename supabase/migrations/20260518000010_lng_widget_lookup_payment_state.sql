-- ─────────────────────────────────────────────────────────────────────────────
-- Lounge — full payment state on the manage-page lookup RPC
--
-- The customer self-serve manage page reads
-- `lng_widget_lookup_booking(p_token)` and the Manage.tsx client code
-- reads several fields off the result that the RPC has never actually
-- returned:
--
--   * `id`                       — used as the exclude target for the
--                                  reschedule slot picker, so the
--                                  patient's own current slot stays
--                                  bookable. Empty string today, which
--                                  the slot RPC silently treats as "no
--                                  exclusion".
--   * `paid_in_full_at_booking`  — drives the "Paid in full at booking ·
--                                  £X" payment line. Always coerced to
--                                  false today, so every full-payment
--                                  booking renders without a payment row
--                                  at all (the manage page falls through
--                                  to the deposit branch, which is also
--                                  empty, and shows nothing).
--   * `join_url`                 — virtual bookings need this to render
--                                  the "Join the meeting" CTA in place of
--                                  the clinic address row. Currently null
--                                  in the client, which means the manage
--                                  page silently keeps showing the
--                                  clinic address for a remote
--                                  appointment.
--
-- Same-day upgrade booked from Checkpoint adds a fourth case the
-- existing RPC doesn't surface: the booking is "paid" via a linked
-- Shopify order (paymentMode='on_the_day', deposit_status null,
-- shopify_order_id NOT null). Without surfacing the order, the manage
-- page falls through every branch and shows no payment row, leaving
-- the patient unsure whether anything is owed in clinic. Add
-- shopify_order_id, shopify_order_name, shopify_order_total_pence,
-- shopify_order_currency so the email and the manage page can render
-- a fourth payment state: "Paid via order #1234 · £149.00".
--
-- All additions are additive (existing columns kept, in the same
-- order). Rollback: drop the function and re-apply 20260517000004.
-- ─────────────────────────────────────────────────────────────────────────────

drop function if exists public.lng_widget_lookup_booking(uuid);

create or replace function public.lng_widget_lookup_booking(
  p_token uuid
)
returns table (
  id                          uuid,
  appointment_ref             text,
  status                      text,
  service_type                text,
  service_label               text,
  start_at                    timestamptz,
  end_at                      timestamptz,
  location_id                 uuid,
  location_name               text,
  location_address            text,
  patient_first_name          text,
  deposit_status              text,
  deposit_pence               int,
  deposit_currency            text,
  paid_in_full_at_booking     boolean,
  repair_variant              text,
  product_key                 text,
  arch                        text,
  cancellable                 boolean,
  join_url                    text,
  shopify_order_id            text,
  shopify_order_name          text,
  shopify_order_total_pence   int,
  shopify_order_currency      text,
  repair_items                jsonb,
  upgrades                    jsonb
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
    a.paid_in_full_at_booking,
    a.repair_variant,
    a.product_key,
    a.arch,
    (a.status in ('booked', 'joined') and a.start_at > now()) as cancellable,
    a.join_url,
    a.shopify_order_id,
    a.shopify_order_name,
    a.shopify_order_total_pence,
    a.shopify_order_currency,
    -- Repair items snapshot, oldest first so the patient sees them
    -- in the order they ticked them. Empty array when none.
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
    -- Upgrade selections snapshot. Same ordering rule.
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
  'Patient-side booking lookup for the manage page. Anon-callable. Returns service / location / time / status / deposit / axes / virtual join URL / linked Shopify order summary + repair items + upgrades snapshots — never email, phone, notes, staff assignments, or any other patient''s row.';
