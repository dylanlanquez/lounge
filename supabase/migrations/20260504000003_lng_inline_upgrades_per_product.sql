-- 20260504000003_lng_inline_upgrades_per_product.sql
--
-- Collapses the upgrades model from registry + per-product link table
-- down to a single per-product table. Each catalogue row now owns its
-- own list of upgrade rows (name, code, display_position, price,
-- both_arches_price). The shared registry was always speculative — in
-- practice each product expressed its own upgrades, so the join just
-- got in the way (and the admin UI showed every registered upgrade on
-- every product, even ones that didn't apply).
--
-- Rewrites in place:
--
--   1. Adds catalogue_id / price / both_arches_price to
--      lng_catalogue_upgrades.
--   2. Duplicates each registry row per existing link and copies the
--      link's price + both_arches_price onto the duplicate.
--   3. Deletes the original registry rows (no catalogue_id) — anything
--      that wasn't linked to a product is dropped on purpose; the new
--      model has no concept of an unattached upgrade.
--   4. Drops the old code-unique constraint and re-keys uniqueness on
--      (catalogue_id, code) so two products can both have a "scallop"
--      code without colliding.
--   5. Drops lng_catalogue_upgrade_links.
--
-- Receipts are unaffected: lng_cart_item_upgrades snapshots
-- upgrade_code / upgrade_name / price_pence at insert. We null out
-- upgrade_id up front (it's already nullable + ON DELETE SET NULL) so
-- recreating rows can't dangle the FK; the snapshot fields carry the
-- truth on every existing receipt.

begin;

-- ── 1. Drop FK pointers from cart upgrades to the registry ────────────────
-- The snapshot columns (upgrade_code / upgrade_name / price_pence)
-- already carry every value receipts need. Nulling the back-reference
-- frees us to re-shape the registry without worrying about FK breakage.
update public.lng_cart_item_upgrades
   set upgrade_id = null
 where upgrade_id is not null;

-- ── 2. Drop the global code-unique constraint ─────────────────────────────
-- After this migration, two different products can each own an upgrade
-- with code 'scallop'; uniqueness becomes scoped to (catalogue_id, code).
alter table public.lng_catalogue_upgrades
  drop constraint if exists lng_catalogue_upgrades_code_key;

-- ── 3. Add per-product columns (nullable while we backfill) ───────────────
alter table public.lng_catalogue_upgrades
  add column if not exists catalogue_id      uuid null
    references public.lwo_catalogue(id) on delete cascade,
  add column if not exists price             numeric(10,2) null,
  add column if not exists both_arches_price numeric(10,2) null;

-- ── 4. Duplicate each registry row per link ───────────────────────────────
-- One INSERT per (catalogue_id, upgrade_id) link. The duplicate carries
-- the upgrade's metadata (code, name, description, display_position,
-- sort_order, active) plus the link's price + both_arches_price. Each
-- duplicate gets a fresh UUID; the originals get deleted in step 5.
insert into public.lng_catalogue_upgrades (
  catalogue_id, code, name, description, display_position,
  sort_order, active, price, both_arches_price
)
select
  l.catalogue_id,
  u.code,
  u.name,
  u.description,
  u.display_position,
  u.sort_order,
  u.active,
  l.price,
  l.both_arches_price
from public.lng_catalogue_upgrade_links l
join public.lng_catalogue_upgrades u on u.id = l.upgrade_id;

-- ── 5. Drop the old registry rows (no catalogue_id == originals) ──────────
delete from public.lng_catalogue_upgrades where catalogue_id is null;

-- ── 6. Lock the new columns down ──────────────────────────────────────────
alter table public.lng_catalogue_upgrades
  alter column catalogue_id set not null,
  alter column price        set not null;

-- ── 7. Replace the unique index ───────────────────────────────────────────
create unique index if not exists lng_catalogue_upgrades_catalogue_code_uidx
  on public.lng_catalogue_upgrades (catalogue_id, code);

-- Picker query path: read per-catalogue, active, sorted.
create index if not exists lng_catalogue_upgrades_catalogue_active_sort_idx
  on public.lng_catalogue_upgrades (catalogue_id, active, sort_order);

-- ── 8. Drop the now-redundant link table ──────────────────────────────────
drop table if exists public.lng_catalogue_upgrade_links;

-- ── 9. Refresh table comment ──────────────────────────────────────────────
comment on table public.lng_catalogue_upgrades is
  'Per-product upgrade rows. Each catalogue row owns its own upgrades; (catalogue_id, code) is unique. price is the single-arch / non-arch upgrade cost; both_arches_price is the upgrade cost when the parent line is bought as both arches (NULL for non-arch products).';

comment on column public.lng_catalogue_upgrades.catalogue_id is
  'Owning catalogue row. Cascade delete: removing a product wipes its upgrade rows. Receipts stay frozen via lng_cart_item_upgrades snapshot columns.';

comment on column public.lng_catalogue_upgrades.price is
  'Pounds. Applied when the cart line is single-arch or non-arch.';

comment on column public.lng_catalogue_upgrades.both_arches_price is
  'Pounds. Applied when the parent line is bought as both arches. NULL for products without arch options.';

commit;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- Forward-only — this collapses two tables into one and discards orphan
-- registry rows. There is no clean reverse. To undo, restore from a
-- pre-migration backup.
