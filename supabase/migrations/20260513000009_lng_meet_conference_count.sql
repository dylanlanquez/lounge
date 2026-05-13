-- conference_count for the attendance card. Meet spaces can host
-- more than one conference over their lifetime (yesterday's empty
-- room + today's actual call, or back-to-back follow-ups in the same
-- space). meet-fetch-attendance now walks every conferenceRecord
-- returned for the space and aggregates sessions, recordings,
-- transcripts across them; this column tells the UI whether to render
-- "Conference window: X → Y" or "Conference window: X → Y (3 conferences)"
-- so a multi-conference history is visible at a glance.

alter table public.lng_appointments
  add column if not exists conference_count integer not null default 0;

comment on column public.lng_appointments.conference_count is
  'Number of distinct Google Meet conferences logged against this appointment''s space. 0 until meet-fetch-attendance runs and finds any. 2+ means the space hosted more than one call — common when a meeting was rescheduled or rejoined out-of-window.';

NOTIFY pgrst, 'reload schema';
