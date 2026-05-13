-- Anti-fibbing telemetry for virtual appointment attendance.
--
-- Today the Meet attendance card answers "who joined and when" but
-- only after a staff member taps Refresh AND only with whatever fields
-- Google's conferenceRecords API exposed. Staff disputes ("the patient
-- never joined" / "the host wasn't there") need a falsifiable answer,
-- not a list of session rows the operator has to read.
--
-- This migration adds the columns the new verdict + grouped UI needs:
--
--   lng_appointments.conference_started_at / .conference_ended_at
--     Pulled from conferenceRecords.startTime / endTime on the first
--     successful attendance fetch. NULL after end_at means Google has
--     no record of the conference EVER opening — the smoking-gun for
--     "no one joined".
--
--   lng_meet_attendance.is_host
--     True when the row's participant display_name matches a known
--     lng_meet_hosts.display_name. Lets the card label staff vs patient
--     without trusting the operator's interpretation.
--
--   lng_meet_attendance.meet_user_id
--     Google's signedinUser.user resource id (opaque path like
--     "users/xxxx"). Same person across multiple sessions resolves to
--     the same id, so grouping is stable. Null for anonymous / phone
--     joiners — we fall back to participant_name in that case.

alter table public.lng_appointments
  add column if not exists conference_started_at timestamptz,
  add column if not exists conference_ended_at   timestamptz;

comment on column public.lng_appointments.conference_started_at is
  'Google Meet conferenceRecords.startTime, captured by meet-fetch-attendance. NULL when no conference record exists yet (meeting may not have ended, or never opened).';
comment on column public.lng_appointments.conference_ended_at is
  'Google Meet conferenceRecords.endTime. Always paired with conference_started_at — Google publishes both at once after the meeting ends.';

alter table public.lng_meet_attendance
  add column if not exists is_host       boolean not null default false,
  add column if not exists meet_user_id  text;

comment on column public.lng_meet_attendance.is_host is
  'True when the participant matches a known lng_meet_hosts.display_name. Lets the Meet attendance card distinguish staff vs patient without operator judgment.';
comment on column public.lng_meet_attendance.meet_user_id is
  'Google signedinUser.user resource id (e.g. "users/abc123"). Stable across sessions for the same person; null for anonymous / phone joiners.';

-- Index on (appointment_id, is_host) so the card's "did the host
-- attend at all" check is a single index scan instead of a row sweep.
create index if not exists lng_meet_attendance_host_idx
  on public.lng_meet_attendance (appointment_id, is_host);
