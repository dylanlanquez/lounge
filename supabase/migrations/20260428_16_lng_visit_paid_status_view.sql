-- 20260428_16_lng_visit_paid_status_view.sql
-- Derived paid_status for a visit. Brief §5.4 mandates "never store this as a
-- column. Always compute." This view is the canonical computation.
--
-- Possible values:
--   no_charge       no cart, or cart total = 0
--   paid            sum(succeeded payments) >= cart total
--   partially_paid  some succeeded payments, but less than cart total
--   unpaid          no succeeded payments
--
-- Rollback: DROP VIEW public.lng_visit_paid_status;

create or replace view public.lng_visit_paid_status as
select
  v.id  as visit_id,
  c.id  as cart_id,
  c.total_pence as amount_due_pence,
  coalesce(sum(p.amount_pence) filter (where p.status = 'succeeded'), 0)::int
       as amount_paid_pence,
  case
    when c.total_pence is null or c.total_pence = 0 then 'no_charge'
    when coalesce(sum(p.amount_pence) filter (where p.status = 'succeeded'), 0) >= c.total_pence
      then 'paid'
    when coalesce(sum(p.amount_pence) filter (where p.status = 'succeeded'), 0) > 0
      then 'partially_paid'
    else 'unpaid'
  end as paid_status
from public.lng_visits v
left join public.lng_carts    c on c.visit_id = v.id
left join public.lng_payments p on p.cart_id = c.id
group by v.id, c.id, c.total_pence;

comment on view public.lng_visit_paid_status is
  'Derived paid status per visit. Never stored. Recomputed on read.';
