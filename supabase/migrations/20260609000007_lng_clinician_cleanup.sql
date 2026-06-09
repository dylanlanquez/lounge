-- 20260609000007_lng_clinician_cleanup.sql
--
-- CLEANUP — apply ONLY after the clinician-model frontend + edge
-- functions (20260609000006 + the matching deploy) are confirmed live.
--
-- 20260609000006 deliberately kept the old meet-host virtual objects in
-- place so the previously-live frontend never broke during the deploy.
-- Once the new frontend is live and stable (no sessions still reading the
-- old objects), this drops them. None of these are referenced by the new
-- frontend or edge functions.
--
-- Safe to defer indefinitely — the orphaned objects are harmless until
-- dropped. Apply: shadow first, then Meridian.

-- Old meet-host hours model (superseded by lng_clinician_hours/overrides
-- and lng_clinicians_available).
drop function if exists public.lng_set_meet_host_hours(uuid, jsonb);
drop function if exists public.lng_add_meet_host_override(uuid, date, text, time, time, text);
drop function if exists public.lng_delete_meet_host_override(uuid);
drop function if exists public.lng_set_meet_host_self_serve(uuid, boolean);
drop function if exists public.lng_meet_hosts_available(timestamptz, timestamptz, boolean, uuid, uuid);
drop table if exists public.lng_meet_host_overrides;
drop table if exists public.lng_meet_host_hours;

-- self_serve moved to lng_staff_members.clinician_self_serve.
alter table public.lng_meet_hosts drop column if exists self_serve;

NOTIFY pgrst, 'reload schema';

-- Note: lng_booking_available_slots keeps its (now unused) p_meet_host_id
-- parameter. It is a harmless no-op and removing it would mean recreating
-- the whole function body; left for a future tidy-up if desired.

-- ── Rollback ──────────────────────────────────────────────────────
-- Re-apply 20260609000001 (recreates lng_meet_host_hours/_overrides +
-- the meet-host RPCs + lng_meet_hosts_available + self_serve).
