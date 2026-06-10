-- 20260610000006_lng_catalogue_shopify_link.sql
--
-- "Import from Shopify" on the Products admin tab. When a product is
-- imported from the Venneir Shopify catalogue we stamp the Shopify
-- product / variant id on the lwo_catalogue row so a re-import updates
-- the existing row (and shows as already-imported) instead of creating
-- a duplicate. Nullable — manual products and existing rows leave them
-- null.
--
-- Additive; safe to apply any time. Apply: shadow first, then Meridian.

alter table public.lwo_catalogue
  add column if not exists shopify_product_id text,
  add column if not exists shopify_variant_id text;

comment on column public.lwo_catalogue.shopify_product_id is
  'Shopify product id (numeric, as text) when this row was imported from the Shopify catalogue. De-dupe key for re-imports; null for manually-created products.';
comment on column public.lwo_catalogue.shopify_variant_id is
  'Shopify variant id (numeric, as text) the price / SKU was taken from at import. One Lounge product per Shopify product (the default variant).';

create index if not exists lwo_catalogue_shopify_product_idx
  on public.lwo_catalogue (shopify_product_id)
  where shopify_product_id is not null;

NOTIFY pgrst, 'reload schema';
