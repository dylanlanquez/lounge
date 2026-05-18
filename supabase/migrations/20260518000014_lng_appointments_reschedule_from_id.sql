-- Lounge migration: add backward chain pointer on lng_appointments.
--
-- Background — today the reschedule chain only walks forward via
-- reschedule_to_id (set on the OLD row when it's flipped to
-- 'rescheduled'). Walking backward (given a row, find the previous
-- generation in the chain) requires scanning the table for
-- `WHERE reschedule_to_id = ?`, which is unindexed and gets
-- expensive as the chain grows. Reports that show "this booking
-- originated as X on date Y, was rescheduled N times" had no
-- direct path.
--
-- Add reschedule_from_id mirroring reschedule_to_id. Both reschedule
-- writers (rescheduleAppointment.ts staff path and
-- widget-reschedule-booking edge function self-serve path) will be
-- updated to populate it on the new row at insert time.
--
-- Backfill: every existing row whose id is referenced by another
-- row's reschedule_to_id gets its reschedule_from_id set to that
-- referrer. Idempotent — running this migration twice is a no-op.

ALTER TABLE public.lng_appointments
  ADD COLUMN IF NOT EXISTS reschedule_from_id uuid
    REFERENCES public.lng_appointments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS lng_appointments_reschedule_from_id_idx
  ON public.lng_appointments(reschedule_from_id)
  WHERE reschedule_from_id IS NOT NULL;

-- Backfill from the existing forward pointers. Set every newly-added
-- column to the row that points at it via reschedule_to_id.
UPDATE public.lng_appointments AS new_row
SET reschedule_from_id = old_row.id
FROM public.lng_appointments AS old_row
WHERE old_row.reschedule_to_id = new_row.id
  AND new_row.reschedule_from_id IS NULL;
