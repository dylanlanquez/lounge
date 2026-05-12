-- lng_patient_outstanding_shopify_orders
--
-- Lounge's Patient Profile surfaces a patient's outstanding Shopify orders
-- alongside their appointment history. shopify_orders carries RLS that
-- only grants SELECT to admins, so Lounge staff (who are location-scoped
-- but not admin) can't query it directly. This SECURITY DEFINER RPC
-- bridges the gap: it checks the caller can read the patient row via the
-- patients RLS (location-scoped), and only then returns that patient's
-- outstanding orders. Non-admins get exactly what they need to do their
-- job without granting blanket access to the orders table.
--
-- "Outstanding" semantics (Dylan, 12 May 2026):
--   • Not cancelled         (cancelled_at IS NULL)
--   • Not fully refunded    (financial_status <> 'refunded')
--   • Not fully fulfilled   (fulfillment_status <> 'fulfilled' or null)
--
-- Items are aggregated into a JSON array so the front end renders the
-- order summary line without a second round trip.

create or replace function public.lng_patient_outstanding_shopify_orders(
  p_patient_id uuid
)
returns table (
  id                   bigint,
  name                 text,
  created_at           timestamptz,
  total_price          numeric,
  currency             text,
  financial_status     text,
  fulfillment_status   text,
  refund_amount        numeric,
  items                jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_customer_id text;
begin
  -- Caller-side RLS gate. The patients table is location-scoped (see
  -- patients_select policy); if the caller can't read this row through
  -- normal RLS, they can't ask about that patient's orders either.
  -- SECURITY INVOKER on a SELECT here intentionally returns no rows
  -- when the caller is unauthorised, which short-circuits the rest.
  select p.shopify_customer_id
    into v_customer_id
    from public.patients p
   where p.id = p_patient_id;

  if v_customer_id is null then
    return; -- patient not Shopify-linked, or RLS hid the row
  end if;

  return query
  select
    o.id,
    o.name,
    o.created_at,
    o.current_total_price as total_price,
    o.currency,
    o.financial_status,
    o.fulfillment_status,
    coalesce(o.refund_amount, 0)::numeric as refund_amount,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'title',    i.title,
            'sku',      i.sku,
            'quantity', i.quantity,
            'price',    i.price
          )
          order by i.id
        )
        from public.shopify_order_items i
        where i.order_id = o.id
      ),
      '[]'::jsonb
    ) as items
  from public.shopify_orders o
  where o.customer_id::text = v_customer_id
    and o.cancelled_at is null
    and coalesce(o.financial_status, '') <> 'refunded'
    and coalesce(o.fulfillment_status, '') <> 'fulfilled'
    and coalesce(o.is_test, false) = false
  order by o.created_at desc;
end;
$$;

grant execute on function public.lng_patient_outstanding_shopify_orders(uuid)
  to anon, authenticated, service_role;

comment on function public.lng_patient_outstanding_shopify_orders(uuid) is
  'Returns outstanding Shopify orders for a Lounge patient. SECURITY DEFINER bypasses shopify_orders admin RLS; caller-side RLS on patients gates which patients are addressable.';

NOTIFY pgrst, 'reload schema';
