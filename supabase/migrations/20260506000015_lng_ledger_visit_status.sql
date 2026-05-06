-- 20260506000015_lng_ledger_visit_status.sql
--
-- The "Complete" filter on the Ledger returned nothing for appointments
-- because the appointment arm of the view used a.status, which stays
-- 'arrived' forever — the completion is only recorded on lng_visits.status.
--
-- The walk-in arm already does COALESCE(v.status, 'arrived') correctly.
-- The appointment arm now does the same: when the linked visit has
-- reached a terminal state (complete / ended_early / unsuitable), the
-- view surfaces that instead of the stale appointment-row value.

drop view if exists public.lng_ledger;

create view public.lng_ledger as
select
  a.id                                   as id,
  'appointment'::text                    as kind,
  a.patient_id                           as patient_id,
  a.location_id                          as location_id,
  a.start_at                             as event_at,
  a.end_at                               as end_at,
  -- Prefer the visit's terminal status over the appointment row's status.
  -- lng_appointments.status stays 'arrived' after the desk marks the visit
  -- complete; only lng_visits.status transitions to complete/ended_early/
  -- unsuitable. For all other states (booked, cancelled, no_show,
  -- rescheduled) there is no visit, so a.status is authoritative.
  case
    when v.status in ('complete', 'ended_early', 'unsuitable') then v.status
    else a.status
  end                                    as status,
  a.source                               as source,
  a.event_type_label                     as service_label,
  a.appointment_ref                      as appointment_ref,
  a.cancel_reason                        as cancel_reason,
  a.notes                                as notes,
  case
    when c.status = 'paid' then 'paid'
    when c.status = 'voided' then 'refunded'
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
  'Normalised union of lng_appointments + lng_walk_ins. Appointment status defers to the linked visit status for terminal states (complete/ended_early/unsuitable). payment_state distinguishes paid, deposit_paid, refunded, unpaid. SECURITY INVOKER.';
