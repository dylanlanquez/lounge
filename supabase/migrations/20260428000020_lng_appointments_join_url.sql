-- 20260428000020_lng_appointments_join_url.sql
--
-- Adds `join_url text` to lng_appointments for virtual appointments.
-- Calendly returns the Google Meet / Zoom / Teams URL via
-- `scheduled_event.location.join_url` (or `.location` when it's a bare URL).
-- The receptionist needs a one-tap "Join meeting" button on the booking
-- detail for Virtual Impression Appointments.
--
-- Rollback: ALTER TABLE public.lng_appointments DROP COLUMN join_url;

alter table public.lng_appointments
  add column if not exists join_url text;

comment on column public.lng_appointments.join_url is
  'Conferencing URL (Google Meet / Zoom / Teams) for virtual appointments. NULL for in-person.';
