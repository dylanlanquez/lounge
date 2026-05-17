-- 20260517000002_lng_wipe_test_patient_appointments.sql
--
-- Pre-launch helper. Given an array of patient email addresses
-- (Dylan's five test accounts at the time of writing), wipe every
-- appointment + downstream artefact belonging to those patients in a
-- single atomic call. The patient row itself stays — Dylan reuses
-- these inboxes for ongoing testing, so we keep the profile and only
-- clear the booking history.
--
-- Why an RPC: 77 test appointments at write time, each with its own
-- visit / cart / payment / receipt fan-out. Looping client-side at
-- ~10 round-trips per appointment is both slow and exposes a window
-- where a partial wipe could leave the schedule in a half-cleaned
-- state. One server-side transaction is cleaner.
--
-- What gets deleted (in FK-safe order):
--   • lng_terminal_payments  → ref lng_payments
--   • lng_receipts           → ref lng_payments
--   • lng_payments           → ref lng_carts
--   • lng_cart_items         → ref lng_carts
--   • lng_carts              → ref lng_visits
--   • lng_visits             → on delete RESTRICT, so manual
--   • patient_events keyed on payload.appointment_id (or visit_id
--     for visit_closed) for the targeted appointments
--   • lng_appointments rows  → cascades:
--       lng_appointment_phases       (CASCADE)
--       lng_appointment_upgrades     (CASCADE)
--       lng_appointment_repair_items (CASCADE)
--       lng_meet_hosts               (CASCADE)
--       lng_email_messages           (CASCADE)
--       lng_booking_intake_photos    (CASCADE)
--       patient_files.appointment_id (SET NULL — file stays, link goes)
--       lng_calendly_bookings.appointment_id (SET NULL)
--
-- Reschedule chains: any appointment in the targeted set that another
-- appointment in the SAME set was rescheduled to gets its incoming
-- pointer cleared first, so we don't trip the SET NULL re-cast race
-- and so external (non-test) reschedule pointers stay intact.
--
-- Returns counts of (patients matched, appointments wiped) so the
-- admin UI can confirm what happened.

create or replace function public.lng_wipe_test_patient_appointments(p_emails text[])
returns table(patients integer, appointments integer)
language plpgsql
security invoker
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
  -- Resolve patient ids, case-insensitive on email so "Dylan@Venneir.com"
  -- and "dylan@venneir.com" both hit.
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

  -- Resolve appointment ids.
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
  -- we can wipe payment children before payments before carts before
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
  -- Without this, lng_appointments_a.reschedule_to_id pointing at
  -- lng_appointments_b (both in the wipe set) would trip the ON
  -- DELETE SET NULL twice in undefined order. Clear explicitly.
  update public.lng_appointments
     set reschedule_to_id = null
   where reschedule_to_id = any (v_appt_ids);

  -- ── Patient timeline events tied to these appointments ──────────
  -- Two passes: events keyed on payload.appointment_id (booking,
  -- arrival, no-show, etc.) and visit_closed events keyed on
  -- payload.visit_id from the visits we just deleted.
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
  -- Cascade fires for phases, upgrades, repair items, meet hosts,
  -- email messages, intake photos. patient_files links go to null
  -- (the uploaded file is kept — they're objects in Storage).
  delete from public.lng_appointments where id = any (v_appt_ids);

  patients     := v_patients;
  appointments := v_appts;
  return next;
end;
$$;

comment on function public.lng_wipe_test_patient_appointments(text[]) is
  'Pre-launch cleanup. Given a list of patient emails, wipes every appointment + downstream artefact (visits, carts, payments, receipts, phases, upgrades, repair items, intake photos, meet hosts, email messages, appointment-keyed patient_events) belonging to those patients. Patient profile rows stay. Returns (patients matched, appointments deleted). Idempotent — a re-run with the same emails after a successful wipe deletes zero extra rows.';

-- ── Rollback ───────────────────────────────────────────────────────
-- drop function if exists public.lng_wipe_test_patient_appointments(text[]);
-- (Deleted rows are not recoverable without a restore from backup —
--  this function is intentionally destructive and intentionally
--  scoped to a hand-picked email list.)
