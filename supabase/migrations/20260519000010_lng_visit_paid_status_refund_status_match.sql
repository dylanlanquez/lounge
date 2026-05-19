-- 20260519000003_lng_visit_paid_status_refund_status_match.sql
--
-- Fix double-subtraction bug after a full payment refund.
--
-- terminal-refund flips lng_payments.status to 'cancelled' once
-- cumulative refunds match the captured amount (see header in
-- supabase/functions/terminal-refund/index.ts). The previous shape
-- of this view summed succeeded captures and then subtracted every
-- succeeded refund whose payment row existed — regardless of that
-- payment's current status. After the flip, captures dropped to 0
-- but the refund kept subtracting, yielding negative amount_paid_
-- pence (e.g. £199 cash + £199 refund → -£199). Downstream the
-- Total row on VisitDetail rendered subtotal - (-amount_paid) =
-- 2 × subtotal (£398 on a £199 cart was the reported case).
--
-- Fix: also constrain the refund subqueries to payments whose
-- status is still 'succeeded'. A fully-refunded payment is now
-- excluded on BOTH sides of the subtraction — they cancel out to
-- zero rather than to a negative. Partial refunds leave the
-- payment as 'succeeded' (per the terminal-refund header), so
-- they still net correctly: succeeded captures stay in the sum,
-- their partial refunds still subtract. Deposit refunds are
-- unaffected — they live on a separate axis (deposit_appointment_
-- id) and the existing greatest(0, ...) clamp already handled
-- their edge case.
--
-- No other consumer needs to change: lng_payments status checks
-- in cashCounts / financials filter by status explicitly, so
-- they were already correct.

create or replace view public.lng_visit_paid_status as
select
  v.id  as visit_id,
  c.id  as cart_id,
  c.total_pence as amount_due_pence,
  (
    coalesce((
      select sum(p.amount_pence)
      from public.lng_payments p
      where p.cart_id = c.id and p.status = 'succeeded'
    ), 0)
    - coalesce((
      select sum(r.amount_pence)
      from public.lng_payment_refunds r
      join public.lng_payments p on p.id = r.payment_id
      where p.cart_id = c.id
        and r.status = 'succeeded'
        and p.status = 'succeeded'
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
        where p.cart_id = c.id
          and r.status = 'succeeded'
          and p.status = 'succeeded'
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
        where p.cart_id = c.id
          and r.status = 'succeeded'
          and p.status = 'succeeded'
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
  'Derived paid status per visit. amount_paid_pence = succeeded lng_payments (less their refunds, both sides constrained to status=succeeded so fully-refunded payments drop cleanly) + paid deposit (less its refunds, clamped at 0) + linked Shopify-order credit. Recomputed on read.';

NOTIFY pgrst, 'reload schema';
