-- 20260430000010_lng_cart_items_soft_delete.sql
--
-- Soft-delete columns on lng_cart_items so the trash affordance on
-- the cart line goes through an audited "Remove" flow rather than a
-- silent DELETE. Three reason categories:
--
--   mistake       — staff added the wrong product (typo, wrong row).
--                   Lightweight audit; line vanishes from the cart UI.
--   changed_mind  — patient declined this product. Optional free-text
--                   note. Lighter audit, line vanishes.
--   unsuitable    — patient is clinically unsuitable for this product.
--                   Required reason; ALSO writes a row to
--                   lng_unsuitability_records (existing audit table)
--                   and may terminate the visit.
--
-- Why soft-delete: the visit-level Reverse-unsuitable flow needs the
-- removed lines to come back when staff reverses the verdict. Hard
-- DELETE would lose the original arch / shade / upgrades / qty and
-- force staff to re-pick from the catalogue, which is friction
-- nobody wants on a finger-slip. Reverse un-flags every soft-deleted
-- line on the visit so the cart returns exactly as it was.
--
-- Audit row continuity: the cart_item row itself records who removed
-- it and when (removed_by, removed_at), independent of the
-- patient_events / lng_unsuitability_records writes that the
-- application layer also fires. Even if a downstream consumer
-- ignores those secondary tables, the cart_items row is
-- self-describing.
--
-- A partial index on (cart_id) WHERE removed_at IS NULL keeps the
-- "active cart" query fast as soft-deletions accumulate.
--
-- Rollback at the bottom.

alter table public.lng_cart_items
  add column if not exists removed_at     timestamptz null,
  add column if not exists removed_reason text        null,
  add column if not exists removed_by     uuid        null
    references public.accounts(id) on delete set null,
  add column if not exists removed_note   text        null;

-- removed_at and removed_reason move together: a row is either fully
-- active (both null) or fully removed (both non-null with a known
-- reason). Direct SQL writes that set one without the other are
-- rejected at the constraint.
alter table public.lng_cart_items
  add constraint lng_cart_items_removed_pair_check
  check (
    (removed_at is null and removed_reason is null)
    or
    (removed_at is not null and removed_reason in ('mistake', 'changed_mind', 'unsuitable'))
  );

-- Partial index — most cart reads look at active lines only, so a
-- WHERE removed_at IS NULL clause is hot. Tiny index, big win as
-- soft-deletions accumulate over time.
create index if not exists lng_cart_items_active_cart_idx
  on public.lng_cart_items (cart_id, sort_order)
  where removed_at is null;

comment on column public.lng_cart_items.removed_at is
  'Timestamp the line was soft-deleted via the Remove flow. NULL while the line is active in the cart. Pairs with removed_reason; both move together.';
comment on column public.lng_cart_items.removed_reason is
  'Reason category from the Remove sheet: mistake (staff error), changed_mind (patient declined), unsuitable (clinical). NULL while the line is active.';
comment on column public.lng_cart_items.removed_by is
  'accounts.id of the staff member who removed the line. NULL only when the line is still active or the account row was later deleted (set null on delete).';
comment on column public.lng_cart_items.removed_note is
  'Optional free-text accompanying the removal. Required by UI for unsuitable; optional for changed_mind; unused for mistake.';

-- ── Rollback ───────────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS public.lng_cart_items_active_cart_idx;
-- ALTER TABLE public.lng_cart_items
--   DROP CONSTRAINT IF EXISTS lng_cart_items_removed_pair_check,
--   DROP COLUMN IF EXISTS removed_note,
--   DROP COLUMN IF EXISTS removed_by,
--   DROP COLUMN IF EXISTS removed_reason,
--   DROP COLUMN IF EXISTS removed_at;
