-- 20260519000001_lng_wipe_payment_refunds_first.sql
--
-- Bug fix on lng_wipe_test_patient_appointments. The previous
-- definition (20260517000003) deleted lng_terminal_payments,
-- lng_receipts, lng_payments and lng_appointments in order, but did
-- NOT touch lng_payment_refunds. That table has TWO ON DELETE
-- RESTRICT foreign keys pointing back into the wipe set:
--
--   lng_payment_refunds.payment_id              -> lng_payments(id)
--   lng_payment_refunds.deposit_appointment_id  -> lng_appointments(id)
--
-- (A third, lng_payment_refunds.appointment_id, is ON DELETE SET NULL
-- so it doesn't block the wipe — only the two RESTRICT ones do.)
--
-- Any test patient who had a refund issued during pre-launch testing
-- would crash the wipe at the lng_appointments delete with:
--   "violates foreign key constraint
--    lng_payment_refunds_deposit_appointment_id_fkey".
--
-- Fix: resolve every refund id tied to the wipe set BEFORE deleting
-- lng_payments / lng_appointments, then delete those refund rows
-- alongside the other payment children. Identical to the existing
-- pattern for lng_terminal_payments / lng_receipts.
--
-- Body otherwise unchanged. Still SECURITY DEFINER + is_admin() gate.
-- Still idempotent.

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
  v_refund_ids  uuid[];
  v_patients    int;
  v_appts       int;
begin
  if not public.is_admin() then
    raise exception 'lng_wipe_test_patient_appointments: admin role required';
  end if;

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

  -- Resolve visit / cart / payment id sets up-front so we can wipe
  -- children before parents in one pass.
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

  -- Resolve every refund row that points back into the wipe set,
  -- via either FK direction. UNION dedupes — a refund row could
  -- carry BOTH payment_id and deposit_appointment_id set against
  -- the same patient.
  select array_agg(id) into v_refund_ids
  from (
    select id from public.lng_payment_refunds
     where deposit_appointment_id = any (v_appt_ids)
    union
    select id from public.lng_payment_refunds
     where v_payment_ids is not null and payment_id = any (v_payment_ids)
  ) r;

  -- ── Refund children (no FKs into them; safe to delete first) ────
  if v_refund_ids is not null then
    delete from public.lng_payment_refunds where id = any (v_refund_ids);
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
  'Pre-launch cleanup. SECURITY DEFINER + is_admin() gate. Given a list of patient emails, wipes every appointment + downstream artefact (visits, carts, payments, payment refunds, receipts, phases, upgrades, repair items, intake photos, meet hosts, email messages, appointment-keyed patient_events) belonging to those patients. Patient profile rows stay. Returns (patients matched, appointments deleted). Idempotent.';
