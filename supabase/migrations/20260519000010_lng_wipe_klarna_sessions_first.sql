-- 20260519000010_lng_wipe_klarna_sessions_first.sql
--
-- Bug fix on lng_wipe_test_patient_appointments. The previous
-- definition (20260519000001) didn't know about lng_klarna_sessions
-- — that table was added later, in 20260519000007_lng_klarna_in_store,
-- with THREE ON DELETE RESTRICT foreign keys pointing back into the
-- wipe set:
--
--   lng_klarna_sessions.payment_id -> lng_payments(id)
--   lng_klarna_sessions.cart_id    -> lng_carts(id)
--   lng_klarna_sessions.visit_id   -> lng_visits(id)
--
-- A test patient who used Klarna at the till during pre-launch
-- crashes the wipe at the lng_payments delete with:
--   "violates foreign key constraint
--    lng_klarna_sessions_payment_id_fkey".
--
-- Fix: resolve every klarna session row tied to the wipe set (via
-- any of the three FKs) BEFORE deleting payments / carts / visits.
-- Mirrors the existing pattern for lng_payment_refunds.
--
-- Body otherwise unchanged from 20260519000001. Still SECURITY
-- DEFINER + is_admin() gate. Still idempotent.

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

  select array_agg(id) into v_refund_ids
  from (
    select id from public.lng_payment_refunds
     where deposit_appointment_id = any (v_appt_ids)
    union
    select id from public.lng_payment_refunds
     where v_payment_ids is not null and payment_id = any (v_payment_ids)
  ) r;

  -- ── Klarna sessions ─────────────────────────────────────────────
  -- All three FKs (payment_id, cart_id, visit_id) are ON DELETE
  -- RESTRICT, so a klarna session blocks the parent delete from any
  -- of those three tables. UNION any session reachable via any FK
  -- so a session whose parent payment was already nulled out (edge
  -- case during prior partial wipes) still gets cleared.
  delete from public.lng_klarna_sessions
   where (v_payment_ids is not null and payment_id = any (v_payment_ids))
      or (v_cart_ids    is not null and cart_id    = any (v_cart_ids))
      or (v_visit_ids   is not null and visit_id   = any (v_visit_ids));

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
  'Pre-launch cleanup. SECURITY DEFINER + is_admin() gate. Given a list of patient emails, wipes every appointment + downstream artefact (visits, carts, payments, payment refunds, receipts, klarna sessions, phases, upgrades, repair items, intake photos, meet hosts, email messages, appointment-keyed patient_events) belonging to those patients. Patient profile rows stay. Returns (patients matched, appointments deleted). Idempotent.';
