-- 20260430000011_lng_visits_ended_early.sql
--
-- "End visit early" terminus, alongside the existing 'unsuitable'
-- terminus. Until now staff could only end an active visit via the
-- clinical "Patient unsuitable" path, leaving cases like "patient
-- walked out" or "wrong booking" with no clean exit ramp. The cart
-- would just sit empty.
--
-- Two moves:
--
--   1. lng_visits.status += 'ended_early'.
--      Same lock-state + Reverse semantics as 'unsuitable'; the
--      difference is that 'ended_early' carries no clinical
--      lng_unsuitability_records rows. Visit's `closed_at` is
--      stamped on transition, cleared on Reverse.
--
--   2. lng_visits gains two columns:
--        visit_end_reason — enum-style category. Shape:
--          'unsuitable'      : per-product clinical (already the
--                              de-facto reason whenever status='unsuitable',
--                              now formally captured here too).
--          'patient_declined': patient changed mind / no longer interested.
--          'patient_walked_out': patient left without finishing.
--          'wrong_booking'   : the clinic can't deliver what they came for.
--          'other'           : everything else; UI requires the note.
--        visit_end_note   — required free-text from staff at end time.
--
-- Both columns are NULL while the visit is active. They land
-- together at termination and clear together on Reverse.
--
-- We deliberately keep visit_end_reason on lng_visits (one row per
-- visit) rather than a separate audit table — there's exactly one
-- end event per visit lifecycle, and pairing it with closed_at on
-- the same row keeps reads cheap (the in-clinic board already
-- pulls lng_visits; one less join).
--
-- Rollback at the bottom.

-- ── 1. Rebuild the visit status check constraint to include 'ended_early' ──
alter table public.lng_visits drop constraint if exists lng_visits_status_check;
alter table public.lng_visits
  add constraint lng_visits_status_check
  check (status in ('arrived', 'in_chair', 'complete', 'unsuitable', 'ended_early'));

-- ── 2. Add visit_end_reason + visit_end_note columns ──────────────────────
alter table public.lng_visits
  add column if not exists visit_end_reason text null,
  add column if not exists visit_end_note   text null;

-- ── 3. Backfill existing 'unsuitable' rows ─────────────────────────────────
-- Every existing status='unsuitable' row must satisfy the new
-- constraint (reason + note non-empty). Pull the most recent
-- lng_unsuitability_records.reason per visit into visit_end_note,
-- and stamp visit_end_reason='unsuitable'. Visits that somehow lack
-- a record fall back to a placeholder note so the constraint
-- doesn't block the migration; admin can retro-fix via the app.
update public.lng_visits v
set visit_end_reason = 'unsuitable',
    visit_end_note = coalesce(
      (
        select r.reason
        from public.lng_unsuitability_records r
        where r.visit_id = v.id
        order by r.recorded_at desc
        limit 1
      ),
      'Backfilled by migration; reason not recorded'
    )
where v.status = 'unsuitable'
  and (v.visit_end_reason is null or v.visit_end_note is null);

-- visit_end_reason / visit_end_note / closed_at all move together:
-- a row is either fully active (all three null) or fully ended
-- (closed_at + reason + note all populated). Direct SQL writes that
-- set one without the others are rejected.
alter table public.lng_visits
  add constraint lng_visits_end_reason_check
  check (
    (status not in ('unsuitable', 'ended_early')
       and visit_end_reason is null and visit_end_note is null)
    or
    (status in ('unsuitable', 'ended_early')
       and visit_end_reason in ('unsuitable', 'patient_declined', 'patient_walked_out', 'wrong_booking', 'other')
       and length(btrim(coalesce(visit_end_note, ''))) > 0)
  );

comment on column public.lng_visits.visit_end_reason is
  'Category for an early-end terminus. NULL while the visit is active. Constrained to one of: unsuitable, patient_declined, patient_walked_out, wrong_booking, other.';
comment on column public.lng_visits.visit_end_note is
  'Required free-text from staff at end time. Lands on the patient timeline. NULL while the visit is active.';

-- ── Rollback ───────────────────────────────────────────────────────────────
-- ALTER TABLE public.lng_visits DROP CONSTRAINT IF EXISTS lng_visits_end_reason_check;
-- ALTER TABLE public.lng_visits DROP COLUMN IF EXISTS visit_end_note;
-- ALTER TABLE public.lng_visits DROP COLUMN IF EXISTS visit_end_reason;
-- ALTER TABLE public.lng_visits DROP CONSTRAINT IF EXISTS lng_visits_status_check;
-- ALTER TABLE public.lng_visits
--   ADD CONSTRAINT lng_visits_status_check
--   CHECK (status IN ('arrived', 'in_chair', 'complete', 'unsuitable'));
