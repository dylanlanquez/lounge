-- 20260513000003_lng_shopify_lookup_rpc_fix.sql
--
-- 20260513000001 joined shopify_orders to a non-existent
-- public.shopify_customers table; the exception handler in the RPC
-- swallowed the undefined-relation error and the function returned
-- zero rows for every order. That made the booking form's "Look up"
-- button always say "No Shopify order matching VEN…".
--
-- Fix: drop the customers join (we don't need the email — the
-- patient is the one we care about and the booking form already has
-- their email on file). Read the price from the same column
-- lng_patient_shopify_orders already standardised on
-- (current_total_price), with total_price as a fallback in case a
-- back-fill populated one but not the other.

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

  v_cleaned := btrim(p_order_name);
  v_cleaned := regexp_replace(v_cleaned, '^#', '');

  return query
  execute format($f$
    select
      o.id::text                                                                       as id,
      o.name                                                                           as name,
      o.customer_id::text                                                              as customer_id,
      null::text                                                                       as customer_email,
      coalesce(round(coalesce(o.current_total_price, o.total_price) * 100)::int, 0)    as total_price_pence,
      o.currency                                                                       as currency,
      o.financial_status                                                               as financial_status,
      o.fulfillment_status                                                             as fulfillment_status,
      o.cancelled_at                                                                   as cancelled_at,
      o.created_at                                                                     as created_at
    from public.shopify_orders o
    where lower(o.name) = lower(%L)
       or lower(o.name) = '#' || lower(%L)
    order by o.created_at desc
    limit 1
  $f$, v_cleaned, v_cleaned);
exception when undefined_table then
  return;
end;
$$;

grant execute on function public.lng_lookup_shopify_order(text)
  to anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
