-- ─────────────────────────────────────────────────────────────────────────────
-- Lounge — patient appointments lookup for cross-project surfaces
--
-- Checkpoint's ScanView already calls Lounge RPCs (availability,
-- widget-create-appointment) for the same-day-upgrade booker. With
-- this RPC it can also list the patient's existing Lounge
-- appointments alongside the order context so a staff member sees,
-- in one place, every appointment tied to the patient on the order.
--
-- Anon-callable. The RPC is keyed on patient_id (UUID, 122-bit
-- random) which is not enumerable; the call surface is the same
-- privacy posture as `lng_widget_lookup_booking(p_token)` which
-- already exists. Returns the minimal patient-visible shape — no
-- internal notes, no payment provider IDs, no staff assignments,
-- no other patient's data.
--
-- Rollback: drop the function.
-- ─────────────────────────────────────────────────────────────────────────────

drop function if exists public.lng_widget_lookup_patient_appointments(uuid);

create or replace function public.lng_widget_lookup_patient_appointments(
  p_patient_id uuid
)
returns table (
  id                  uuid,
  appointment_ref     text,
  service_type        text,
  event_type_label    text,
  arch                text,
  product_key         text,
  repair_variant      text,
  start_at            timestamptz,
  end_at              timestamptz,
  status              text,
  source              text,
  join_url            text,
  location_id         uuid,
  location_name       text,
  shopify_order_name  text,
  manage_token        uuid
)
language sql
security definer
set search_path = public
as $$
  select
    a.id,
    a.appointment_ref,
    a.service_type,
    a.event_type_label,
    a.arch,
    a.product_key,
    a.repair_variant,
    a.start_at,
    a.end_at,
    a.status,
    a.source,
    a.join_url,
    a.location_id,
    coalesce(l.name, 'Venneir Lounge') as location_name,
    a.shopify_order_name,
    a.manage_token
    from public.lng_appointments a
    left join public.locations l on l.id = a.location_id
   where a.patient_id = p_patient_id
   order by a.start_at desc;
$$;

revoke all on function public.lng_widget_lookup_patient_appointments(uuid) from public;
grant execute on function public.lng_widget_lookup_patient_appointments(uuid) to anon, authenticated, service_role;

comment on function public.lng_widget_lookup_patient_appointments(uuid) is
  'Patient-side appointment list for cross-project surfaces (Checkpoint ScanView). Anon-callable, keyed on patient_id. Returns minimal patient-visible columns; no internal notes, no payment provider IDs, no staff assignments, no other patient''s row.';
