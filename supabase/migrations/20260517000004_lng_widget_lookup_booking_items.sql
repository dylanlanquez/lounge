-- ─────────────────────────────────────────────────────────────────────────────
-- Lounge — extend manage-page lookup with repair items + upgrades
--
-- The customer self-serve manage page (`/widget/manage?token=…`)
-- already renders the booking summary (service, slot, location,
-- deposit). Dylan asked for it to also show:
--   • A per-arch table of repair lines + prices when the booking
--     is a denture repair.
--   • A list of upgrade selections + prices when the patient
--     picked any (scalloped retainers, thicker night guards, etc.).
--
-- This migration extends the existing lookup RPC to surface those
-- snapshots as JSONB arrays alongside the booking row. Same
-- security boundary (token-gated, anon-callable) — no need for a
-- second RPC and no extra round trip on the manage page.
--
-- Returned shapes (each row is one JSONB array element):
--   repair_items: { name, arch, unit_label, quantity, line_total_pence }
--   upgrades:     { name, resolved_price_pence }
--
-- Empty arrays for bookings that didn't pick any (non-denture-
-- repair or no upgrades). Order is preserved by created_at so the
-- table renders in the same order the patient picked.
--
-- Rollback: revert the function body to drop the two new columns.
-- ─────────────────────────────────────────────────────────────────────────────

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
  repair_items        jsonb,
  upgrades            jsonb
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
    -- Repair items snapshot, oldest first so the patient sees them
    -- in the order they ticked them. Empty array when none.
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
  'Patient-side booking lookup for the manage page. Anon-callable. Returns service / location / time / status / deposit / axes (for the reschedule slot picker) + repair items + upgrades snapshots — never email, phone, notes, staff assignments, or any other patient''s row.';
