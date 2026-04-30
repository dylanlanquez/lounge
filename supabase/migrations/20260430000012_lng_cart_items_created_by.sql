-- 20260430000012_lng_cart_items_created_by.sql
--
-- Audit who added each cart line. Today the timeline says "Added
-- Broken tooth on denture" with no actor, even when the visit's
-- receptionist is on duty — lng_cart_items has no creator column,
-- so the timeline has nothing to surface. Adds:
--
--   created_by uuid references accounts(id) on delete set null
--
-- NULL is allowed for legacy rows (no backfill — we don't know who
-- added them retrospectively, and guessing from visit.receptionist_id
-- would be wrong on multi-staff visits). New rows get stamped at
-- insert from auth_account_id() so the timeline can render
-- "Added X by [name]" going forward.
--
-- Rollback: ALTER TABLE public.lng_cart_items DROP COLUMN IF EXISTS created_by;

alter table public.lng_cart_items
  add column if not exists created_by uuid null
    references public.accounts(id) on delete set null;

comment on column public.lng_cart_items.created_by is
  'accounts.id of the staff member who added this line via the picker. NULL only on legacy rows or when the account was later deleted (set null on delete). Surfaces as the actor on the visit timeline''s "Added [name]" event.';
