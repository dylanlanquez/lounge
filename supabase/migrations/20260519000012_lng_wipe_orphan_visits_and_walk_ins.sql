-- 20260519000012_lng_wipe_orphan_visits_and_walk_ins.sql
--
-- Two more gaps in lng_wipe_test_patient_appointments, found while
-- clearing real-customer LAP-00004 (a walk-in whose visit row had
-- appointment_id=null, only walk_in_id set):
--
--   1. lng_visits can reference lng_walk_ins via walk_in_id with a
--      null appointment_id. Previous RPC only found visits via
--      appointment_id, leaving those orphans referencing rows we
--      were about to delete. lng_visits.walk_in_id is RESTRICT, so
--      the walk-in delete then blocked.
--
--   2. lng_walk_ins itself wasn't being deleted. lng_appointments.
--      walk_in_id is CASCADE so appointments vanished, but the
--      lng_walk_ins row stayed behind as orphan ledger data.
--
-- Fix: discover every walk_in_id tied to the patient's appointments,
-- expand the visit set to include any visit referencing those
-- walk_in_ids (even when appointment_id is null), and delete the
-- walk_ins explicitly after the appointments.
--
-- Body otherwise unchanged from 20260519000011. Still SECURITY
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
  v_walk_in_ids uuid[];
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

  -- Walk-in rows reachable through these appointments. Used to
  -- expand the visit set so orphan visits (appointment_id=null,
  -- walk_in_id=...) are also caught, and to delete the walk_ins
  -- themselves after the appointments are gone.
  select array_agg(distinct walk_in_id) into v_walk_in_ids
  from public.lng_appointments
  where id = any (v_appt_ids) and walk_in_id is not null;

  -- Visits via BOTH FK paths: appointment_id and walk_in_id.
  select array_agg(distinct id) into v_visit_ids
  from (
    select id from public.lng_visits where appointment_id = any (v_appt_ids)
    union
    select id from public.lng_visits
     where v_walk_in_ids is not null and walk_in_id = any (v_walk_in_ids)
  ) src;

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

  -- ── Unsuitability records (RESTRICT FK on visit_id) ─────────────
  if v_visit_ids is not null then
    delete from public.lng_unsuitability_records
     where visit_id = any (v_visit_ids);
  end if;

  -- ── Klarna sessions (RESTRICT FKs on payment / cart / visit) ────
  delete from public.lng_klarna_sessions
   where (v_payment_ids is not null and payment_id = any (v_payment_ids))
      or (v_cart_ids    is not null and cart_id    = any (v_cart_ids))
      or (v_visit_ids   is not null and visit_id   = any (v_visit_ids));

  -- ── Refund children ─────────────────────────────────────────────
  if v_refund_ids is not null then
    delete from public.lng_payment_refunds where id = any (v_refund_ids);
  end if;

  -- ── Cash-count attribution lines (RESTRICT FK on payment_id) ────
  if v_payment_ids is not null then
    delete from public.lng_cash_count_lines
     where payment_id = any (v_payment_ids);
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

  -- ── Patient timeline events tied to these visits + appointments ─
  if v_visit_ids is not null then
    delete from public.patient_events
     where event_type = 'visit_closed'
       and payload ? 'visit_id'
       and (payload->>'visit_id')::uuid = any (v_visit_ids);
  end if;
  delete from public.patient_events
   where payload ? 'appointment_id'
     and (payload->>'appointment_id')::uuid = any (v_appt_ids);

  -- ── Visits (RESTRICT FKs on walk_in_id + appointment_id) ────────
  if v_visit_ids is not null then
    delete from public.lng_visits where id = any (v_visit_ids);
  end if;

  -- ── Clear reschedule pointers between rows inside the wipe set ──
  update public.lng_appointments
     set reschedule_to_id = null
   where reschedule_to_id = any (v_appt_ids);

  -- ── Finally, the appointment rows themselves ────────────────────
  delete from public.lng_appointments where id = any (v_appt_ids);

  -- ── Walk-in rows tied to those appointments ─────────────────────
  -- Done after appointments because lng_appointments.walk_in_id is
  -- ON DELETE CASCADE but lng_visits.walk_in_id is RESTRICT — the
  -- visit-delete above resolved that, so the walk-in can drop now.
  if v_walk_in_ids is not null then
    delete from public.lng_walk_ins where id = any (v_walk_in_ids);
  end if;

  patients     := v_patients;
  appointments := v_appts;
  return next;
end;
$$;

comment on function public.lng_wipe_test_patient_appointments(text[]) is
  'Pre-launch cleanup. SECURITY DEFINER + is_admin() gate. Given a list of patient emails, wipes every appointment + walk-in + downstream artefact (visits incl. orphan visits keyed on walk_in_id, carts, payments, payment refunds, receipts, klarna sessions, unsuitability records, cash count lines, phases, upgrades, repair items, intake photos, meet hosts, email messages, appointment-keyed patient_events) belonging to those patients. Patient profile rows stay. Returns (patients matched, appointments deleted). Idempotent.';
