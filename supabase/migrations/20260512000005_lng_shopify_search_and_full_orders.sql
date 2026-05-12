-- Two related changes to the patient ↔ Shopify surface:
--
-- 1. lng_patient_shopify_orders replaces lng_patient_outstanding_shopify_orders.
--    The Patient Profile card now lists every order linked to the patient
--    (paid, fulfilled, cancelled, refunded — everything), not just the
--    open ones. Staff want the full Shopify history alongside the patient,
--    same way they read the appointment list: the order STATUS is what
--    tells them whether it's still in play.
--
-- 2. lng_find_patient_ids_by_shopify_order(p_query text) lets the patient
--    search resolve a Shopify order number (VEN73520, PSG-991630, etc) to
--    the patient who placed it. Prefix-matches on shopify_orders.name
--    (case-insensitive), bypasses shopify_orders' admin-only RLS via
--    SECURITY DEFINER, and returns patient ids the caller's regular
--    patients RLS will then filter down on the follow-up SELECT.
--
-- A supporting expression index on lower(shopify_orders.name) keeps the
-- prefix lookup O(log n) — without it a 57k-row ILIKE scan would dominate
-- every keystroke on the directory.

-- ── 1. Prefix-search index on shopify_orders.name ────────────────────────
-- text_pattern_ops lets the optimiser use the index for LIKE 'prefix%' on
-- the lowered column. Wrapped in a DO block because the shadow project
-- (vkgghplhykavklevfhkz) doesn't carry Meridian's shopify_orders table,
-- and the migration needs to apply cleanly on both for the workflow's
-- shadow-then-prod verification step.

do $$
begin
  if exists (
    select 1 from pg_tables
    where schemaname = 'public' and tablename = 'shopify_orders'
  ) and not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'lng_shopify_orders_name_lookup_idx'
  ) then
    execute 'create index lng_shopify_orders_name_lookup_idx '
         || 'on public.shopify_orders (lower(name) text_pattern_ops)';
  end if;
end$$;


-- ── 2. lng_find_patient_ids_by_shopify_order ─────────────────────────────
-- Maps a Shopify order-number fragment to patient ids. Used by the patient
-- search box on the Patients directory and the picker. Returns one row per
-- (patient, order_name) so the front end can label the match if it wants;
-- duplicates per patient are fine since the result is a candidate set.
--
-- plpgsql (not sql) so that the function body is parsed lazily — the
-- shadow project doesn't have public.shopify_orders, and a sql function
-- would fail to resolve the relation at CREATE time. plpgsql defers the
-- lookup to first call, which on shadow never happens because Lounge
-- runs against Meridian in every environment.

create or replace function public.lng_find_patient_ids_by_shopify_order(
  p_query text
)
returns table (
  patient_id  uuid,
  order_name  text,
  created_at  timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return query
  select
    p.id   as patient_id,
    o.name as order_name,
    o.created_at
  from public.shopify_orders o
  join public.patients p
    on p.shopify_customer_id = o.customer_id::text
  where char_length(coalesce(p_query, '')) >= 3
    and lower(o.name) like lower(p_query) || '%'
    and coalesce(o.is_test, false) = false
  order by o.created_at desc
  limit 25;
end;
$$;

grant execute on function public.lng_find_patient_ids_by_shopify_order(text)
  to anon, authenticated, service_role;

comment on function public.lng_find_patient_ids_by_shopify_order(text) is
  'Resolve a Shopify order-number prefix to the patient who placed it. Used by the Lounge patient search to make order numbers (VEN73520, PSG-991630) directly searchable. SECURITY DEFINER bypasses shopify_orders admin RLS; the caller-side patients SELECT applies the patients RLS.';


-- ── 3. lng_patient_shopify_orders ────────────────────────────────────────
-- Returns every Shopify order linked to the patient, in reverse-chrono
-- order. Replaces the older lng_patient_outstanding_shopify_orders RPC
-- (which is dropped below). Status filters now live in the UI — the
-- function is purely "fetch the history".

create or replace function public.lng_patient_shopify_orders(
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
  cancelled_at         timestamptz,
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
  -- Caller-side RLS gate — see lng_patient_outstanding_shopify_orders
  -- in 20260512000004 for the same pattern. If the caller can't see
  -- the patient via the patients RLS, this read returns null and the
  -- function returns no rows.
  select p.shopify_customer_id
    into v_customer_id
    from public.patients p
   where p.id = p_patient_id;

  if v_customer_id is null then
    return;
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
    o.cancelled_at,
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
    and coalesce(o.is_test, false) = false
  order by o.created_at desc;
end;
$$;

grant execute on function public.lng_patient_shopify_orders(uuid)
  to anon, authenticated, service_role;

comment on function public.lng_patient_shopify_orders(uuid) is
  'Returns every Shopify order linked to a Lounge patient (paid, fulfilled, cancelled, refunded — the full history). SECURITY DEFINER bypasses shopify_orders admin RLS; caller-side RLS on patients gates which patients are addressable.';

-- Drop the predecessor that only returned outstanding orders. Lounge is
-- the sole caller (this RPC was added in 20260512000004); nothing else
-- depends on it.
drop function if exists public.lng_patient_outstanding_shopify_orders(uuid);

NOTIFY pgrst, 'reload schema';
