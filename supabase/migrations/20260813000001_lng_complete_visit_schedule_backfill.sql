-- 20260813000001_lng_complete_visit_schedule_backfill.sql
--
-- Repairs schedule rows left on 'arrived' by a visit that reached
-- 'complete'. Companion migration 20260813000002 does the same for
-- visits that ended as 'unsuitable' / 'ended_early'.
--
-- ── Why they were stuck ──────────────────────────────────────────
-- The schedule reads lng_appointments, and isAppointmentDimmed
-- refuses to dim an 'arrived' row at any age (it assumes the patient
-- may still be in the chair and the slot has over-run). Any booking
-- whose row never left 'arrived' therefore sat at full strength with
-- an "Arrived" pill indefinitely, however long ago the patient left.
--
-- Two distinct causes, both repaired here:
--
--   • Walk-ins (12 rows, oldest 22 May 2026). A walk-in owns a
--     calendar marker in lng_appointments carrying walk_in_id back to
--     lng_walk_ins. completeVisit only flipped lng_appointments when
--     the visit had an appointment_id, which a walk-in visit never
--     does — the exactly-one constraint on lng_visits forces
--     walk_in_id instead. So the marker was never touched. Fixed
--     going forward in src/lib/queries/visits.ts :: completeVisit.
--
--   • One booked appointment (Steven Green, 10 Jul 2026, an in-person
--     impression appointment). Here completeVisit DID take the
--     appointment_id branch — patient_events shows visit_arrived at
--     12:59:30 then visit_closed at 12:59:33, the auto-complete path
--     for visits whose lines need no fulfilment decision — but the
--     lng_appointments update did not land. Supabase returns RLS and
--     constraint failures in the response object rather than
--     rejecting, and that update's result was never checked, so the
--     failure was swallowed. completeVisit now routes both
--     appointment updates through logFailure so a repeat lands in
--     lng_system_failures instead of vanishing.
--
-- ── Scope ────────────────────────────────────────────────────────
-- Only rows still sitting on 'arrived' whose visit reached
-- 'complete'. A booking later cancelled or rescheduled by hand is not
-- on 'arrived' and so cannot be disturbed.
--
-- jb_ref is left alone. A walk-in's job box lives on
-- lng_walk_ins.jb_ref, never on the marker, and completeVisit
-- released it at the time.
--
-- Measured against Meridian on 13 Aug 2026: 13 rows (12 walk-in
-- markers, 1 booked appointment).
--
-- Idempotent: re-running matches nothing once the rows are flipped.
--
-- ── Apply order (per CLAUDE.md) ──────────────────────────────────
-- Write -> shadow (verify) -> Meridian. No destructive operations.

-- Booked appointments: the visit points at the row directly.
update public.lng_appointments a
   set status = 'complete'
  from public.lng_visits v
 where a.status = 'arrived'
   and v.appointment_id = a.id
   and v.status = 'complete';

-- Walk-ins: the marker points back at the walk-in.
update public.lng_appointments a
   set status = 'complete'
  from public.lng_visits v
 where a.status = 'arrived'
   and a.walk_in_id is not null
   and v.walk_in_id = a.walk_in_id
   and v.status = 'complete';

-- ── Rollback ─────────────────────────────────────────────────────
-- Not reversible in isolation: after the fact a flipped row cannot be
-- told apart from one that was legitimately completed. Re-derive from
-- lng_visits.status if it ever needs undoing.
