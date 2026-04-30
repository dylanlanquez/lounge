-- 20260430000015_lng_cart_subtotal_active_only.sql
--
-- Patch lng_cart_items_resync_subtotal so it sums only ACTIVE lines.
--
-- The original trigger (in 20260428000009_lng_carts_cart_items.sql)
-- summed every row in lng_cart_items for a given cart, regardless of
-- removed_at. After soft-delete arrived (20260430000010) this meant
-- lng_carts.subtotal_pence stayed inflated by the removed line, and
-- because lng_carts.total_pence is GENERATED ALWAYS AS
-- (subtotal_pence - discount_pence + tax_pence) the inflation flowed
-- through to total_pence and to lng_visit_paid_status.amount_due_pence.
--
-- Symptom Dylan saw: after staff removed an item the In Clinic board's
-- price didn't drop. The cashier-side surfaces (VisitDetail, Pay) sum
-- items client-side with a removed_at filter, so they were already
-- correct — the bug was only on derived state that reads total_pence.
--
-- Fix is one line in the SELECT: add `and removed_at is null`. Trigger
-- timing, signature, and the three triggers that reference it stay
-- exactly the same, so we replace the function body in place.
--
-- Backfill: a single UPDATE re-runs the new sum across every existing
-- cart so historical state heals immediately. Cheap; lng_cart_items
-- is small.

create or replace function public.lng_cart_items_resync_subtotal()
returns trigger
language plpgsql
as $$
declare
  v_cart_id uuid;
begin
  v_cart_id := coalesce(new.cart_id, old.cart_id);
  update public.lng_carts c
     set subtotal_pence = coalesce((
           select sum(line_total_pence)::int
             from public.lng_cart_items
            where cart_id = v_cart_id
              and removed_at is null
         ), 0),
         updated_at = now()
   where c.id = v_cart_id;
  return null;
end;
$$;

-- Backfill — recompute subtotal_pence for every cart so any existing
-- carts that already had a soft-deleted line drop to the right total.
update public.lng_carts c
   set subtotal_pence = coalesce((
         select sum(line_total_pence)::int
           from public.lng_cart_items
          where cart_id = c.id
            and removed_at is null
       ), 0)
 where exists (
   select 1
     from public.lng_cart_items i
    where i.cart_id = c.id
      and i.removed_at is not null
 );

-- ── Rollback ───────────────────────────────────────────────────────────────
-- create or replace function public.lng_cart_items_resync_subtotal()
-- returns trigger
-- language plpgsql
-- as $$
-- declare
--   v_cart_id uuid;
-- begin
--   v_cart_id := coalesce(new.cart_id, old.cart_id);
--   update public.lng_carts c
--      set subtotal_pence = coalesce((
--            select sum(line_total_pence)::int
--              from public.lng_cart_items
--             where cart_id = v_cart_id
--          ), 0),
--          updated_at = now()
--    where c.id = v_cart_id;
--   return null;
-- end;
-- $$;
