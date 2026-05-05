-- 20260505000001_lng_ledger_payment_state.sql
--
-- The Ledger surface needs to filter by payment status (paid /
-- unpaid / refunded) and render a "Paid" badge on each row. Today
-- those facts live across two tables (lng_appointments.deposit_status
-- + lng_carts.status) — neither of which lng_ledger surfaces — so the
-- frontend can't filter or display them without extra round-trips.
--
-- Re-create the view with one new column: payment_state. Same row
-- shape as before plus this string, derived as:
--
--   • Cart exists for this row's visit:
--       cart.status = 'paid'   → 'paid'
--       cart.status = 'voided' → 'refunded'
--       else                    → 'unpaid'   (cart open, no payments)
--   • No cart yet:
--       appointment.deposit_status = 'paid' AND deposit_pence > 0
--                              → 'paid'      (deposit covers the booking)
--       else                    → 'unpaid'
--
-- Walk-ins go through the same logic — they always have a visit, but
-- the cart only materialises once the operator builds one. Until then,
-- payment_state is 'unpaid'.
--
-- The view stays SECURITY INVOKER so RLS on lng_appointments,
-- lng_visits, lng_carts and lng_walk_ins continues to apply per
-- caller's JWT.
--
-- Rollback at the bottom restores the prior view shape.

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
    when c.status = 'paid' then 'paid'
    when c.status = 'voided' then 'refunded'
    when c.id is null
         and a.deposit_status = 'paid'
         and coalesce(a.deposit_pence, 0) > 0 then 'paid'
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
  'Normalised union of lng_appointments + lng_walk_ins, with a derived payment_state (paid / unpaid / refunded) joined off lng_carts (and lng_appointments.deposit_status as a pre-visit fallback). Powers the Ledger route. SECURITY INVOKER so RLS on the underlying tables still applies.';

-- ── Rollback ─────────────────────────────────────────────────────
-- DROP VIEW IF EXISTS public.lng_ledger;
-- ... then re-apply 20260502000004_lng_ledger_view.sql.
