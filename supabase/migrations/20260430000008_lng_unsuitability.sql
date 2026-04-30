-- 20260430000008_lng_unsuitability.sql
--
-- Patient unsuitability records. When staff determine that a patient
-- cannot proceed with a particular product/service that's in their
-- basket on this visit, they file an unsuitability record from the
-- VisitDetail page. The record is per (patient, visit, catalogue_id)
-- — one record per product the patient was unsuitable for. A single
-- visit can spawn multiple records if more than one item failed.
--
-- Two moves, both additive:
--
--   1. lng_visits.status gains 'unsuitable'. Visits in this state
--      drop off the in-clinic board the same way 'complete' visits do
--      (the board filters to opened|in_progress). The visit terminates
--      here — no further work, no payment expected (the cart can stay
--      for record-keeping, and the receipt UX can be revisited
--      separately).
--
--   2. lng_unsuitability_records — immutable audit. Mirrors the
--      lng_waiver_signatures shape: insert-only, no update/delete from
--      the app, RLS write policy is insert-only.
--
-- Reason is required. The UI guards on it; the schema also enforces
-- length > 0 so a typo'd direct insert can't bypass the guard. Down-
-- stream warnings ("this patient was previously unsuitable for X")
-- read from this table in a follow-up slice.
--
-- Rollback at the bottom.

-- ── 1. lng_visits.status += 'unsuitable' ────────────────────────────────────
alter table public.lng_visits
  drop constraint if exists lng_visits_status_check;
alter table public.lng_visits
  add constraint lng_visits_status_check
  check (status in ('opened', 'in_progress', 'complete', 'cancelled', 'unsuitable'));

-- ── 2. lng_unsuitability_records ───────────────────────────────────────────
create table if not exists public.lng_unsuitability_records (
  id            uuid primary key default gen_random_uuid(),
  patient_id    uuid not null references public.patients(id)        on delete restrict,
  visit_id      uuid not null references public.lng_visits(id)      on delete restrict,
  catalogue_id  uuid not null references public.lwo_catalogue(id)   on delete restrict,
  reason        text not null check (length(btrim(reason)) > 0),
  recorded_by   uuid references public.accounts(id) on delete set null,
  recorded_at   timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

-- patient_id (timeline lookups), visit_id (per-visit re-render),
-- (catalogue_id, patient_id) for the future "has this patient been
-- unsuitable for this product before" warning. patient_id is hot —
-- own index. The composite covers catalogue lookups for that patient.
create index if not exists lng_unsuitability_records_patient_idx
  on public.lng_unsuitability_records (patient_id, recorded_at desc);
create index if not exists lng_unsuitability_records_visit_idx
  on public.lng_unsuitability_records (visit_id);
create index if not exists lng_unsuitability_records_catalogue_patient_idx
  on public.lng_unsuitability_records (catalogue_id, patient_id);

alter table public.lng_unsuitability_records enable row level security;
create policy lng_unsuitability_records_read on public.lng_unsuitability_records
  for select to authenticated using (true);
-- Insert-only writes from the app. No update/delete policy: corrections
-- happen by inserting a new record (rare) or via admin direct SQL.
create policy lng_unsuitability_records_write on public.lng_unsuitability_records
  for insert to authenticated with check (true);

comment on table public.lng_unsuitability_records is
  'Per-product unsuitability records filed from VisitDetail. Immutable: insert-only from the app. Each row = one (patient, visit, catalogue_id) finding with a free-text reason. Visits with at least one record typically have status=unsuitable.';
comment on column public.lng_unsuitability_records.catalogue_id is
  'The catalogue item the patient was unsuitable for. Required — UI gates on having items with catalogue_id in the cart.';
comment on column public.lng_unsuitability_records.reason is
  'Free-text reason from staff. Schema-enforced non-empty so a direct SQL insert can''t bypass the UI guard.';
comment on column public.lng_unsuitability_records.recorded_by is
  'accounts.id of the staff member who filed the record. Nullable so account deletion (rare) doesn''t cascade-restrict deletion of the audit row.';

-- ── Rollback ───────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS public.lng_unsuitability_records;
-- ALTER TABLE public.lng_visits DROP CONSTRAINT IF EXISTS lng_visits_status_check;
-- ALTER TABLE public.lng_visits
--   ADD CONSTRAINT lng_visits_status_check
--   CHECK (status IN ('opened', 'in_progress', 'complete', 'cancelled'));
