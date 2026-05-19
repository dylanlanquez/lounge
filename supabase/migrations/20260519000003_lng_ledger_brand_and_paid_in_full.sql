-- 20260519000003_lng_ledger_brand_and_paid_in_full.sql
--
-- Two ledger fixes the receptionists flagged:
--
--   1. Rows where the patient paid the FULL price at booking (e.g.
--      a £149 same-day whitening kit through venneir.com) were
--      rendering with the "Deposit paid" pill because the view's
--      payment_state classifier only knew about deposit_status +
--      cart status, never about lng_appointments.paid_in_full_at_
--      booking. Flip payment_state to 'paid' when the row's
--      paid_in_full_at_booking is true so the Ledger badge reads
--      "Paid in full" — matching the AppointmentDetail hero
--      pill on the same row.
--
--   2. Native widget bookings were labelled "Native" on the Ledger,
--      which reads as developer jargon. The AppointmentDetail hero
--      labels them by storefront (venneir.com / denture-services.
--      co.uk) using lng_appointments.brand_id. Project brand_id
--      onto the view so the client can do the same mapping in the
--      Ledger row, with "Website" as the fallback for native rows
--      with no brand_id set.
--
-- CREATE OR REPLACE refuses to renumber columns, so DROP + CREATE.
-- Walk-in side carries placeholder values for the new columns
-- (paid_in_full_at_booking=false, brand_id=null) since walk-ins
-- have neither concept.

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
    -- paid_in_full_at_booking jumps the row to 'paid' regardless
    -- of cart state: by the time the patient walks in there's no
    -- balance to collect, so showing "Deposit paid" understates
    -- the truth and prompts staff to chase a balance that doesn't
    -- exist.
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
  coalesce(a.paid_in_full_at_booking, false) as paid_in_full_at_booking
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
  false as paid_in_full_at_booking
from lng_walk_ins w
  left join lng_visits v on v.walk_in_id = w.id
  left join lng_carts c on c.visit_id = v.id;
