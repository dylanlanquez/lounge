-- 20260430000013_lng_visits_fulfilment.sql
--
-- Capture how the work was handed off when a visit completes —
-- either passed to the patient on the day, or to be shipped. The
-- shipping branch will drive a follow-up dispatch flow; for now
-- we just record the choice so the future flow can pick it up.
--
-- Adds:
--   fulfilment_method text null check (in ('in_person', 'shipping'))
--
-- NULL while the visit is active or terminated for a non-completion
-- reason (unsuitable / ended_early). Set when status flips to
-- 'complete' via the Complete visit sheet on VisitDetail.
--
-- Rollback: ALTER TABLE public.lng_visits DROP COLUMN IF EXISTS fulfilment_method;

alter table public.lng_visits
  add column if not exists fulfilment_method text null;

alter table public.lng_visits
  add constraint lng_visits_fulfilment_method_check
  check (
    fulfilment_method is null
    or fulfilment_method in ('in_person', 'shipping')
  );

comment on column public.lng_visits.fulfilment_method is
  'How the work was handed off at completion. NULL while the visit is active or terminated for a non-completion reason. Set when status flips to complete: in_person (patient took it on the day) or shipping (queued for dispatch).';
