-- 20260506000019_lng_calendly_type_map.sql
--
-- Admin-configurable mapping from a Calendly event-type label to a
-- specific lwo_catalogue row. Used during the arrival flow to
-- pre-populate the items basket when axis pins are absent (legacy
-- Calendly bookings whose intake Q&A can't be reliably parsed).
--
-- One mapping per label (case-insensitive, trimmed).
-- Arch is not stored here — it is read from the patient's intake Q&A
-- at arrival time and used only for pricing (options.arch), not for
-- row selection.
--
-- Rollback:
--   drop table public.lng_calendly_type_map;

create table if not exists public.lng_calendly_type_map (
  id           uuid primary key default gen_random_uuid(),
  label        text not null,
  catalogue_id uuid not null references public.lwo_catalogue(id) on delete cascade,
  created_at   timestamptz not null default now()
);

-- One mapping per event-type label (normalised).
create unique index if not exists lng_calendly_type_map_label_idx
  on public.lng_calendly_type_map (lower(trim(label)));

comment on table public.lng_calendly_type_map is
  'Admin-defined mapping from a Calendly event-type label to a lwo_catalogue row. Used to pre-populate the arrival basket when axis pins are absent.';

-- RLS: staff can read; only admins (role = ''admin'') can write.
alter table public.lng_calendly_type_map enable row level security;

create policy "staff can read calendly type map"
  on public.lng_calendly_type_map for select
  using (auth.role() = 'authenticated');

create policy "admins can manage calendly type map"
  on public.lng_calendly_type_map for all
  using (public.is_admin())
  with check (public.is_admin());
