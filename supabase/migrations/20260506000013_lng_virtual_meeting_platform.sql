-- Virtual meeting platform support
--
-- 1. lwo_catalogue.meeting_platform — which video platform a virtual
--    service uses. Set in admin (Services tab) when is_virtual = true.
--    Null for in-person rows.
--
-- 2. lng_appointments.meeting_platform — copied from the catalogue at
--    booking time so historical appointments retain the correct label
--    even if the catalogue row is later changed. Backfilled here from
--    the join_url domain for existing rows.
--
-- 3. lng_settings virtual.host_email — the Venneir Google account that
--    joins every Meet call. Editable in admin so it can change without
--    a code deploy.

-- ── 1. lwo_catalogue ─────────────────────────────────────────────────────────

ALTER TABLE public.lwo_catalogue
  ADD COLUMN IF NOT EXISTS meeting_platform text;

COMMENT ON COLUMN public.lwo_catalogue.meeting_platform IS
  'Video platform used for virtual services (google_meet | zoom | microsoft_teams). NULL for in-person rows.';

UPDATE public.lwo_catalogue
   SET meeting_platform = 'google_meet'
 WHERE code = 'virtual_impression_appt';

-- ── 2. lng_appointments ───────────────────────────────────────────────────────

ALTER TABLE public.lng_appointments
  ADD COLUMN IF NOT EXISTS meeting_platform text;

COMMENT ON COLUMN public.lng_appointments.meeting_platform IS
  'Video platform for this appointment (google_meet | zoom | microsoft_teams). Copied from the catalogue at booking time. NULL for in-person.';

-- Backfill existing virtual rows from the join_url domain.
UPDATE public.lng_appointments
   SET meeting_platform = CASE
     WHEN join_url LIKE '%meet.google.com%' THEN 'google_meet'
     WHEN join_url LIKE '%zoom.us%'         THEN 'zoom'
     WHEN join_url LIKE '%teams.microsoft%' THEN 'microsoft_teams'
     WHEN join_url LIKE '%whereby.com%'     THEN 'whereby'
     ELSE NULL
   END
 WHERE join_url IS NOT NULL
   AND meeting_platform IS NULL;

-- ── 3. lng_settings — virtual.host_email ─────────────────────────────────────

INSERT INTO public.lng_settings (location_id, key, value)
VALUES (NULL, 'virtual.host_email', to_jsonb('venneirlaboratory@gmail.com'::text))
ON CONFLICT (key) WHERE location_id IS NULL DO NOTHING;
