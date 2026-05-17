-- 20260517000003_lng_wipe_test_patient_appointments_definer.sql
--
-- Hot-fix for the wipe RPC. The first cut (20260517000002) ran as
-- SECURITY INVOKER, which means each DELETE inside the function is
-- evaluated against the caller's RLS policies. Two tables in the
-- cascade chain are intentionally append-only and don't grant DELETE
-- to anyone except service-role:
--   • lng_receipts          (INSERT + SELECT only)
--   • lng_terminal_payments (SELECT only)
-- The receipts delete therefore matched 0 rows from Dylan's admin
-- session, which then tripped lng_receipts_payment_id_fkey when the
-- function tried to remove the parent lng_payments row.
--
-- Fix: re-create the function as SECURITY DEFINER so it bypasses
-- RLS for the bookkeeping deletes. Gate execution at the top with
-- public.is_admin() so only admin callers (the same audience the
-- original RPC was already restricted to via the Admin → Testing
-- UI) can trigger it. Non-admin callers see a clear permission
-- error rather than a silent no-op.
--
-- Body otherwise identical to the original definition. The function
-- stays idempotent — a re-run with the same emails after a
-- successful wipe deletes zero extra rows.

create or replace function public.lng_wipe_test_patient_appointments(p_emails text[])
returns table(patients integer, appointments integer)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_patient_ids uuid[];
  v_appt_ids    uuid[];
  v_visit_ids   uuid[];
  v_cart_ids    uuid[];
  v_payment_ids uuid[];
  v_patients    int;
  v_appts       int;
begin
  -- Admin-only gate. is_admin() consults the JWT claims that the
  -- Supabase gateway populates, so this is the same check every
  -- admin-scoped RLS policy already uses elsewhere in the schema.
  if not public.is_admin() then
    raise exception 'lng_wipe_test_patient_appointments: admin role required';
  end if;

  -- Resolve patient ids, case-insensitive on email so
  -- "Dylan@Venneir.com" and "dylan@venneir.com" both hit.
  select array_agg(id) into v_patient_ids
  from public.patients
  where exists (
    select 1 from unnest(p_emails) e
    where lower(e) = lower(public.patients.email)
  );

  if v_patient_ids is null or array_length(v_patient_ids, 1) = 0 then
    patients := 0;
    appointments := 0;
    return next;
    return;
  end if;

  v_patients := array_length(v_patient_ids, 1);

  select array_agg(id) into v_appt_ids
  from public.lng_appointments
  where patient_id = any (v_patient_ids);

  v_appts := coalesce(array_length(v_appt_ids, 1), 0);

  if v_appts = 0 then
    patients := v_patients;
    appointments := 0;
    return next;
    return;
  end if;

  -- Resolve visit / cart / payment id sets ahead of the deletes so
  -- payment children come out before payments before carts before
  -- visits, respecting every existing FK direction.
  select array_agg(id) into v_visit_ids
  from public.lng_visits
  where appointment_id = any (v_appt_ids);

  if v_visit_ids is not null then
    select array_agg(id) into v_cart_ids
    from public.lng_carts
    where visit_id = any (v_visit_ids);
  end if;

  if v_cart_ids is not null then
    select array_agg(id) into v_payment_ids
    from public.lng_payments
    where cart_id = any (v_cart_ids);
  end if;

  -- ── Payment children ─────────────────────────────────────────────
  if v_payment_ids is not null then
    delete from public.lng_terminal_payments where payment_id = any (v_payment_ids);
    delete from public.lng_receipts          where payment_id = any (v_payment_ids);
    delete from public.lng_payments          where id         = any (v_payment_ids);
  end if;

  -- ── Cart contents ───────────────────────────────────────────────
  if v_cart_ids is not null then
    delete from public.lng_cart_items where cart_id = any (v_cart_ids);
    delete from public.lng_carts      where id      = any (v_cart_ids);
  end if;

  -- ── Visits (FK ON DELETE RESTRICT — must be explicit) ───────────
  if v_visit_ids is not null then
    delete from public.lng_visits where id = any (v_visit_ids);
  end if;

  -- ── Clear reschedule pointers between rows inside the wipe set ──
  update public.lng_appointments
     set reschedule_to_id = null
   where reschedule_to_id = any (v_appt_ids);

  -- ── Patient timeline events tied to these appointments ──────────
  delete from public.patient_events
   where payload ? 'appointment_id'
     and (payload->>'appointment_id')::uuid = any (v_appt_ids);

  if v_visit_ids is not null then
    delete from public.patient_events
     where event_type = 'visit_closed'
       and payload ? 'visit_id'
       and (payload->>'visit_id')::uuid = any (v_visit_ids);
  end if;

  -- ── Finally, the appointment rows themselves ────────────────────
  delete from public.lng_appointments where id = any (v_appt_ids);

  patients     := v_patients;
  appointments := v_appts;
  return next;
end;
$$;

comment on function public.lng_wipe_test_patient_appointments(text[]) is
  'Pre-launch cleanup. SECURITY DEFINER (with is_admin() gate) so it can DELETE through tables whose RLS only grants INSERT/SELECT (lng_receipts, lng_terminal_payments). Given a list of patient emails, wipes every appointment + downstream artefact (visits, carts, payments, receipts, phases, upgrades, repair items, intake photos, meet hosts, email messages, appointment-keyed patient_events) belonging to those patients. Patient profile rows stay. Returns (patients matched, appointments deleted). Idempotent.';

-- ── Rollback ───────────────────────────────────────────────────────
-- drop function if exists public.lng_wipe_test_patient_appointments(text[]);
