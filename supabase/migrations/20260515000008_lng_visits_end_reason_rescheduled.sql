-- 20260515000008_lng_visits_end_reason_rescheduled.sql
--
-- Add 'rescheduled' to the lng_visits visit_end_reason whitelist.
--
-- When the operator reschedules an appointment for a patient who's
-- already been marked arrived (visit row exists), the right semantic
-- is to end the visit with reason='rescheduled' — the historical
-- visit is closed; the new appointment is fresh; reports can
-- separately count "visits that ended because of reschedule" from
-- "visits that ended because the booking was wrong" / "patient
-- walked out" / etc. The previous CHECK constraint forced us to
-- reuse 'wrong_booking' or 'other' for this, both of which carry
-- the wrong meaning in audit + reports.
--
-- The check has TWO arms — one for the "no end reason / no end
-- note" case and one for the "ended_early or unsuitable" case.
-- Only the second arm needs the new value; the first arm stays as
-- a "must be null when status isn't an ending status" guard.
--
-- Apply order per CLAUDE.md: shadow first, then production.
-- Rollback: drop the new constraint + recreate the old one with
-- the smaller whitelist.

alter table public.lng_visits
  drop constraint if exists lng_visits_end_reason_check;

alter table public.lng_visits
  add constraint lng_visits_end_reason_check
  check (
    (status <> all (array['unsuitable'::text, 'ended_early'::text]))
      and visit_end_reason is null
      and visit_end_note is null
    or
    (status = any (array['unsuitable'::text, 'ended_early'::text]))
      and (
        visit_end_reason = any (
          array[
            'unsuitable'::text,
            'patient_declined'::text,
            'patient_walked_out'::text,
            'wrong_booking'::text,
            'rescheduled'::text,
            'other'::text
          ]
        )
      )
      and length(btrim(coalesce(visit_end_note, ''::text))) > 0
  );

comment on constraint lng_visits_end_reason_check on public.lng_visits is
  'visit_end_reason + visit_end_note must be null unless status is unsuitable / ended_early. When status is one of those two, end_reason picks from a fixed whitelist (unsuitable / patient_declined / patient_walked_out / wrong_booking / rescheduled / other) and end_note must be non-blank.';
