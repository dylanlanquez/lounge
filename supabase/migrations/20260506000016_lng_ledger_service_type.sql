-- 20260506000016_lng_ledger_service_type.sql
--
-- Adds service_type to lng_ledger so the Ledger UI can filter by
-- booking category (Denture repair, Same-day appliance, etc.) instead
-- of by source (Calendly / native / walk-in), which is a technical
-- implementation detail that receptionists don't think in.
--
-- service_type comes from lng_appointments.service_type for appointment
-- rows and lng_walk_ins.service_type for walk-in rows. Old Calendly
-- rows that pre-date the column will surface NULL — they are still
-- visible when no filter is applied, just unclassifiable by type.

drop view if exists public.lng_ledger;

create view public.lng_ledger as
select
  a.id                                   as id,
  'appointment'::text                    as kind,
  a.patient_id                           as patient_id,
  a.location_id                          as location_id,
  a.start_at                             as event_at,
  a.end_at                               as end_at,
  case
    when v.status in ('complete', 'ended_early', 'unsuitable') then v.status
    else a.status
  end                                    as status,
  a.source                               as source,
  a.event_type_label                     as service_label,
  a.service_type                         as service_type,
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
  w.service_type                         as service_type,
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
  'Normalised union of lng_appointments + lng_walk_ins. service_type is the canonical booking category for filtering. status defers to the linked visit for terminal states. payment_state: paid / deposit_paid / refunded / unpaid. SECURITY INVOKER.';
