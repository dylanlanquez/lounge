-- 20260506000006_lng_visits_parcel_code.sql
--
-- Adds parcel_code to lng_visits so the DPD tracking URL can be built
-- correctly. DPD's shipment API returns a parcel number (tracking_number)
-- but the tracking URL requires the parcel code which includes the *NNNNN
-- depot suffix (e.g. 15976969376288*21297). The parcel code is fetched
-- from DPD's tracking API immediately after label creation and stored here.
--
-- Rollback: ALTER TABLE public.lng_visits DROP COLUMN IF EXISTS parcel_code;

ALTER TABLE public.lng_visits ADD COLUMN IF NOT EXISTS parcel_code text;
