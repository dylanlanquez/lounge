-- 20260520000002_lng_ledger_refund_state_net.sql
--
-- Update lng_ledger refund_state and refunded_pence to reflect the
-- CURRENT NET state of the cart, not the lifetime refund history.
--
-- The previous shape (added in 20260519000011) classified any row
-- where lifetime succeeded refunds were > 0 and < gross captures as
-- 'partial'. Gross captures use succeeded_at (durable, not cleared
-- by terminal-refund's cancel flip) so they only ever grow. A
-- patient who paid → got refunded → paid again ended up with
-- gross > refunds but the cart was net-settled — the ledger row
-- stuck on "Partially refunded £X" forever, even though VisitDetail
-- correctly showed "Paid in full".
--
-- New rule mirrors the VisitDetail hero pill (see
-- src/routes/VisitDetail.tsx):
--
--   • refund_state = 'none' when refunded_pence = 0 (no refunds
--     have ever happened on this row).
--   • refund_state = 'none' when net_paid >= cart_total. Re-
--     payments have cancelled out the prior refunds; the cart is
--     currently settled. The ledger row reads as "Paid in full"
--     (or whatever payment_state says).
--   • refund_state = 'full' when net_paid <= 0 AND refunds > 0.
--     Everything that was once paid has been returned.
--   • refund_state = 'partial' when 0 < net_paid < cart_total AND
--     refunds > 0. Some money returned, some still on the books,
--     and re-payments haven't cleared the gap.
--
-- refunded_pence shifts meaning too: from "lifetime sum of every
-- succeeded refund" to "amount currently outstanding because of
-- refunds" = cart_total - net_paid (clamped at 0). This is what
-- the "Partially refunded £X" chip should show — the figure that
-- matches the in-cart audit line "£N paid · £M refunded back to
-- patient". Cumulative-refund-sum semantics led to chips like
-- "Partially refunded £90" on a fully-settled bill where the
-- gross side had grown from re-payments.
--
-- net_paid is computed inline using the same components as
-- lng_visit_paid_status: succeeded captures (status='succeeded',
-- not just succeeded_at — fully-refunded payments flip to
-- 'cancelled' and drop out of both sides cleanly) - their
-- succeeded refunds + paid deposit - deposit refunds.
--
-- Walk-ins use the same rule but without the deposit axis (walk-
-- ins never accept a deposit).
--
-- CREATE OR REPLACE refuses to renumber columns, so DROP + CREATE.

drop view if exists public.lng_ledger;

create view public.lng_ledger as
select
  a.id,
  'appointment'::text as kind,
  a.patient_id,
  a.location_id,
  a.start_at as event_at,
  a.end_at,
  case
    when v.status = any (array['complete'::text, 'ended_early'::text, 'unsuitable'::text]) then v.status
    else a.status
  end as status,
  a.source,
  a.event_type_label as service_label,
  a.service_type,
  a.appointment_ref,
  a.cancel_reason,
  a.notes,
  case
    when c.status = 'paid'::text then 'paid'::text
    when c.status = 'voided'::text then 'refunded'::text
    when coalesce(a.paid_in_full_at_booking, false) and coalesce(a.deposit_pence, 0) > 0 then 'paid'::text
    when a.deposit_status = 'paid'::text and coalesce(a.deposit_pence, 0) > 0 then 'deposit_paid'::text
    else 'unpaid'::text
  end as payment_state,
  v.fulfilment_method,
  a.created_via,
  a.product_key,
  a.repair_variant,
  a.arch::text as arch,
  a.brand_id,
  coalesce(a.paid_in_full_at_booking, false) as paid_in_full_at_booking,
  -- refunded_pence now reflects "still outstanding from refunds" =
  -- max(0, cart_total - net_paid). When no refunds have happened
  -- or the cart is settled (net >= total), this is 0.
  case
    when (
      coalesce((
        select sum(r.amount_pence) from public.lng_payment_refunds r
        join public.lng_payments p on p.id = r.payment_id
        where p.cart_id = c.id and r.status = 'succeeded'
      ), 0)
      + coalesce((
        select sum(r.amount_pence) from public.lng_payment_refunds r
        where r.deposit_appointment_id = a.id and r.status = 'succeeded'
      ), 0)
    ) = 0 then 0
    else greatest(
      0,
      coalesce(c.total_pence, 0)
      - (
        -- net_paid = succeeded captures - their refunds + paid deposit - deposit refunds
        coalesce((
          select sum(p.amount_pence) from public.lng_payments p
          where p.cart_id = c.id and p.status = 'succeeded'
        ), 0)
        - coalesce((
          select sum(r.amount_pence) from public.lng_payment_refunds r
          join public.lng_payments p on p.id = r.payment_id
          where p.cart_id = c.id and r.status = 'succeeded' and p.status = 'succeeded'
        ), 0)
        + greatest(
          0,
          case when a.deposit_status = 'paid' then coalesce(a.deposit_pence, 0) else 0 end
          - coalesce((
            select sum(r.amount_pence) from public.lng_payment_refunds r
            where r.deposit_appointment_id = a.id and r.status = 'succeeded'
          ), 0)
        )
      )
    )
  end::int as refunded_pence,
  -- refund_state classifier — mirrors the VisitDetail hero pill.
  case
    -- No refunds ever -> nothing to flag.
    when (
      coalesce((
        select sum(r.amount_pence) from public.lng_payment_refunds r
        join public.lng_payments p on p.id = r.payment_id
        where p.cart_id = c.id and r.status = 'succeeded'
      ), 0)
      + coalesce((
        select sum(r.amount_pence) from public.lng_payment_refunds r
        where r.deposit_appointment_id = a.id and r.status = 'succeeded'
      ), 0)
    ) = 0 then 'none'::text
    -- Net settled (re-payments cancelled out prior refunds) -> none.
    when (
      coalesce((
        select sum(p.amount_pence) from public.lng_payments p
        where p.cart_id = c.id and p.status = 'succeeded'
      ), 0)
      - coalesce((
        select sum(r.amount_pence) from public.lng_payment_refunds r
        join public.lng_payments p on p.id = r.payment_id
        where p.cart_id = c.id and r.status = 'succeeded' and p.status = 'succeeded'
      ), 0)
      + greatest(
        0,
        case when a.deposit_status = 'paid' then coalesce(a.deposit_pence, 0) else 0 end
        - coalesce((
          select sum(r.amount_pence) from public.lng_payment_refunds r
          where r.deposit_appointment_id = a.id and r.status = 'succeeded'
        ), 0)
      )
    ) >= coalesce(c.total_pence, 0) then 'none'::text
    -- Net at or below zero -> fully refunded.
    when (
      coalesce((
        select sum(p.amount_pence) from public.lng_payments p
        where p.cart_id = c.id and p.status = 'succeeded'
      ), 0)
      - coalesce((
        select sum(r.amount_pence) from public.lng_payment_refunds r
        join public.lng_payments p on p.id = r.payment_id
        where p.cart_id = c.id and r.status = 'succeeded' and p.status = 'succeeded'
      ), 0)
      + greatest(
        0,
        case when a.deposit_status = 'paid' then coalesce(a.deposit_pence, 0) else 0 end
        - coalesce((
          select sum(r.amount_pence) from public.lng_payment_refunds r
          where r.deposit_appointment_id = a.id and r.status = 'succeeded'
        ), 0)
      )
    ) <= 0 then 'full'::text
    -- Otherwise some refund, some money still on the books.
    else 'partial'::text
  end as refund_state
from lng_appointments a
  left join lng_visits v on v.appointment_id = a.id
  left join lng_carts c on c.visit_id = v.id

union all

select
  w.id,
  'walk_in'::text as kind,
  w.patient_id,
  w.location_id,
  w.created_at as event_at,
  w.created_at as end_at,
  coalesce(v.status, 'arrived'::text) as status,
  'walk_in'::text as source,
  w.service_type as service_label,
  w.service_type,
  w.appointment_ref,
  null::text as cancel_reason,
  v.notes,
  case
    when c.status = 'paid'::text then 'paid'::text
    when c.status = 'voided'::text then 'refunded'::text
    else 'unpaid'::text
  end as payment_state,
  v.fulfilment_method,
  'walk_in'::text as created_via,
  null::text as product_key,
  null::text as repair_variant,
  w.arch::text as arch,
  null::text as brand_id,
  false as paid_in_full_at_booking,
  -- Walk-ins have no deposit axis; net is just succeeded captures
  -- less their succeeded refunds.
  case
    when coalesce((
      select sum(r.amount_pence) from public.lng_payment_refunds r
      join public.lng_payments p on p.id = r.payment_id
      where p.cart_id = c.id and r.status = 'succeeded'
    ), 0) = 0 then 0
    else greatest(
      0,
      coalesce(c.total_pence, 0) - (
        coalesce((
          select sum(p.amount_pence) from public.lng_payments p
          where p.cart_id = c.id and p.status = 'succeeded'
        ), 0)
        - coalesce((
          select sum(r.amount_pence) from public.lng_payment_refunds r
          join public.lng_payments p on p.id = r.payment_id
          where p.cart_id = c.id and r.status = 'succeeded' and p.status = 'succeeded'
        ), 0)
      )
    )
  end::int as refunded_pence,
  case
    when coalesce((
      select sum(r.amount_pence) from public.lng_payment_refunds r
      join public.lng_payments p on p.id = r.payment_id
      where p.cart_id = c.id and r.status = 'succeeded'
    ), 0) = 0 then 'none'::text
    when (
      coalesce((
        select sum(p.amount_pence) from public.lng_payments p
        where p.cart_id = c.id and p.status = 'succeeded'
      ), 0)
      - coalesce((
        select sum(r.amount_pence) from public.lng_payment_refunds r
        join public.lng_payments p on p.id = r.payment_id
        where p.cart_id = c.id and r.status = 'succeeded' and p.status = 'succeeded'
      ), 0)
    ) >= coalesce(c.total_pence, 0) then 'none'::text
    when (
      coalesce((
        select sum(p.amount_pence) from public.lng_payments p
        where p.cart_id = c.id and p.status = 'succeeded'
      ), 0)
      - coalesce((
        select sum(r.amount_pence) from public.lng_payment_refunds r
        join public.lng_payments p on p.id = r.payment_id
        where p.cart_id = c.id and r.status = 'succeeded' and p.status = 'succeeded'
      ), 0)
    ) <= 0 then 'full'::text
    else 'partial'::text
  end as refund_state
from lng_walk_ins w
  left join lng_visits v on v.walk_in_id = w.id
  left join lng_carts c on c.visit_id = v.id;

comment on view public.lng_ledger is
  'Unioned appointments + walk-ins for the Ledger feed. payment_state stays exclusive. refund_state classifies the row by CURRENT NET state: ''none'' when no refunds or when net_paid >= cart_total (re-payments cancelled out prior refunds); ''full'' when net_paid <= 0; ''partial'' when 0 < net_paid < cart_total. refunded_pence is "still outstanding from refunds" (cart_total - net_paid), matching the in-cart audit so the chip and the audit line read as one consistent story.';

NOTIFY pgrst, 'reload schema';
