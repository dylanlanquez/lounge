-- ─────────────────────────────────────────────────────────────────────────────
-- Lounge — click-in veneers intake photos
--
-- The widget's Success step offers a click-in-veneers patient an
-- optional upload of three photos (front smile / left / right) so
-- the clinical team can pre-assess shade match + arch shape before
-- the visit. Storage lives in a dedicated private bucket; the row
-- table tracks the appointment_id + kind + Storage path so the
-- staff app's Appointment Detail can render thumbnails on demand.
--
-- Anon (the widget) never writes here directly — uploads go via
-- the `widget-upload-intake-photo` edge function which uses the
-- service-role key after validating the appointment. Staff read
-- via the standard authenticated path.
-- ─────────────────────────────────────────────────────────────────────────────

-- Bucket — private. Signed URLs from the staff app on demand.
insert into storage.buckets (id, name, public)
values ('lng-booking-intake-photos', 'lng-booking-intake-photos', false)
on conflict (id) do nothing;

-- Storage RLS — staff read only. The edge function uses service-
-- role which bypasses RLS, so no anon insert/select policy needed.
do $$ begin
  create policy lng_booking_intake_photos_storage_staff_select
    on storage.objects for select
    to authenticated
    using (
      bucket_id = 'lng-booking-intake-photos'
      and (public.auth_is_lng_staff() or public.auth_is_super_admin())
    );
exception when duplicate_object then null; end $$;

-- Index table — one row per (appointment_id, kind). Re-uploading
-- the same kind replaces the prior row (handled in the edge fn).
create table if not exists public.lng_booking_intake_photos (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null
    references public.lng_appointments(id) on delete cascade,
  kind text not null check (kind in ('front', 'left', 'right')),
  file_path text not null,
  mime_type text,
  size_bytes integer,
  uploaded_at timestamptz not null default now(),
  unique (appointment_id, kind)
);

create index if not exists lng_booking_intake_photos_appointment_idx
  on public.lng_booking_intake_photos(appointment_id);

alter table public.lng_booking_intake_photos enable row level security;

-- Staff can read every intake photo row.
create policy lng_booking_intake_photos_staff_select
  on public.lng_booking_intake_photos for select
  to authenticated
  using (public.auth_is_lng_staff() or public.auth_is_super_admin());

-- Staff can delete (admin override / wrong-photo cleanup). Writes
-- from the widget go through the edge function as service-role,
-- which bypasses RLS.
create policy lng_booking_intake_photos_staff_delete
  on public.lng_booking_intake_photos for delete
  to authenticated
  using (public.auth_is_lng_staff() or public.auth_is_super_admin());
