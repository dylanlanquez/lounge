-- 20260513000001_lng_shopify_order_credit.sql
--
-- Links a Shopify order to an in-person Lounge appointment so the
-- amount the customer already paid online lands as a credit on the
-- final balance. The use case: a customer buys a Whitening Kit on
-- venneir.com (paying £199), can't get the impression right at home,
-- and books an in-clinic impression appointment. At checkout the
-- £199 already paid through Shopify reduces what they owe at the
-- till, the same way a Calendly deposit currently does.
--
-- Three pieces:
--   1. lwo_catalogue.sold_on_shopify  — per-service flag the admin
--      ticks on services whose flow involves a Shopify-paid product
--      (impression appointments, etc.). Drives the booking form to
--      ask for an order number.
--   2. lng_appointments.shopify_order_*  — the attached order's
--      identifiers + total + currency. Sits alongside the existing
--      deposit_* columns; the two are independent (a single booking
--      could in theory carry both, though in practice it's one or
--      the other).
--   3. lng_lookup_shopify_order RPC  — front-end-callable RPC that
--      resolves an order name (e.g. "VEN73520") to the row's id,
--      name, total, currency, financial_status, customer_id. Used
--      by the booking form to fetch the order details when the
--      receptionist types the number, and by validation to confirm
--      the order is paid + refundable before attaching.

-- ── 1. Catalogue flag ────────────────────────────────────────────
alter table public.lwo_catalogue
  add column if not exists sold_on_shopify boolean not null default false;

comment on column public.lwo_catalogue.sold_on_shopify is
  'When true, the booking form asks for a Shopify order number on every new booking of this service. The order total credits against the cart at checkout.';

-- ── 2. Appointment columns ───────────────────────────────────────
alter table public.lng_appointments
  add column if not exists shopify_order_id          text,
  add column if not exists shopify_order_name        text,
  add column if not exists shopify_order_total_pence integer,
  add column if not exists shopify_order_currency    text,
  add column if not exists shopify_order_linked_at   timestamptz,
  add column if not exists shopify_order_linked_by   uuid references public.accounts(id) on delete set null;

comment on column public.lng_appointments.shopify_order_id is
  'Shopify internal numeric id of the linked order (string form for safety). Pulls from public.shopify_orders.id.';
comment on column public.lng_appointments.shopify_order_name is
  'Human-readable order number (e.g. VEN73520). Surfaced on the appointment detail and patient-facing waiver as "Shopify order VEN73520".';
comment on column public.lng_appointments.shopify_order_total_pence is
  'Order total at link time, in pence. Credited against the cart at checkout like a deposit.';

create index if not exists lng_appointments_shopify_order_idx
  on public.lng_appointments (shopify_order_id)
  where shopify_order_id is not null;

-- ── 3. Order lookup RPC ──────────────────────────────────────────
-- SECURITY DEFINER because the shopify_orders table has admin-only
-- RLS — the same pattern as lng_patient_shopify_orders /
-- lng_find_patient_ids_by_shopify_order. Returns at most one row; an
-- unknown name returns zero rows.
--
-- Shadow project (vkgghplhykavklevfhkz) doesn't carry the
-- shopify_orders table, so the RPC body is plpgsql-deferred (no
-- relation resolution at create time). On shadow this is a no-op
-- RPC; in production it hits the real table.
create or replace function public.lng_lookup_shopify_order(
  p_order_name text
)
returns table (
  id                 text,
  name               text,
  customer_id        text,
  customer_email     text,
  total_price_pence  integer,
  currency           text,
  financial_status   text,
  fulfillment_status text,
  cancelled_at       timestamptz,
  created_at         timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cleaned text;
begin
  if p_order_name is null or length(btrim(p_order_name)) = 0 then
    return;
  end if;

  -- Accept "VEN73520", "#VEN73520", "ven73520" interchangeably. The
  -- shopify_orders.name column stores the value as-shown to the
  -- customer (with #, capitalised); the prefix-search index runs on
  -- lower(name) so the case-insensitive match needs the lowercased
  -- input.
  v_cleaned := btrim(p_order_name);
  v_cleaned := regexp_replace(v_cleaned, '^#', '');

  return query
  execute format($f$
    select
      o.id::text                                                              as id,
      o.name                                                                  as name,
      o.customer_id::text                                                     as customer_id,
      c.email                                                                 as customer_email,
      coalesce(round(o.current_total_price * 100)::int, 0)                    as total_price_pence,
      o.currency                                                              as currency,
      o.financial_status                                                      as financial_status,
      o.fulfillment_status                                                    as fulfillment_status,
      o.cancelled_at                                                          as cancelled_at,
      o.created_at                                                            as created_at
    from public.shopify_orders o
    left join public.shopify_customers c on c.id = o.customer_id
    where lower(o.name) = lower(%L)
       or lower(o.name) = '#' || lower(%L)
    order by o.created_at desc
    limit 1
  $f$, v_cleaned, v_cleaned);
exception when undefined_table then
  -- shopify_orders / shopify_customers missing (shadow project) →
  -- return no rows so callers degrade gracefully without erroring.
  return;
end;
$$;

grant execute on function public.lng_lookup_shopify_order(text)
  to anon, authenticated, service_role;

comment on function public.lng_lookup_shopify_order(text) is
  'Resolve a Shopify order number to its core fields. Used by the booking form to attach a Shopify-paid order to a new appointment so the amount paid online credits against the cart at checkout.';

NOTIFY pgrst, 'reload schema';
