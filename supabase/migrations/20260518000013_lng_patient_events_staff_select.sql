-- Lounge migration: grant authenticated Lounge staff SELECT on
-- patient_events.
--
-- Background — patient_events is Meridian-owned. Its current select
-- policy is admin-only OR the patient themselves:
--
--   patient_events_select (r):
--     is_admin()
--     OR EXISTS (SELECT 1 FROM patients p
--                WHERE p.id = patient_events.patient_id
--                  AND p.account_id = auth_account_id())
--
-- That blocks non-admin Lounge staff (receptionists, CS) from reading
-- the rows that drive the visit + appointment timelines. The symptom
-- in production: a non-admin staff session on VisitDetail sees the
-- synthesised visit-level rows (Patient checked in, Job box assigned,
-- cart edits) but NOT the patient_events rows (Confirmation email sent,
-- Text message delivered, deposit captured patient-event audit, etc.),
-- because the patient_events SELECT silently returns zero rows under
-- their RLS context.
--
-- Lounge staff need this read for the audit story to work. Adding a
-- parallel SELECT policy preserves the existing admin / patient rules
-- (PostgreSQL OR's permissive policies) and grants any active Lounge
-- account read access. INSERT / UPDATE / DELETE remain locked to the
-- existing writer policies — Lounge edge functions write via the
-- service-role bypass, so this change does not give staff write
-- access to the audit trail.
--
-- "Lounge account" predicate: any row in public.accounts whose
-- auth_user_id matches the request's auth.uid() and whose status is
-- 'active'. Mirrors the predicate used in is_admin() but doesn't
-- require admin member_type. CS-only accounts (is_cs_only = true)
-- still satisfy this — CS staff need timeline visibility for the
-- preview affordances, the write surfaces are gated separately in
-- the UI.

CREATE POLICY patient_events_lng_staff_select ON public.patient_events
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.accounts a
      WHERE a.auth_user_id = auth.uid()
        AND a.status = 'active'
    )
  );
