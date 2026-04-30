-- 20260430000014_lng_cart_discounts.sql
--
-- Sale-level discount audit + manager-flag column.
--
-- Two moves:
--
--   1. accounts.is_manager — boolean flag. The Staff tab in Admin
--      flips this on for accounts that can sign off discounts (and,
--      in time, voids and other manager-required actions). The
--      discount sheet's Manager dropdown reads accounts where
--      is_manager = true.
--
--   2. lng_cart_discounts — audit table for cart-level discounts.
--      One row per applied discount; soft-deleted via removed_at +
--      removed_reason when staff lifts the discount. Re-applying
--      means a new row.
--
-- The actual discount AMOUNT lives on lng_carts.discount_pence
-- (already a column on the cart, factored into total_pence via the
-- generated-column expression). This audit row records who applied,
-- who approved, the reason, and the timeline. Mutations keep the
-- cart's discount_pence in sync with the active row.
--
-- Anti-theft: every apply / remove writes both staff ids
-- (cashier + manager) onto the audit row. Manager re-auths their
-- password client-side (mirrors the void flow); the dropdown alone
-- is just a name selection.
--
-- Rollback at the bottom.

-- ── 1. accounts.is_manager ─────────────────────────────────────────────────
alter table public.accounts
  add column if not exists is_manager boolean not null default false;

comment on column public.accounts.is_manager is
  'True when this account can authorise manager-required actions (discounts, voids, etc.). Surfaced in the Lounge Admin > Staff tab; the dropdown in the Apply Discount sheet reads where is_manager = true.';

-- ── 2. lng_cart_discounts audit table ──────────────────────────────────────
create table if not exists public.lng_cart_discounts (
  id              uuid primary key default gen_random_uuid(),
  cart_id         uuid not null references public.lng_carts(id) on delete cascade,
  amount_pence    integer not null check (amount_pence > 0),
  reason          text not null check (length(btrim(reason)) > 0),
  applied_by      uuid references public.accounts(id) on delete set null,
  approved_by     uuid not null references public.accounts(id) on delete restrict,
  applied_at      timestamptz not null default now(),
  removed_at      timestamptz null,
  removed_by      uuid null references public.accounts(id) on delete set null,
  removed_reason  text null,
  created_at      timestamptz not null default now()
);

-- Active vs removed: one row is "active" iff removed_at is NULL.
-- A cart should only ever have one active discount at a time;
-- the unique partial index enforces it.
create unique index if not exists lng_cart_discounts_one_active_per_cart
  on public.lng_cart_discounts (cart_id)
  where removed_at is null;

-- Approver must differ from applier — anti-self-approval. Belt-
-- and-braces: the client also blocks this, but the constraint
-- catches direct SQL writes.
alter table public.lng_cart_discounts
  add constraint lng_cart_discounts_approver_distinct
  check (approved_by <> applied_by or applied_by is null);

-- Removed_at and removed_reason move together: a row is either
-- active (both null) or removed (both set, with a non-empty reason).
alter table public.lng_cart_discounts
  add constraint lng_cart_discounts_removed_pair
  check (
    (removed_at is null and removed_reason is null)
    or
    (removed_at is not null and length(btrim(coalesce(removed_reason, ''))) > 0)
  );

alter table public.lng_cart_discounts enable row level security;
create policy lng_cart_discounts_read on public.lng_cart_discounts
  for select to authenticated using (true);
-- Insert / update are normal flows; the constraints above stop
-- bad shapes from landing.
create policy lng_cart_discounts_write on public.lng_cart_discounts
  for all to authenticated using (true) with check (true);

comment on table public.lng_cart_discounts is
  'Audit trail for sale-level cart discounts. One row per applied discount; soft-removed via removed_at + removed_reason. The cart''s discount_pence column carries the live amount and gets updated alongside this table by the application layer.';

-- ── Rollback ───────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS public.lng_cart_discounts;
-- ALTER TABLE public.accounts DROP COLUMN IF EXISTS is_manager;
