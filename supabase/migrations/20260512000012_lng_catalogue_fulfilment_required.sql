-- 20260512000012_lng_catalogue_fulfilment_required.sql
--
-- Adds fulfilment_required to lwo_catalogue. When false, the Complete
-- visit flow skips the in-person / shipping question entirely — the
-- visit just finishes, no fulfilment method recorded. Used by virtual
-- impression appointments and any future service where the patient
-- takes nothing physical away (and nothing is shipped out later).
--
-- Decision logic:
--   • Cart has any active item whose catalogue row is
--     fulfilment_required=true  → show the fulfilment sheet (current
--                                  behaviour).
--   • Cart has no fulfilment-required items                  → skip the
--                                                              sheet,
--                                                              finish
--                                                              with
--                                                              fulfilment_method=null.
--
-- Default true preserves existing behaviour for every service that
-- isn't explicitly flagged. The backfill below flips it to false for
-- the two service shapes that already have nothing to hand off:
--   • is_virtual=true       — virtual sessions
--   • code='impression_appt' — in-person impression appointments
--                              where the impression is captured and
--                              processed digitally; nothing is given
--                              to the patient on the day and nothing
--                              is shipped (the eventual appliance is
--                              a separate booking).
--
-- Rollback:
--   ALTER TABLE public.lwo_catalogue DROP COLUMN IF EXISTS fulfilment_required;

ALTER TABLE public.lwo_catalogue
  ADD COLUMN IF NOT EXISTS fulfilment_required boolean NOT NULL DEFAULT true;

UPDATE public.lwo_catalogue
   SET fulfilment_required = false
 WHERE is_virtual = true;

COMMENT ON COLUMN public.lwo_catalogue.fulfilment_required IS
  'When false, Complete visit skips the in-person / shipping fulfilment sheet for any cart containing only items from this catalogue row. Backfilled false for virtual services on migration.';

NOTIFY pgrst, 'reload schema';
