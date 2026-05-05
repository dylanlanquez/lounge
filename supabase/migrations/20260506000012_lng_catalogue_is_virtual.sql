-- 20260506000012_lng_catalogue_is_virtual.sql
--
-- Adds is_virtual to lwo_catalogue so any service can be marked as
-- a virtual (remote) session. When true, the appointment detail modal
-- replaces the standard "Mark patient as arrived" arrival wizard with
-- a "Join meeting" / "Rejoin" / "Mark as no-show" action set.
-- Virtual appointments never need a job box, never produce an EPOS
-- visit row, and use the virtual impression email templates.
--
-- Backfill: the existing virtual_impression_appt service row is the
-- only current virtual service; set it to true.
--
-- Rollback:
--   ALTER TABLE public.lwo_catalogue DROP COLUMN IF EXISTS is_virtual;

ALTER TABLE public.lwo_catalogue
  ADD COLUMN IF NOT EXISTS is_virtual boolean NOT NULL DEFAULT false;

UPDATE public.lwo_catalogue
   SET is_virtual = true
 WHERE code = 'virtual_impression_appt';
