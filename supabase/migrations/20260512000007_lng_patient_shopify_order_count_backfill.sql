-- patients.shopify_order_count was added by Meridian migration
-- 20260512_17 with a backfill that counted existing rows and a trigger
-- that maintains the value on shopify_orders INSERT / DELETE / UPDATE
-- of customer_id. That covers the steady state — every new order
-- correctly increments the linked patient's count.
--
-- It does NOT cover the race condition where the order webhook lands
-- before the customers/create webhook for the same Shopify customer:
--   • orders/paid arrives → trigger fires → looks up patient with
--     matching shopify_customer_id → none yet → no-op.
--   • customers/create arrives later → patient row inserted with
--     shopify_order_count default 0 → forever shown as "Shopify
--     import with zero orders", which Lounge filters out.
--
-- Today this affects 39 patients on Meridian — Sophia Botnar
-- (MP-100007, owner of VEN88161) is the case Dylan flagged. All 39
-- are real Shopify customers with real orders, but they're invisible
-- in the Lounge directory because their count never caught up.
--
-- This migration:
--
--   1. One-time backfill — recomputes shopify_order_count from
--      shopify_orders for every patient and writes when the stored
--      value disagrees.
--   2. BEFORE INSERT trigger on patients — when a new patient row
--      arrives with a shopify_customer_id, count any orders that
--      already exist for that customer and seed the count before
--      the row lands. Closes the order-before-patient race.
--   3. BEFORE UPDATE OF shopify_customer_id trigger — when an
--      existing patient gets relinked to a different Shopify
--      customer (rare, but happens via staff-link-shopify-customer),
--      recompute the count for the new customer.

-- ── 1. One-time backfill ────────────────────────────────────────────
-- DO block so the migration applies cleanly on shadow (which doesn't
-- carry Meridian's shopify_orders table or the shopify_order_count
-- column on patients). On Meridian both exist and the update runs.

do $$
begin
  if exists (
    select 1 from pg_tables
    where schemaname = 'public' and tablename = 'shopify_orders'
  ) and exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'patients'
      and column_name = 'shopify_order_count'
  ) then
    execute $sql$
      with actual as (
        select customer_id::text as scid, count(*)::int as n
        from public.shopify_orders
        where customer_id is not null
          and coalesce(is_test, false) = false
        group by 1
      )
      update public.patients p
         set shopify_order_count = coalesce(actual.n, 0)
        from actual
       where p.shopify_customer_id is not null
         and actual.scid = p.shopify_customer_id
         and p.shopify_order_count is distinct from actual.n
    $sql$;
  end if;
end$$;


-- ── 2. BEFORE INSERT seed ───────────────────────────────────────────

create or replace function public.maintain_patient_initial_shopify_order_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.shopify_customer_id is null then
    return new;
  end if;
  -- Count any orders already on file for this customer. The existing
  -- trg_maintain_patient_shopify_order_count handles future orders;
  -- this trigger handles orders that landed before the patient row.
  select count(*)::int
    into new.shopify_order_count
    from public.shopify_orders
   where customer_id::text = new.shopify_customer_id
     and coalesce(is_test, false) = false;
  return new;
end;
$$;

drop trigger if exists trg_initial_shopify_order_count on public.patients;
create trigger trg_initial_shopify_order_count
  before insert on public.patients
  for each row
  when (new.shopify_customer_id is not null)
  execute function public.maintain_patient_initial_shopify_order_count();


-- ── 3. BEFORE UPDATE OF shopify_customer_id ─────────────────────────
-- staff-link-shopify-customer moves a walk-in's shopify_customer_id
-- onto an existing patient. The order-side trigger doesn't fire (no
-- shopify_orders row changed), so the patient's count stays at zero
-- unless we recompute here.

create or replace function public.maintain_patient_relink_shopify_order_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.shopify_customer_id is null then
    new.shopify_order_count := 0;
    return new;
  end if;
  if old.shopify_customer_id is distinct from new.shopify_customer_id then
    select count(*)::int
      into new.shopify_order_count
      from public.shopify_orders
     where customer_id::text = new.shopify_customer_id
       and coalesce(is_test, false) = false;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_relink_shopify_order_count on public.patients;
create trigger trg_relink_shopify_order_count
  before update of shopify_customer_id on public.patients
  for each row
  execute function public.maintain_patient_relink_shopify_order_count();

NOTIFY pgrst, 'reload schema';
