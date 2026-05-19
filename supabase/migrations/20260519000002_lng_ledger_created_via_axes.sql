-- 20260519000002_lng_ledger_created_via_axes.sql
--
-- Extend the lng_ledger view so client-side renderers can compose a
-- service label identical to the AppointmentDetail / VisitDetail
-- hero (formatCustomerServiceTitleLabel) and surface a Checkpoint
-- source pill on rows that originated through Checkpoint's
-- ScanView booking flow.
--
-- CREATE OR REPLACE VIEW refuses to renumber columns, so we DROP +
-- CREATE. Nothing else in the schema depends on lng_ledger as a
-- foreign key target — it's a read-only convenience view for the
-- Ledger page.
--
-- New columns appended at the END so any future CREATE OR REPLACE
-- can extend without re-dropping. Keeping the original column order
-- means client code that destructures the leading columns by name
-- is unaffected.
--
-- New axes (both union sides):
--   • created_via         — 'checkpoint' | 'walk_in' | null. Lets
--                            the Ledger render the correct source
--                            label + glyph (Checkpoint rows are
--                            stored as source='native' so the
--                            existing source column collapses them
--                            with the public widget).
--   • product_key         — for "Same-day Lower Day Guard" etc.
--   • repair_variant      — for denture repair title axis pin.
--   • arch                — for axis pinning in the title composer.

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
    when a.deposit_status = 'paid'::text and coalesce(a.deposit_pence, 0) > 0 then 'deposit_paid'::text
    else 'unpaid'::text
  end as payment_state,
  v.fulfilment_method,
  -- New axes (appended)
  a.created_via,
  a.product_key,
  a.repair_variant,
  a.arch::text as arch
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
  -- New axes (appended)
  'walk_in'::text as created_via,
  null::text as product_key,
  null::text as repair_variant,
  w.arch::text as arch
from lng_walk_ins w
  left join lng_visits v on v.walk_in_id = w.id
  left join lng_carts c on c.visit_id = v.id;
