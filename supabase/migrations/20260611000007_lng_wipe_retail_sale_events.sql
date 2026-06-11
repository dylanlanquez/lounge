-- 20260611000007_lng_wipe_retail_sale_events.sql
--
-- Retail Quick Sales (lng_walk_ins.service_type='retail') are already
-- wiped by lng_wipe_test_patient_appointments for the test emails: the
-- function discovers every walk-in by patient_id (the orphan-walk-in
-- branch), then deletes the visit, cart, payment and receipt. The one
-- thing it left behind was the timeline event: a retail sale fires a
-- 'receipt_sent' patient_event, but the wipe only cleared 'visit_closed'
-- events, so the "Receipt sent" row survived the wipe.
--
-- Fix: broaden the visit-keyed patient_events delete from
-- event_type='visit_closed' to EVERY event that references a wiped
-- visit (payload->>'visit_id'). This catches 'receipt_sent' and any
-- other visit-axis event, and stays patient-scoped — only visits
-- belonging to the matched emails are touched, so real customers' sales
-- (and the anonymous counter sales) are never affected.
--
-- Body otherwise unchanged from 20260520000003. Still SECURITY DEFINER +
-- is_admin() gate. Still idempotent.

create or replace function public.lng_wipe_test_patient_appointments(p_emails text[])
returns table(patients integer, appointments integer)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_patient_ids  uuid[];
  v_appt_ids     uuid[];
  v_walk_in_ids  uuid[];
  v_visit_ids    uuid[];
  v_cart_ids     uuid[];
  v_payment_ids  uuid[];
  v_refund_ids   uuid[];
  v_patients     int;
  v_appts        int;
  v_orphan_walk_ins int;
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

  -- Walk-ins reachable through TWO paths:
  --   (a) lng_appointments.walk_in_id — these belong to the
  --       appointment rows we're wiping.
  --   (b) lng_walk_ins.patient_id — orphan walk-ins (incl. retail Quick
  --       Sales) where the patient never produced a downstream
  --       lng_appointments row at all.
  select array_agg(distinct id) into v_walk_in_ids
  from (
    select walk_in_id as id
      from public.lng_appointments
     where id = any (coalesce(v_appt_ids, array[]::uuid[]))
       and walk_in_id is not null
    union
    select id
      from public.lng_walk_ins
     where patient_id = any (v_patient_ids)
  ) src
  where id is not null;

  -- "Orphan" walk-ins are the ones reached only via patient_id —
  -- not already counted by an appointment row pointing at them.
  select count(*) into v_orphan_walk_ins
  from public.lng_walk_ins w
  where w.patient_id = any (v_patient_ids)
    and not exists (
      select 1 from public.lng_appointments a
       where a.walk_in_id = w.id
         and a.patient_id = any (v_patient_ids)
    );

  if v_appts = 0 and v_orphan_walk_ins = 0 then
    patients := v_patients;
    appointments := 0;
    return next;
    return;
  end if;

  -- Visits via BOTH FK paths: appointment_id and walk_in_id.
  select array_agg(distinct id) into v_visit_ids
  from (
    select id from public.lng_visits where appointment_id = any (coalesce(v_appt_ids, array[]::uuid[]))
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
     where deposit_appointment_id = any (coalesce(v_appt_ids, array[]::uuid[]))
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
  -- lng_terminal_payments + lng_moto_payments are ON DELETE CASCADE, so
  -- they drop with the payment; lng_receipts is RESTRICT and must go
  -- first.
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
  -- Broadened from visit_closed-only to EVERY event that references a
  -- wiped visit, so retail Quick Sale receipts ('receipt_sent') and any
  -- other visit-axis event don't survive the wipe. Still patient-scoped:
  -- only visits belonging to the matched emails are in v_visit_ids.
  -- Compare as text (the payload value against the known-valid visit
  -- ids cast to text) rather than casting the payload to uuid: now that
  -- we match EVERY event with a visit_id key, a stray non-uuid payload
  -- string would otherwise abort the whole wipe on the cast.
  if v_visit_ids is not null then
    delete from public.patient_events
     where payload ? 'visit_id'
       and payload->>'visit_id' = any (select v::text from unnest(v_visit_ids) v);
  end if;
  if v_appt_ids is not null then
    delete from public.patient_events
     where payload ? 'appointment_id'
       and payload->>'appointment_id' = any (select a::text from unnest(v_appt_ids) a);
  end if;

  -- ── Visits (RESTRICT FKs on walk_in_id + appointment_id) ────────
  if v_visit_ids is not null then
    delete from public.lng_visits where id = any (v_visit_ids);
  end if;

  -- ── Clear reschedule pointers between rows inside the wipe set ──
  if v_appt_ids is not null then
    update public.lng_appointments
       set reschedule_to_id = null
     where reschedule_to_id = any (v_appt_ids);
  end if;

  -- ── Finally, the appointment rows themselves ────────────────────
  if v_appt_ids is not null then
    delete from public.lng_appointments where id = any (v_appt_ids);
  end if;

  -- ── Walk-in rows (appointment-linked AND orphan, incl. retail) ──
  if v_walk_in_ids is not null then
    delete from public.lng_walk_ins where id = any (v_walk_in_ids);
  end if;

  patients     := v_patients;
  appointments := v_appts + v_orphan_walk_ins;
  return next;
end;
$$;

comment on function public.lng_wipe_test_patient_appointments(text[]) is
  'Pre-launch cleanup. SECURITY DEFINER + is_admin() gate. Given a list of patient emails, wipes every appointment + walk-in (including orphan walk-ins keyed only on patient_id, e.g. retail Quick Sales) + downstream artefact (visits, carts, payments, payment refunds, receipts, klarna sessions, unsuitability records, cash count lines, email messages, and ALL patient_events referencing those visits — incl. retail receipt_sent — plus appointment-keyed events) belonging to those patients. Patient profile rows stay. Returns (patients matched, appointments + orphan walk-ins deleted). Idempotent.';
