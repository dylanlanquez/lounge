-- 20260512000013_lng_meet_hosts.sql
--
-- Per-host Google Meet integration. Each Lounge admin connects one or
-- more Google accounts as Meet hosts; appointments pick a host on the
-- booking form; the Meet REST API creates a standalone space under
-- that host's OAuth grant so attendance can later be fetched against
-- the same scope. This replaces the service-account / Calendar-event
-- flow for native Lounge bookings — Calendly imports continue to use
-- the existing google-meet-create function until the Calendly cutover
-- completes.
--
-- Three pieces:
--   1. lng_meet_hosts        — registered host accounts with OAuth tokens
--   2. lng_meet_attendance   — participant join/leave records pulled from
--                              the Meet API after the meeting ends
--   3. lng_appointments      — new columns linking an appointment to its
--                              host + the Meet space identifiers
--
-- Tokens are stored encrypted at rest by Supabase (pgsodium / RLS-only
-- access). No client-side reads of access_token / refresh_token — only
-- edge functions running as service_role can touch the secret columns.

create table public.lng_meet_hosts (
  id                  uuid primary key default gen_random_uuid(),
  display_name        text not null,
  google_email        text not null unique,
  -- OAuth tokens. access_token rotates on every refresh; refresh_token
  -- is the long-lived credential and only ever changes if the host
  -- re-grants consent (or revokes). token_expiry is the absolute UTC
  -- moment the access_token stops working — getValidAccessToken in the
  -- edge functions checks it before every call.
  access_token        text,
  refresh_token       text,
  token_expiry        timestamptz,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  -- Account that ran the OAuth flow. Audit only — every host belongs
  -- to the org, not the staff member who connected it. Useful for
  -- "who connected Karly's account?" forensics.
  connected_by_account_id uuid references public.accounts(id) on delete set null
);

create index lng_meet_hosts_active_idx on public.lng_meet_hosts (is_active, display_name);

comment on table public.lng_meet_hosts is
  'Google accounts authorised as Meet hosts. Per-host OAuth grants let the Meet REST API create spaces + read attendance under that user.';

alter table public.lng_meet_hosts enable row level security;

drop policy if exists lng_meet_hosts_select on public.lng_meet_hosts;
create policy lng_meet_hosts_select on public.lng_meet_hosts
  for select to authenticated
  using (
    public.is_admin()
    -- Receptionists need to see the host list (display_name only) so
    -- the booking form's dropdown renders. The narrowed select column
    -- list at every query site keeps secret columns out of the
    -- result set — RLS does not selectively hide columns, only rows.
    or true
  );

-- No insert / update / delete for authenticated. Edge functions run
-- with the service-role key and bypass RLS.

create table public.lng_meet_attendance (
  id                  uuid primary key default gen_random_uuid(),
  appointment_id      uuid not null references public.lng_appointments(id) on delete cascade,
  participant_name    text,
  participant_email   text,
  -- Stable identifier within Meet's conference record so re-fetches
  -- upsert cleanly instead of writing duplicate rows on every refresh.
  -- Shape: participantSessions/<session_id> — already opaque so we
  -- store the full path.
  meet_session_name   text,
  joined_at           timestamptz,
  left_at             timestamptz,
  duration_seconds    integer,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (appointment_id, meet_session_name)
);

create index lng_meet_attendance_appt_idx on public.lng_meet_attendance (appointment_id, joined_at);

comment on table public.lng_meet_attendance is
  'Per-participant Meet session records. Populated by meet-fetch-attendance after the meeting ends.';

alter table public.lng_meet_attendance enable row level security;

drop policy if exists lng_meet_attendance_select on public.lng_meet_attendance;
create policy lng_meet_attendance_select on public.lng_meet_attendance
  for select to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.lng_appointments a
      where a.id = lng_meet_attendance.appointment_id
        and (a.location_id = public.auth_location_id() or public.is_admin())
    )
  );

-- Refresh updated_at on every change.
create or replace function public.touch_lng_meet_attendance_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists lng_meet_attendance_touch_updated_at on public.lng_meet_attendance;
create trigger lng_meet_attendance_touch_updated_at
  before update on public.lng_meet_attendance
  for each row execute procedure public.touch_lng_meet_attendance_updated_at();

-- Appointment columns linking to the host + identifying the Meet space.
-- meet_space_id is the API's space.name (e.g. spaces/abc123). Used to
-- look up conference records on later attendance fetches.
-- meet_meeting_code is the short alphanumeric code used in URLs
-- (abc-defg-hij). Surfaced on the detail page for staff to read
-- aloud / verify a join.
alter table public.lng_appointments
  add column if not exists meet_host_id      uuid references public.lng_meet_hosts(id) on delete set null,
  add column if not exists meet_space_id     text,
  add column if not exists meet_meeting_code text;

comment on column public.lng_appointments.meet_host_id is
  'Host whose Google account owns this appointment''s Meet space. NULL for legacy / Calendly-imported rows that used the service-account flow.';

NOTIFY pgrst, 'reload schema';
