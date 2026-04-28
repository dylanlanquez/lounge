-- 20260428000024_lng_cart_items_catalogue_snapshot.sql
--
-- Cart-item snapshot columns for catalogue picks. The till freezes the
-- catalogue row's identity + match metadata at insert time so:
--   1. Edits to lwo_catalogue (name change, price change, deactivation)
--      never alter what was actually sold on a closed cart.
--   2. Reports can still slice by service_type / product_key / arch
--      without re-resolving the catalogue match.
--
-- Volume pricing model: ONE row per instance (qty stays at 1 on
-- catalogue lines). The picker computes the right unit_price_pence per
-- row — first instance of a SKU = unit_price, every subsequent = the
-- catalogue's extra_unit_price. No window-function trigger needed.
-- Free-form items keep qty unconstrained, but the catalogue path
-- never uses qty>1.
--
-- Existing rows survive: every new column is nullable. Pre-migration
-- free-form items (sku-only) carry through with all snapshot fields
-- null — same as before.
--
-- Rollback:
--   ALTER TABLE public.lng_cart_items
--     DROP COLUMN catalogue_id,
--     DROP COLUMN catalogue_code,
--     DROP COLUMN service_type,
--     DROP COLUMN product_key,
--     DROP COLUMN repair_variant,
--     DROP COLUMN arch,
--     DROP COLUMN shade,
--     DROP COLUMN notes;

alter table public.lng_cart_items
  add column if not exists catalogue_id    uuid references public.lwo_catalogue(id) on delete set null,
  add column if not exists catalogue_code  text,
  add column if not exists service_type    text,
  add column if not exists product_key     text,
  add column if not exists repair_variant  text,
  add column if not exists arch            text
    check (arch is null or arch in ('upper','lower','both')),
  add column if not exists shade           text,
  add column if not exists notes           text;

create index if not exists lng_cart_items_catalogue_idx
  on public.lng_cart_items (catalogue_id);

comment on column public.lng_cart_items.catalogue_id is
  'Snapshot link to the lwo_catalogue row this line item resolved from. Null = free-form ad-hoc item (rare; the picker is the standard path).';
comment on column public.lng_cart_items.catalogue_code is
  'Frozen code from the catalogue at insert time. Survives even if the catalogue row is later renamed or deactivated.';
comment on column public.lng_cart_items.arch is
  'Patient arch the line item applies to. NULL when not arch-specific (e.g. complete whitening kit).';
