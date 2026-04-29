-- 20260430000002_lng_jb_ref_cleanup_closed
--
-- One-time data cleanup. Visits that closed before
-- 20260430000001 + the matching Pay.closeVisit change shipped
-- still have jb_ref pinned to their source rows
-- (lng_appointments / lng_walk_ins). Those boxes read as "in use"
-- to the new checkpoint-jb-check edge function but the
-- corresponding visits are already complete, so they should be
-- free.
--
-- Null the source row's jb_ref wherever the linked visit is in a
-- terminal state (complete or cancelled). Visits still open or
-- in_progress are left alone — those JBs really are in use.
--
-- The visit's own jb_ref column is the immutable historical
-- record (preserved by trigger lng_visits_capture_jb_ref_trg);
-- this cleanup only touches the "currently assigned" surfaces.

BEGIN;

UPDATE lng_appointments a
SET jb_ref = NULL
WHERE a.jb_ref IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM lng_visits v
    WHERE v.appointment_id = a.id
      AND v.status IN ('complete', 'cancelled')
  );

UPDATE lng_walk_ins w
SET jb_ref = NULL
WHERE w.jb_ref IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM lng_visits v
    WHERE v.walk_in_id = w.id
      AND v.status IN ('complete', 'cancelled')
  );

COMMIT;
