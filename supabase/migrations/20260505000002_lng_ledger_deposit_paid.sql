-- 20260505000002_lng_ledger_deposit_paid.sql
--
-- The Ledger surfaced 'paid' for any row whose deposit had cleared,
-- which read on the page as "fully paid" — wrong. A booking deposit
-- (£25 captured at booking time) is not the same as a fully settled
-- visit cart (the patient has paid every line item). Conflating them
-- mis-states the financial position to the operator.
--
-- Split the column into four values:
--
--   • 'paid'          — the cart for this row's visit is paid in full.
--   • 'deposit_paid'  — money has been received against this booking
--                       (lng_appointments.deposit_status = 'paid' with
--                       a non-zero deposit_pence) but the visit's cart
--                       is not yet paid (or there is no visit yet).
--   • 'refunded'      — the cart was voided (post-payment reversal).
--   • 'unpaid'        — no money received yet.
--
-- Walk-ins have no deposit concept, so they only ever land in
-- 'paid' / 'refunded' / 'unpaid'.
--
-- The view stays SECURITY INVOKER. Migration is a re-create of the
-- view with the new derivation; the column type stays text. Rollback
-- restores the previous derivation (without 'deposit_paid').

drop view if exists public.lng_ledger;

create view public.lng_ledger as
select
  a.id                                   as id,
  'appointment'::text                    as kind,
  a.patient_id                           as patient_id,
  a.location_id                          as location_id,
  a.start_at                             as event_at,
  a.end_at                               as end_at,
  a.status                               as status,
  a.source                               as source,
  a.event_type_label                     as service_label,
  a.appointment_ref                      as appointment_ref,
  a.cancel_reason                        as cancel_reason,
  a.notes                                as notes,
  case
    -- Cart settled in full → paid.
    when c.status = 'paid' then 'paid'
    -- Cart voided → refunded.
    when c.status = 'voided' then 'refunded'
    -- Booking deposit received: covers both
    --   (a) cart open / in-progress and the deposit cleared, AND
    --   (b) no visit yet but the deposit cleared at booking time.
    -- Either way the operator should see "money in but not full bill".
    when a.deposit_status = 'paid' and coalesce(a.deposit_pence, 0) > 0 then 'deposit_paid'
    else 'unpaid'
  end                                    as payment_state
from public.lng_appointments a
left join public.lng_visits v on v.appointment_id = a.id
left join public.lng_carts c on c.visit_id = v.id

union all

select
  w.id                                   as id,
  'walk_in'::text                        as kind,
  w.patient_id                           as patient_id,
  w.location_id                          as location_id,
  w.created_at                           as event_at,
  w.created_at                           as end_at,
  coalesce(v.status, 'arrived')          as status,
  'walk_in'::text                        as source,
  w.service_type                         as service_label,
  w.appointment_ref                      as appointment_ref,
  null::text                             as cancel_reason,
  v.notes                                as notes,
  case
    when c.status = 'paid' then 'paid'
    when c.status = 'voided' then 'refunded'
    else 'unpaid'
  end                                    as payment_state
from public.lng_walk_ins w
left join public.lng_visits v on v.walk_in_id = w.id
left join public.lng_carts c on c.visit_id = v.id;

comment on view public.lng_ledger is
  'Normalised union of lng_appointments + lng_walk_ins. payment_state distinguishes paid (cart settled), deposit_paid (booking deposit received but cart not in full), refunded (cart voided), and unpaid. SECURITY INVOKER.';

-- ── Rollback ─────────────────────────────────────────────────────
-- DROP VIEW IF EXISTS public.lng_ledger;
-- ... then re-apply 20260505000001_lng_ledger_payment_state.sql.
