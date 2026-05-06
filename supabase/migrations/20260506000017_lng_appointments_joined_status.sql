-- 20260506000017_lng_appointments_joined_status.sql
--
-- Virtual appointments use 'arrived' when a staff member joins the call,
-- but "Arrived" is meaningless for a Google Meet — nobody "arrived"
-- anywhere. Add 'joined' as the virtual-specific equivalent.
--
-- In-person flow:  booked → arrived → complete / no_show / cancelled
-- Virtual flow:    booked → joined  → complete / no_show / cancelled
--
-- 'arrived' stays valid so in-person rows are not affected.

ALTER TABLE public.lng_appointments
  DROP CONSTRAINT IF EXISTS lng_appointments_status_check;

ALTER TABLE public.lng_appointments
  ADD CONSTRAINT lng_appointments_status_check
  CHECK (status IN ('booked', 'arrived', 'joined', 'complete', 'no_show', 'cancelled', 'rescheduled'));

-- Backfill: any virtual appointment that was flipped to 'arrived' by
-- markVirtualMeetingJoined() now gets the correct 'joined' value.
UPDATE public.lng_appointments
   SET status = 'joined'
 WHERE status = 'arrived'
   AND join_url IS NOT NULL;
