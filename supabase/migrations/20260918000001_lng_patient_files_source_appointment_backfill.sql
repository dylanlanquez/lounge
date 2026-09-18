-- 20260918000001_lng_patient_files_source_appointment_backfill.sql
--
-- Backfills patient_files.source_appointment_id for before/after and
-- marketing-content photos uploaded before the write-side fix that
-- now stamps it on every upload from the appointment page (see
-- src/components/PhotoGallery/PhotoGallery.tsx, GalleryCard.onPick).
--
-- ── Why they were orphaned ───────────────────────────────────────
-- BeforeAfterGallery and MarketingGallery on the visit page called
-- uploadPatientFile() without ever passing sourceAppointmentId, so
-- every row landed with source_appointment_id = NULL. The label_key
-- was still correct, so the appointment page's own "N photos" count
-- (which filters on label_key only) looked right, but /marketing's
-- query requires source_appointment_id IS NOT NULL to group photos
-- by appointment, so those rows were invisible there. 0 marketing
-- photos affected: none have been uploaded yet.
--
-- ── Matching strategy ────────────────────────────────────────────
-- For each orphaned row, pick the patient's appointment whose
-- start_at is closest in absolute time to the photo's uploaded_at.
-- Staff upload during or shortly after the visit, so nearest-by-time
-- identifies the correct appointment even when the upload trails the
-- visit by hours (batch uploads at end of day were common). Ties
-- (two appointments starting at the identical instant, seen once, a
-- reschedule that kept the original slot) are broken in favour of
-- whichever appointment is not 'cancelled'/'rescheduled'.
--
-- Verified against Meridian on 18 Sep 2026 in a rolled-back
-- transaction before this migration was written: 34 rows matched (15
-- before_photo, 19 after_photo, 0 marketing_content), every match
-- unambiguous after the tiebreak, none more than 8 days from the
-- appointment it matched (most within hours).
--
-- Idempotent: only touches rows where source_appointment_id IS NULL,
-- so re-running after the first successful pass matches nothing.
--
-- ── Apply order (per CLAUDE.md) ──────────────────────────────────
-- Write -> shadow (verify) -> Meridian. The shadow project holds
-- Meridian's schema only, no patient data, so "verify" here means
-- the rolled-back preview transaction above, not a shadow run.

with orphans as (
  select pf.id as file_id, pf.patient_id, pf.uploaded_at
  from public.patient_files pf
  join public.file_labels fl on fl.id = pf.label_id
  where fl.key in ('before_photo', 'after_photo', 'marketing_content')
    and pf.status = 'active'
    and pf.source_appointment_id is null
),
candidates as (
  select
    o.file_id,
    a.id as appt_id,
    row_number() over (
      partition by o.file_id
      order by
        abs(extract(epoch from (o.uploaded_at - a.start_at))) asc,
        (a.status in ('cancelled', 'rescheduled')) asc
    ) as rn
  from orphans o
  join public.lng_appointments a on a.patient_id = o.patient_id
)
update public.patient_files pf
set source_appointment_id = c.appt_id
from candidates c
where c.file_id = pf.id
  and c.rn = 1;

-- ── Rollback ─────────────────────────────────────────────────────
-- Not reversible in isolation: after the fact a backfilled row can't
-- be told apart from one uploaded with the fix already live. Re-derive
-- from this migration's own preview output if it ever needs undoing
-- (see the psql transcript in the PR/session that shipped this file).
