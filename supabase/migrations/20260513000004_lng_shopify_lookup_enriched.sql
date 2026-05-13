-- 20260513000004_lng_shopify_lookup_enriched.sql
--
-- Richer lookup card: customer name (resolved through patients via
-- shopify_customer_id, since shopify_customers isn't replicated to
-- Meridian) + line items + a single status string the UI can switch
-- on to render the right tone.
--
-- The booking form's confirmation card uses every field this returns,
-- so the receptionist sees at a glance: "yes this is the right
-- customer, here's what they bought, and the order is in a state we
-- can credit".

-- Drop first because we're widening the return shape (added
-- customer_name + items). Postgres rejects a CREATE OR REPLACE that
-- changes the OUT-parameter signature.
drop function if exists public.lng_lookup_shopify_order(text);

create or replace function public.lng_lookup_shopify_order(
  p_order_name text
)
returns table (
  id                 text,
  name               text,
  customer_id        text,
  customer_email     text,
  customer_name      text,
  total_price_pence  integer,
  currency           text,
  financial_status   text,
  fulfillment_status text,
  cancelled_at       timestamptz,
  created_at         timestamptz,
  items              jsonb
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
      btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, ''))            as customer_name,
      coalesce(round(coalesce(o.current_total_price, o.total_price) * 100)::int, 0)    as total_price_pence,
      o.currency                                                                       as currency,
      o.financial_status                                                               as financial_status,
      o.fulfillment_status                                                             as fulfillment_status,
      o.cancelled_at                                                                   as cancelled_at,
      o.created_at                                                                     as created_at,
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
      )                                                                                as items
    from public.shopify_orders o
    left join public.patients p on p.shopify_customer_id::text = o.customer_id::text
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
