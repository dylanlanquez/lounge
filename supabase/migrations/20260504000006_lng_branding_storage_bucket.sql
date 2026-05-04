-- ─────────────────────────────────────────────────────────────────────────────
-- Lounge — branding storage bucket
--
-- Public bucket for the logo (and any future brand assets) the admin
-- uploads via the Branding & clinic page. Email clients can fetch
-- public.supabase.co/storage/v1/object/public/branding/<file>
-- without auth, which is what transactional emails need.
--
-- RLS mirrors `catalogue-images`: any authenticated user can upload,
-- read, and delete. The Branding tab is gated behind the admin
-- check at the route level, so this is fine in practice.
--
-- Idempotent: re-running this migration is a no-op.
-- ─────────────────────────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public)
values ('branding', 'branding', true)
on conflict (id) do nothing;

-- Read — public so unauthenticated email clients can fetch the logo.
do $$ begin
  create policy branding_read
    on storage.objects for select
    using (bucket_id = 'branding');
exception when duplicate_object then null; end $$;

-- Insert — authenticated users only (admin gate is enforced in the UI).
do $$ begin
  create policy branding_write
    on storage.objects for insert
    to authenticated
    with check (bucket_id = 'branding');
exception when duplicate_object then null; end $$;

-- Delete — authenticated, so the admin can clear an old logo.
do $$ begin
  create policy branding_delete
    on storage.objects for delete
    to authenticated
    using (bucket_id = 'branding');
exception when duplicate_object then null; end $$;
