-- 20260519000011_lng_ledger_refund_state.sql
--
-- Add refund visibility to the Ledger feed.
--
-- The previous view exposed `payment_state` with a 'refunded' value
-- that was only ever set when c.status='voided' (a state the current
-- end-visit / refund flows never produce). The new refund affordance
-- on VisitDetail lets staff refund a completed visit, but the
-- Ledger row carried no signal — receptionists had no way to filter
-- or see "this row had money returned".
--
-- Two new columns surface the refund axis without disturbing the
-- existing payment_state classifier:
--
--   • refunded_pence  (int)    Sum of every succeeded refund tied
--                              to this row's visit — cart-payment
--                              refunds + deposit refunds combined.
--                              Zero when no refund exists.
--
--   • refund_state    (text)   One of 'none' / 'partial' / 'full'.
--                              'full' when refunded_pence covers
--                              every captured penny (cart payments
--                              + paid deposit). 'partial' when at
--                              least one refund exists but money
--                              remains on the books. 'none' when
--                              refunded_pence = 0.
--
-- Why succeeded_at, not status='succeeded': terminal-refund flips a
-- fully-refunded lng_payments row to status='cancelled' (see header
-- in supabase/functions/terminal-refund/index.ts). Filtering by
-- status would drop the historical capture from the gross side
-- while the refund row keeps the refunded_pence side honest, and
-- refund_state would falsely read 'partial' on a fully-refunded
-- visit. succeeded_at is set when the payment captures and never
-- cleared, so it's the durable signal for "this payment was once
-- captured" — exactly what gross_captures wants.
--
-- payment_state stays exclusive (paid / deposit_paid / unpaid /
-- refunded) so existing consumers don't shift. The Ledger row
-- composes refund_state on top: when refund_state != 'none' the
-- pill displaces "Paid in full" with "Refunded" / "Partially
-- refunded £X" (Dylan's choice — one pill, refund takes
-- precedence).
--
-- Walk-ins carry the same columns. They never accept a deposit, so
-- their gross captures are just captured cart payments.
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
  (
    coalesce((
      select sum(r.amount_pence)
      from public.lng_payment_refunds r
      join public.lng_payments p on p.id = r.payment_id
      where p.cart_id = c.id
        and r.status = 'succeeded'
    ), 0)
    + coalesce((
      select sum(r.amount_pence)
      from public.lng_payment_refunds r
      where r.deposit_appointment_id = a.id
        and r.status = 'succeeded'
    ), 0)
  )::int as refunded_pence,
  case
    when (
      coalesce((
        select sum(r.amount_pence)
        from public.lng_payment_refunds r
        join public.lng_payments p on p.id = r.payment_id
        where p.cart_id = c.id
          and r.status = 'succeeded'
      ), 0)
      + coalesce((
        select sum(r.amount_pence)
        from public.lng_payment_refunds r
        where r.deposit_appointment_id = a.id
          and r.status = 'succeeded'
      ), 0)
    ) = 0 then 'none'::text
    when (
      coalesce((
        select sum(r.amount_pence)
        from public.lng_payment_refunds r
        join public.lng_payments p on p.id = r.payment_id
        where p.cart_id = c.id
          and r.status = 'succeeded'
      ), 0)
      + coalesce((
        select sum(r.amount_pence)
        from public.lng_payment_refunds r
        where r.deposit_appointment_id = a.id
          and r.status = 'succeeded'
      ), 0)
    ) >= (
      coalesce((
        select sum(p.amount_pence)
        from public.lng_payments p
        where p.cart_id = c.id and p.succeeded_at is not null
      ), 0)
      + case when a.deposit_status = 'paid' then coalesce(a.deposit_pence, 0) else 0 end
    ) then 'full'::text
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
  coalesce((
    select sum(r.amount_pence)
    from public.lng_payment_refunds r
    join public.lng_payments p on p.id = r.payment_id
    where p.cart_id = c.id
      and r.status = 'succeeded'
  ), 0)::int as refunded_pence,
  case
    when coalesce((
      select sum(r.amount_pence)
      from public.lng_payment_refunds r
      join public.lng_payments p on p.id = r.payment_id
      where p.cart_id = c.id
        and r.status = 'succeeded'
    ), 0) = 0 then 'none'::text
    when coalesce((
      select sum(r.amount_pence)
      from public.lng_payment_refunds r
      join public.lng_payments p on p.id = r.payment_id
      where p.cart_id = c.id
        and r.status = 'succeeded'
    ), 0) >= coalesce((
      select sum(p.amount_pence)
      from public.lng_payments p
      where p.cart_id = c.id and p.succeeded_at is not null
    ), 0) then 'full'::text
    else 'partial'::text
  end as refund_state
from lng_walk_ins w
  left join lng_visits v on v.walk_in_id = w.id
  left join lng_carts c on c.visit_id = v.id;

comment on view public.lng_ledger is
  'Unioned appointments + walk-ins for the Ledger feed. payment_state stays exclusive (paid/deposit_paid/unpaid/refunded-when-cart-voided). refunded_pence + refund_state add the refund-axis overlay so the Ledger row can show "Partially refunded £X" / "Refunded" pills and filters can target partial-vs-full refunds. Gross captures use succeeded_at to count historical captures even after terminal-refund flips a fully-refunded payment to status=cancelled.';

NOTIFY pgrst, 'reload schema';
