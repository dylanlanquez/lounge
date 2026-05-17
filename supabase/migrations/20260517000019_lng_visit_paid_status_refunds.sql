-- lng_visit_paid_status — subtract refunds from amount_paid_pence.
--
-- Before this migration the view summed three positive terms:
--   succeeded lng_payments  +  paid deposit  +  shopify credit
--
-- That stayed correct as long as nothing ever refunded. With the
-- new lng_payment_refunds table any refund (cart-side payment OR
-- widget-deposit) needs to drop amount_paid_pence by the same
-- amount so the "outstanding balance" and the "we owe them" math
-- agree across surfaces.
--
-- Both refund sources are netted out:
--   • Refunds against lng_payments  → subtract from the payments
--     term (succeeded lng_payments minus succeeded refunds against
--     those payments).
--   • Refunds against the widget deposit → subtract from the
--     deposit term (clamped at 0 — we don't carry a negative
--     deposit contribution if someone over-refunded).
--
-- Shopify credit isn't refundable via Lounge today (those refunds
-- happen on Shopify itself), so the third term is unchanged.

create or replace view public.lng_visit_paid_status as
select
  v.id  as visit_id,
  c.id  as cart_id,
  c.total_pence as amount_due_pence,
  (
    -- payments — succeeded captures net of succeeded refunds
    coalesce((
      select sum(p.amount_pence)
      from public.lng_payments p
      where p.cart_id = c.id and p.status = 'succeeded'
    ), 0)
    - coalesce((
      select sum(r.amount_pence)
      from public.lng_payment_refunds r
      join public.lng_payments p on p.id = r.payment_id
      where p.cart_id = c.id and r.status = 'succeeded'
    ), 0)
    -- deposit — paid amount net of deposit-source refunds, clamped
    -- at 0 in case the data ever drifts.
    + greatest(
        0,
        case
          when a.deposit_status = 'paid' then coalesce(a.deposit_pence, 0)
          else 0
        end
        - coalesce((
          select sum(r.amount_pence)
          from public.lng_payment_refunds r
          where r.deposit_appointment_id = a.id and r.status = 'succeeded'
        ), 0)
      )
    -- shopify credit — Shopify-side refunds, not Lounge's problem.
    + coalesce(a.shopify_order_total_pence, 0)
  )::int as amount_paid_pence,
  case
    when c.total_pence is null or c.total_pence = 0 then 'free_visit'
    when (
      coalesce((
        select sum(p.amount_pence)
        from public.lng_payments p
        where p.cart_id = c.id and p.status = 'succeeded'
      ), 0)
      - coalesce((
        select sum(r.amount_pence)
        from public.lng_payment_refunds r
        join public.lng_payments p on p.id = r.payment_id
        where p.cart_id = c.id and r.status = 'succeeded'
      ), 0)
      + greatest(
          0,
          case
            when a.deposit_status = 'paid' then coalesce(a.deposit_pence, 0)
            else 0
          end
          - coalesce((
            select sum(r.amount_pence)
            from public.lng_payment_refunds r
            where r.deposit_appointment_id = a.id and r.status = 'succeeded'
          ), 0)
        )
      + coalesce(a.shopify_order_total_pence, 0)
    ) >= c.total_pence
      then 'paid'
    when (
      coalesce((
        select sum(p.amount_pence)
        from public.lng_payments p
        where p.cart_id = c.id and p.status = 'succeeded'
      ), 0)
      - coalesce((
        select sum(r.amount_pence)
        from public.lng_payment_refunds r
        join public.lng_payments p on p.id = r.payment_id
        where p.cart_id = c.id and r.status = 'succeeded'
      ), 0)
      + greatest(
          0,
          case
            when a.deposit_status = 'paid' then coalesce(a.deposit_pence, 0)
            else 0
          end
          - coalesce((
            select sum(r.amount_pence)
            from public.lng_payment_refunds r
            where r.deposit_appointment_id = a.id and r.status = 'succeeded'
          ), 0)
        )
      + coalesce(a.shopify_order_total_pence, 0)
    ) > 0
      then 'partially_paid'
    else 'owed'
  end as paid_status
from public.lng_visits v
left join public.lng_carts        c on c.visit_id = v.id
left join public.lng_appointments a on a.id = v.appointment_id;

comment on view public.lng_visit_paid_status is
  'Derived paid status per visit. amount_paid_pence = succeeded lng_payments (less their refunds) + paid deposit (less its refunds, clamped at 0) + linked Shopify-order credit. paid_status reflects the combined coverage; free_visit when the cart total is zero. Recomputed on read.';

NOTIFY pgrst, 'reload schema';
