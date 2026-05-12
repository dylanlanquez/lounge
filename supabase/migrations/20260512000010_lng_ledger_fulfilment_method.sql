-- Expose lng_visits.fulfilment_method on the lng_ledger view so the
-- Ledger page can filter by "Handed to patient" vs "Shipped". The
-- column is already on lng_visits (set by completeVisit() in
-- src/lib/queries/visits.ts), it just isn't projected through the
-- view today.
--
-- Both halves of the UNION need the column. The appointment half
-- joins lng_visits via appointment_id; the walk-in half joins via
-- walk_in_id. Either join can be null (no visit yet) so the value
-- is null until completion.
--
-- The view stays unchanged in every other respect — same join shape,
-- same status / payment_state logic, same union order.

create or replace view public.lng_ledger as
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
      when a.deposit_status = 'paid'::text and coalesce(a.deposit_pence, 0) > 0 then 'deposit_paid'::text
      else 'unpaid'::text
    end as payment_state,
    -- Fulfilment method lands on lng_visits.fulfilment_method when
    -- staff complete the visit (in_person | shipping). Null for any
    -- ledger row that hasn't reached completion — booked appointments,
    -- no-shows, cancellations.
    v.fulfilment_method as fulfilment_method
  from public.lng_appointments a
    left join public.lng_visits v on v.appointment_id = a.id
    left join public.lng_carts c on c.visit_id = v.id
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
    v.fulfilment_method as fulfilment_method
  from public.lng_walk_ins w
    left join public.lng_visits v on v.walk_in_id = w.id
    left join public.lng_carts c on c.visit_id = v.id;

NOTIFY pgrst, 'reload schema';
