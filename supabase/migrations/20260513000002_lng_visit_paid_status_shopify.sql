-- 20260513000002_lng_visit_paid_status_shopify.sql
--
-- Adds the Shopify-order credit (lng_appointments.shopify_order_total_pence
-- from 20260513000001) to lng_visit_paid_status alongside the existing
-- Calendly deposit term. Without this, a £199 cart on an appointment
-- linked to a £199 Shopify whitening-kit order would still read as
-- 'owed' at the In Clinic + Pay surfaces — even though the cart has
-- nothing to collect, because maybeFlipCartPaid (which DOES see the
-- credit) only flips the row to status='paid' once the till+deposit+
-- shopify cumulative hits the total, AND the UI reads the view, not
-- the row.
--
-- Both surfaces now agree: amount_paid_pence sums succeeded payments
-- + paid deposit + shopify credit; paid_status flips accordingly.

create or replace view public.lng_visit_paid_status as
select
  v.id  as visit_id,
  c.id  as cart_id,
  c.total_pence as amount_due_pence,
  (
    coalesce(sum(p.amount_pence) filter (where p.status = 'succeeded'), 0)
    + coalesce(max(case when a.deposit_status = 'paid' then a.deposit_pence else 0 end), 0)
    + coalesce(max(a.shopify_order_total_pence), 0)
  )::int as amount_paid_pence,
  case
    when c.total_pence is null or c.total_pence = 0 then 'free_visit'
    when (
      coalesce(sum(p.amount_pence) filter (where p.status = 'succeeded'), 0)
      + coalesce(max(case when a.deposit_status = 'paid' then a.deposit_pence else 0 end), 0)
      + coalesce(max(a.shopify_order_total_pence), 0)
    ) >= c.total_pence
      then 'paid'
    when (
      coalesce(sum(p.amount_pence) filter (where p.status = 'succeeded'), 0)
      + coalesce(max(case when a.deposit_status = 'paid' then a.deposit_pence else 0 end), 0)
      + coalesce(max(a.shopify_order_total_pence), 0)
    ) > 0
      then 'partially_paid'
    else 'owed'
  end as paid_status
from public.lng_visits v
left join public.lng_carts        c on c.visit_id = v.id
left join public.lng_payments     p on p.cart_id = c.id
left join public.lng_appointments a on a.id = v.appointment_id
group by v.id, c.id, c.total_pence;

comment on view public.lng_visit_paid_status is
  'Derived paid status per visit. amount_paid_pence sums succeeded lng_payments, the paid Calendly deposit, and any linked Shopify-order credit. paid_status reflects the combined coverage; free_visit when the cart total is zero. Recomputed on read.';

NOTIFY pgrst, 'reload schema';
