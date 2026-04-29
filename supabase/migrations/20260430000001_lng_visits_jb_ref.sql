-- 20260430000001_lng_visits_jb_ref
--
-- Adds an immutable jb_ref column to lng_visits, with a BEFORE
-- INSERT trigger that captures the value from the source row
-- (lng_appointments.jb_ref or lng_walk_ins.jb_ref) at visit
-- creation time.
--
-- Why this column exists at all: the source rows hold the
-- "currently assigned" JB. When a visit closes, those source
-- columns get nulled by application code so the box becomes
-- available for re-use. Without a copy, the historical record of
-- which JB serviced this visit would be lost — and the visit
-- timeline needs that record.
--
-- The trigger does the copy automatically so callers (Arrival,
-- markAppointmentArrived, createWalkInVisit, reverseNoShow)
-- don't have to duplicate the logic. If a caller already passed
-- jb_ref explicitly the trigger leaves it alone.

BEGIN;

ALTER TABLE lng_visits ADD COLUMN jb_ref text;

CREATE OR REPLACE FUNCTION lng_visits_capture_jb_ref()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.jb_ref IS NULL THEN
    IF NEW.appointment_id IS NOT NULL THEN
      SELECT jb_ref INTO NEW.jb_ref
      FROM lng_appointments
      WHERE id = NEW.appointment_id;
    ELSIF NEW.walk_in_id IS NOT NULL THEN
      SELECT jb_ref INTO NEW.jb_ref
      FROM lng_walk_ins
      WHERE id = NEW.walk_in_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lng_visits_capture_jb_ref_trg ON lng_visits;
CREATE TRIGGER lng_visits_capture_jb_ref_trg
BEFORE INSERT ON lng_visits
FOR EACH ROW EXECUTE FUNCTION lng_visits_capture_jb_ref();

-- Backfill existing visits so their jb_ref reflects whatever's
-- currently on the source rows. Ordering by source kind is
-- inconsequential — a visit references exactly one of
-- appointment_id or walk_in_id (CHECK constraint
-- lng_visits_one_origin enforces this).
UPDATE lng_visits v
SET jb_ref = a.jb_ref
FROM lng_appointments a
WHERE v.appointment_id = a.id
  AND v.jb_ref IS NULL
  AND a.jb_ref IS NOT NULL;

UPDATE lng_visits v
SET jb_ref = w.jb_ref
FROM lng_walk_ins w
WHERE v.walk_in_id = w.id
  AND v.jb_ref IS NULL
  AND w.jb_ref IS NOT NULL;

COMMIT;
