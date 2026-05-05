-- 20260505000003_lng_visits_drop_in_chair.sql
--
-- 'in_chair' was carried as a separate visit status from 'arrived',
-- meant to mark the moment the patient sat down in the dentist's
-- chair. In practice the lab never used the transition — once a
-- patient is marked 'arrived' that's effectively them in the chair —
-- and the term itself read as jargon to onlookers. The state has
-- become a UX wart: a status filter option, a hero-ribbon variant,
-- a lifecycle row, all carrying weight for a transition that never
-- fires.
--
-- Migrate any in_chair rows back to 'arrived' (defensive; production
-- currently has zero), then rebuild the check constraint without it.
-- After this migration:
--
--   • Visit lifecycle: arrived → complete (or unsuitable / ended_early).
--   • reverseUnsuitability returns the visit to 'arrived' (the only
--     code path that ever set 'in_chair').
--
-- Rollback at the bottom restores the previous constraint.

-- ── 1. Migrate any stragglers ─────────────────────────────────────
update public.lng_visits set status = 'arrived' where status = 'in_chair';

-- ── 2. Rebuild the check constraint without 'in_chair' ────────────
alter table public.lng_visits drop constraint if exists lng_visits_status_check;
alter table public.lng_visits
  add constraint lng_visits_status_check
  check (status in ('arrived', 'complete', 'unsuitable', 'ended_early'));

-- ── Rollback ─────────────────────────────────────────────────────
-- ALTER TABLE public.lng_visits DROP CONSTRAINT IF EXISTS lng_visits_status_check;
-- ALTER TABLE public.lng_visits
--   ADD CONSTRAINT lng_visits_status_check
--   CHECK (status IN ('arrived', 'in_chair', 'complete', 'unsuitable', 'ended_early'));
