-- More tamper-evident attendance signals for virtual appointments.
--
-- The verdict line (20260513000006) tells the operator who joined and
-- for how long, but two more corroborating-evidence sources live in
-- the Meet + Calendar APIs that we weren't pulling:
--
--   1. Recordings + transcripts. When the host records or live-captions
--      the call, conferenceRecords/{record}/recordings and /transcripts
--      list those artefacts. The presence of either is unfakeable proof
--      the meeting happened. We persist counts, not URLs — the URLs are
--      short-lived and re-derivable on demand; counts let the card say
--      "1 recording, 2 transcripts" without an extra fetch.
--
--   2. Patient RSVP from the Calendar invite. Google publishes
--      attendees[].responseStatus on the underlying calendar event
--      (accepted / declined / tentative / needsAction). "Patient never
--      opened the invite" is a different fact from "patient opened it
--      and declined" — both useful in a dispute. patient_rsvp_updated_at
--      timestamps the last time we read the value so the card can show
--      staleness if needed.

alter table public.lng_appointments
  add column if not exists recording_count           integer not null default 0,
  add column if not exists transcript_count          integer not null default 0,
  add column if not exists patient_rsvp_status       text,
  add column if not exists patient_rsvp_updated_at   timestamptz;

comment on column public.lng_appointments.recording_count is
  'Number of recordings Google has produced for this conference record. 0 until meet-fetch-attendance runs and finds any; non-zero is unfakeable proof the meeting happened.';
comment on column public.lng_appointments.transcript_count is
  'Number of transcripts Google has produced. Same role as recording_count — corroborating evidence the call took place.';
comment on column public.lng_appointments.patient_rsvp_status is
  'Calendar event attendees[].responseStatus for the patient at the last attendance fetch. One of "accepted", "declined", "tentative", "needsAction", or NULL when no attendee row for the patient exists yet.';
comment on column public.lng_appointments.patient_rsvp_updated_at is
  'When patient_rsvp_status was last refreshed. Lets the card surface staleness if the row has not been re-fetched recently.';

-- Constraint: keep patient_rsvp_status to the four Google enum values
-- (or NULL). Defends against a future code path writing "Accepted"
-- with a capital A which would silently break the card's display
-- mapping.
alter table public.lng_appointments
  drop constraint if exists lng_appointments_patient_rsvp_status_chk;
alter table public.lng_appointments
  add constraint lng_appointments_patient_rsvp_status_chk
  check (
    patient_rsvp_status is null
    or patient_rsvp_status in ('accepted', 'declined', 'tentative', 'needsAction')
  );

NOTIFY pgrst, 'reload schema';
