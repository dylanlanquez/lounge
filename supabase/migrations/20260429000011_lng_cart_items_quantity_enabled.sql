-- 20260429000011: snapshot quantity_enabled onto lng_cart_items.
--
-- The cart write already snapshots every catalogue-derived field at
-- insert time (name, unit_price_pence, service_type, product_key,
-- repair_variant, arch, shade, …) so a later admin edit cannot
-- retroactively rewrite a staged or invoiced cart. quantity_enabled
-- belongs in the same snapshot — the visit cart UI reads it to decide
-- whether to render the qty stepper, and we want that decision frozen
-- at insert time, not re-evaluated against the live catalogue every
-- render.
--
-- Defaults true so the existing cart rows keep their stepper. Backfill
-- pulls the live catalogue value through the catalogue_id join; ad-hoc
-- rows (catalogue_id null) stay at the column default.

alter table public.lng_cart_items
  add column if not exists quantity_enabled boolean not null default true;

update public.lng_cart_items ci
   set quantity_enabled = c.quantity_enabled
  from public.lwo_catalogue c
 where ci.catalogue_id = c.id;

comment on column public.lng_cart_items.quantity_enabled is
  'Snapshot of lwo_catalogue.quantity_enabled at insert time. Visit cart UI hides the qty stepper when false. Frozen so admin flag changes do not retroactively affect existing cart rows.';
