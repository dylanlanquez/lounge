-- 20260428000025_lwo_catalogue_image.sql
--
-- Adds an image_url to lwo_catalogue + creates the catalogue-images
-- storage bucket so admins can upload product photos.
--
-- Two ways an image can land here:
--   1. Manual upload via the Lounge admin (this migration unblocks it).
--      Image goes into supabase://catalogue-images/<code>.<ext>; the
--      resulting public URL gets written to lwo_catalogue.image_url.
--   2. Shopify pull (separate edge function, ships next): match
--      lwo_catalogue.code to shopify_variants.sku, copy the variant's
--      remote image URL into image_url. Once written, the URL is
--      "frozen" — Lounge does not re-resolve from Shopify on every
--      render, even if Shopify later removes or renames the asset.
--
-- The bucket is public-read so the picker / admin can <img src=...>
-- without minting signed URLs on every render. Writes are gated by RLS
-- to authenticated users (every Lounge / Checkpoint receptionist).
-- Catalogue images are not patient data, so public exposure is fine.
--
-- Rollback:
--   ALTER TABLE public.lwo_catalogue DROP COLUMN image_url;
--   DELETE FROM storage.buckets WHERE id = 'catalogue-images';

alter table public.lwo_catalogue
  add column if not exists image_url text;

comment on column public.lwo_catalogue.image_url is
  'Frozen image URL. Either a Supabase Storage public URL (admin upload) or a third-party CDN URL pulled from Shopify by SKU match. Never re-resolved at render time.';

-- Storage bucket. on conflict do nothing so a re-run is a no-op.
insert into storage.buckets (id, name, public)
  values ('catalogue-images', 'catalogue-images', true)
  on conflict (id) do nothing;

-- Read: anonymous OK because the bucket is public. We still add an
-- explicit RLS policy for clarity.
drop policy if exists "catalogue_images_read"  on storage.objects;
drop policy if exists "catalogue_images_write" on storage.objects;
drop policy if exists "catalogue_images_delete" on storage.objects;

create policy "catalogue_images_read"
  on storage.objects for select
  using (bucket_id = 'catalogue-images');

create policy "catalogue_images_write"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'catalogue-images');

create policy "catalogue_images_delete"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'catalogue-images');
