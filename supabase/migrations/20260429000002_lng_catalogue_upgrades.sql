-- 20260429000002_lng_catalogue_upgrades.sql
--
-- Catalogue picker overhaul, schema half. Three things land here:
--
--   1. lwo_catalogue gains:
--        is_service          — flips a row between the picker's
--                              Services bucket (top) and Products bucket
--                              (bottom). Replaces the temporary
--                              service_type-based heuristic in PR 1.
--        both_arches_price   — when a product has arch options (e.g.
--                              click-in veneers), this is the price for
--                              the "both arches" selection. The single-
--                              arch price stays on unit_price. NULL when
--                              the product doesn't expose arch options.
--
--   2. lng_catalogue_upgrades — the upgrades catalogue (e.g. Scalloped).
--      Just a name + activity flag; pricing lives on the link table so
--      a single upgrade can cost different amounts on different
--      products (Dylan's "Option 2" — fully flexible).
--
--   3. lng_catalogue_upgrade_links — junction table between products and
--      upgrades, with the per-product upgrade price baked in. price is
--      the single-arch / non-arch price; both_arches_price is set only
--      for products that have arch options.
--
--   4. lng_cart_item_upgrades — receipts must stay frozen, so when a
--      receptionist applies an upgrade to a cart line we snapshot the
--      code, name, and price-in-pence. Future edits to the upgrades
--      catalogue can never alter a printed receipt.
--
-- All four are additive; nothing existing is dropped or renamed. The
-- picker UI (PR 3) will start consuming these once the data is in.
--
-- Rollback at the bottom of the file.

-- ── 1. lwo_catalogue additions ──────────────────────────────────────────────
alter table public.lwo_catalogue
  add column if not exists is_service        boolean not null default false,
  add column if not exists both_arches_price numeric(10,2) null;

comment on column public.lwo_catalogue.is_service is
  'Lounge picker flag. When true, the row sits under the Services heading at the top of the catalogue picker (denture work, impressions). When false, it sits under Products. Defaults to false; admins flip it per row.';

comment on column public.lwo_catalogue.both_arches_price is
  'Price (in pounds) for the "both arches" selection on products that expose arch options. unit_price remains the single-arch (or non-arch) price. NULL when the product is single-priced; set on products that quote different totals for upper, lower, vs full set (e.g. click-in veneers).';

-- ── 2. lng_catalogue_upgrades ───────────────────────────────────────────────
-- Pure registry of upgrade names. Pricing is per-product on the link
-- table, so we deliberately do not carry a default price column here —
-- if Dylan ever wants flat default prices, they can be added without
-- breaking links (the picker would prefer the link price when present).
create table if not exists public.lng_catalogue_upgrades (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,
  name         text not null,
  description  text null,
  sort_order   int not null default 0,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists lng_catalogue_upgrades_active_sort_idx
  on public.lng_catalogue_upgrades (active, sort_order);

create trigger lng_catalogue_upgrades_set_updated_at
  before update on public.lng_catalogue_upgrades
  for each row execute function public.touch_updated_at();

comment on table public.lng_catalogue_upgrades is
  'Lounge upgrades registry (e.g. Scalloped). Pure name + activity flag. Per-product pricing lives on lng_catalogue_upgrade_links so the same upgrade can cost different amounts depending on the product it''s applied to.';

-- ── 3. lng_catalogue_upgrade_links ──────────────────────────────────────────
-- Many-to-many: a product can offer many upgrades; an upgrade can apply
-- to many products. price is required (every link must say what it
-- costs); both_arches_price is only set when the parent product has
-- arch options — admin enforces this in the editor.
create table if not exists public.lng_catalogue_upgrade_links (
  catalogue_id      uuid not null references public.lwo_catalogue(id)         on delete cascade,
  upgrade_id        uuid not null references public.lng_catalogue_upgrades(id) on delete cascade,
  price             numeric(10,2) not null,
  both_arches_price numeric(10,2) null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (catalogue_id, upgrade_id)
);

create index if not exists lng_catalogue_upgrade_links_upgrade_idx
  on public.lng_catalogue_upgrade_links (upgrade_id);

create trigger lng_catalogue_upgrade_links_set_updated_at
  before update on public.lng_catalogue_upgrade_links
  for each row execute function public.touch_updated_at();

comment on table public.lng_catalogue_upgrade_links is
  'Per-product upgrade pricing. price is the single-arch / non-arch upgrade cost; both_arches_price is the upgrade cost when the parent line is purchased as both arches (NULL for single-priced products).';

-- ── 4. lng_cart_item_upgrades ───────────────────────────────────────────────
-- Receipts must stay frozen. When an upgrade is applied to a cart line
-- we snapshot the name + price in pence right next to the line — same
-- rationale as lng_cart_items snapshotting the catalogue row at insert.
-- upgrade_id is nullable + ON DELETE SET NULL so a future admin removing
-- an upgrade row can never invalidate a historical receipt.
create table if not exists public.lng_cart_item_upgrades (
  id            uuid primary key default gen_random_uuid(),
  cart_item_id  uuid not null references public.lng_cart_items(id) on delete cascade,
  upgrade_id    uuid null references public.lng_catalogue_upgrades(id) on delete set null,
  upgrade_code  text not null,
  upgrade_name  text not null,
  price_pence   integer not null,
  created_at    timestamptz not null default now()
);

create index if not exists lng_cart_item_upgrades_cart_item_idx
  on public.lng_cart_item_upgrades (cart_item_id);

comment on table public.lng_cart_item_upgrades is
  'Per-cart-line upgrade snapshots. Frozen at insert: upgrade_code, upgrade_name and price_pence are copied from lng_catalogue_upgrades + lng_catalogue_upgrade_links so receipts never shift if the upgrade is later renamed, repriced, or deleted.';

-- ── Rollback ────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS public.lng_cart_item_upgrades;
-- DROP TABLE IF EXISTS public.lng_catalogue_upgrade_links;
-- DROP TABLE IF EXISTS public.lng_catalogue_upgrades;
-- ALTER TABLE public.lwo_catalogue
--   DROP COLUMN IF EXISTS both_arches_price,
--   DROP COLUMN IF EXISTS is_service;
