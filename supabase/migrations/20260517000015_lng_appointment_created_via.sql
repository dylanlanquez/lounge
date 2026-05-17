-- lng_appointments.created_via + created_via_actor
--
-- Records the origin of a booking when it didn't come from the Lounge
-- app itself. Bookings created via the in-app NewBookingSheet leave
-- both columns null; bookings created via the public widget set
-- created_via='widget'; bookings created from Checkpoint's ScanView
-- booker set created_via='checkpoint' AND created_via_actor to the
-- staff member's display name (e.g. "Dylan Lane").
--
-- Why the actor name is a free-text string and not a foreign key to
-- accounts: Checkpoint runs against a different Supabase project, so
-- the user_id auth.uid() referenced there has no matching row in
-- Lounge's accounts table. The display name is what staff and the
-- audit trail care about; the cross-project id can be added later
-- via a separate audit column if it ever becomes load-bearing.

alter table public.lng_appointments
  add column if not exists created_via       text,
  add column if not exists created_via_actor text;

comment on column public.lng_appointments.created_via is
  'Origin tag for non-Lounge booking sources. Today: ''widget'' for the public embed, ''checkpoint'' for ScanView. Null for in-app NewBookingSheet bookings.';

comment on column public.lng_appointments.created_via_actor is
  'Display name of the staff member who initiated the booking from an external surface (Checkpoint). Free text, no FK because the referenced user lives in a different Supabase project. Null for customer-self-service widget bookings.';

-- Index — appointment views filter by created_via to render the
-- "Booked through Checkpoint" attribution badge. Partial so the
-- index only covers rows that actually carry a value.
create index if not exists lng_appointments_created_via_idx
  on public.lng_appointments(created_via)
  where created_via is not null;
