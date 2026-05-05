-- 20260505000006_lng_appointments_google_calendar_event_id.sql
--
-- Adds google_calendar_event_id to lng_appointments so the Google
-- Calendar event backing a virtual_impression_appointment can be
-- updated (on reschedule) or deleted (on cancel) later.
--
-- join_url already exists (migration 20260428000020). This column
-- is the server-side handle that pairs with it.
--
-- Rollback: ALTER TABLE public.lng_appointments DROP COLUMN google_calendar_event_id;

alter table public.lng_appointments
  add column if not exists google_calendar_event_id text;

comment on column public.lng_appointments.google_calendar_event_id is
  'Google Calendar event ID for virtual_impression_appointment rows. '
  'Populated by the google-meet-create edge function; used to patch '
  'the event time on reschedule and delete it on cancellation.';
