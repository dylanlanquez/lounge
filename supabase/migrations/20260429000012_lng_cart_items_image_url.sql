-- 20260429000012: snapshot lwo_catalogue.image_url onto lng_cart_items.
--
-- Continues the cart-snapshot pattern (name, unit_price_pence,
-- service_type, product_key, repair_variant, arch, shade, notes,
-- quantity_enabled): the image is part of the product's identity at
-- the moment it was added to the bag, so freezing it on the cart row
-- means the visit cart UI can render its line thumbnails without a
-- live join — and a future admin replacing the image won't
-- retroactively rewrite an in-flight or invoiced cart.
--
-- Defaults null. Backfill from the catalogue join. Ad-hoc rows
-- (catalogue_id null) stay at the default.

alter table public.lng_cart_items
  add column if not exists image_url text;

update public.lng_cart_items ci
   set image_url = c.image_url
  from public.lwo_catalogue c
 where ci.catalogue_id = c.id
   and ci.image_url is null;

comment on column public.lng_cart_items.image_url is
  'Snapshot of lwo_catalogue.image_url at insert time. Visit cart UI renders this as the line thumbnail. Frozen so admin image swaps do not retroactively affect existing cart rows.';
