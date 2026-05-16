-- ─────────────────────────────────────────────────────────────────────────────
-- Lounge — per-PRODUCT widget settings (replacing per-service-type)
--
-- Migration 20260516000001 set up lng_service_type_widget_config keyed
-- at the service_type level (one row per click_in_veneers /
-- denture_repair / etc). Dylan flagged that the actual granularity
-- needed is the PRODUCT level: same-day-appliance has retainer /
-- night guard / day guard / aligner / etc. as products, and each
-- product wants its own smile-photos + optional-extras toggles.
--
-- This migration:
--   1. Creates lng_product_widget_config keyed on (service_type,
--      product_key) — the natural product grain in lwo_catalogue.
--   2. Drops lng_service_type_widget_config + its public view. The
--      old table was in production for ~30 minutes with one seed
--      row; no data worth migrating.
--
-- Toggles (same as before, at finer grain):
--
--   request_smile_photos  per-product: the widget's success-screen
--                         photo-intake AND the staff appointment /
--                         visit Smile photos card render when true.
--                         Default false; opt in explicitly.
--   show_upgrades         per-product: whether the widget renders
--                         the Optional extras step. Default true so
--                         existing behaviour holds for any product
--                         that doesn't have a row yet.
--
-- Services without a product axis (denture_repair, impression_
-- appointment, virtual_impression_appointment, other) carry no rows
-- here. The admin UI hides them; the widget falls through configFor's
-- defaulted lookup. If we ever need them later, the table accepts
-- a row with the relevant product_key (or a service-only key) without
-- a schema change.
--
-- Idempotent — re-running the migration is a no-op.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── Drop the (briefly live) service-type table ──────────────────────────────
-- Order matters: view first, then the table it references. drop ...
-- if exists keeps re-runs safe on environments that may have been
-- through 20260516000001 already or skipped it entirely.
drop view if exists public.lng_widget_service_type_config;
drop table if exists public.lng_service_type_widget_config;

-- ─── New product-level table ─────────────────────────────────────────────────
create table if not exists public.lng_product_widget_config (
  service_type text not null,
  product_key text not null,
  request_smile_photos boolean not null default false,
  show_upgrades boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.accounts(id) on delete set null,
  primary key (service_type, product_key)
);

comment on table public.lng_product_widget_config is
  'Per-product widget toggles. Keyed on (service_type, product_key) to match the catalogue grain (same-day-appliance has retainer / night_guard / etc. as products). Maintained via Admin → Widget → Service-type settings. Rows are optional — missing combinations fall back to defaults (request_smile_photos=false, show_upgrades=true).';

-- ─── RLS ─────────────────────────────────────────────────────────────────────
alter table public.lng_product_widget_config enable row level security;

do $$ begin
  create policy lng_product_widget_config_admin_all
    on public.lng_product_widget_config for all
    to authenticated
    using (public.is_admin())
    with check (public.is_admin());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy lng_product_widget_config_receptionist_select
    on public.lng_product_widget_config for select
    to authenticated
    using (public.auth_is_receptionist());
exception when duplicate_object then null; end $$;

-- ─── Anon-readable view for the customer widget ──────────────────────────────
-- security_invoker off so anon can read the projection without hitting
-- the underlying-table RLS (which gates writes + staff reads but not
-- this thin two-column projection). The view exposes only the
-- non-PII config booleans + their composite key.
create or replace view public.lng_widget_product_config as
  select
    service_type,
    product_key,
    request_smile_photos,
    show_upgrades
  from public.lng_product_widget_config;

alter view public.lng_widget_product_config set (security_invoker = off);

grant select on public.lng_widget_product_config to anon, authenticated;

comment on view public.lng_widget_product_config is
  'Anon-readable projection of lng_product_widget_config. Customer-facing widget reads this on load so it knows which steps to render per (service_type, product_key). Maintained via Admin → Widget.';

-- ─── Seed click_in_veneers / click_in_veneers ────────────────────────────────
-- Same rationale as the previous migration: the widget used to
-- hardcode `serviceType === 'click_in_veneers'` for the smile-photos
-- intake. The code will switch to a (service_type, product_key)
-- lookup, so the (click_in_veneers, click_in_veneers) pair needs to
-- exist with request_smile_photos = true on day one.
insert into public.lng_product_widget_config (service_type, product_key, request_smile_photos, show_upgrades)
values ('click_in_veneers', 'click_in_veneers', true, true)
on conflict (service_type, product_key) do update
  set request_smile_photos = excluded.request_smile_photos
  where public.lng_product_widget_config.request_smile_photos is distinct from excluded.request_smile_photos;
