-- ─────────────────────────────────────────────────────────────────────────────
-- Lounge — per-service-type widget settings
--
-- A new tier of widget config, sibling to lng_booking_type_config but
-- keyed at the SERVICE-TYPE level (one row per
-- 'click_in_veneers' / 'denture_repair' / 'same_day_appliance' / etc).
-- Booking-type-level config (price, deposit, label) stays where it
-- is; this table only holds settings that mean the same thing for
-- every booking-type under a given service.
--
-- Initial toggles:
--
--   request_smile_photos  whether the widget's success screen
--                         renders the photo-intake card AND the
--                         staff appointment / visit pages render
--                         the SmilePhotosCard. Default false; a
--                         service explicitly opts in. Previously
--                         hardcoded to click_in_veneers only — this
--                         table is what generalises it.
--
--   show_upgrades         whether the widget renders the Optional
--                         extras step at all for this service. Per-
--                         upgrade visibility still lives on the
--                         catalogue row (lng_catalogue_upgrades
--                         .widget_visible). Default true so existing
--                         behaviour is preserved.
--
-- Notes:
--   • service_type is text PK, no FK target. The set of service
--     types is defined client-side as a TS enum (BookingServiceType)
--     — duplicating it as a DB enum or reference table here would
--     just create a second source of truth that drifts. Rows are
--     allowed for any service_type string; the admin UI only
--     surfaces rows for the enum values it knows.
--   • Rows are OPTIONAL — when a service has no row, the consumers
--     fall back to the defaults above. This means the table doesn't
--     have to grow rows for every service the moment the migration
--     lands; admins create them as they configure.
--
-- New objects:
--
--   public.lng_service_type_widget_config  table, staff-readable +
--                                          admin-writable.
--   public.lng_widget_service_type_config  view, anon-readable.
--                                          The widget consumes this
--                                          on load to know whether
--                                          to show smile-photo
--                                          intake / upgrades step.
--
-- Idempotent — re-running the migration is a no-op.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.lng_service_type_widget_config (
  service_type text primary key,
  request_smile_photos boolean not null default false,
  show_upgrades boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.accounts(id) on delete set null
);

comment on table public.lng_service_type_widget_config is
  'Per-service-type widget toggles. Sibling to lng_booking_type_config but at the service_type level — settings that apply uniformly across every booking-type under one service. Admin-managed via Admin → Widget → Service-type settings.';

-- ─── RLS ─────────────────────────────────────────────────────────────────────
-- Admin can do everything. Receptionists can read so the staff-side
-- appointment pages know whether to render the SmilePhotosCard
-- (which is keyed off request_smile_photos).
alter table public.lng_service_type_widget_config enable row level security;

do $$ begin
  create policy lng_service_type_widget_config_admin_all
    on public.lng_service_type_widget_config for all
    to authenticated
    using (public.is_admin())
    with check (public.is_admin());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy lng_service_type_widget_config_receptionist_select
    on public.lng_service_type_widget_config for select
    to authenticated
    using (public.auth_is_receptionist());
exception when duplicate_object then null; end $$;

-- ─── Anon-readable view ──────────────────────────────────────────────────────
-- The widget loads this anonymously alongside lng_widget_booking_types so it
-- knows, per service, whether to render the upgrades step + show the smile-
-- photos intake on the success screen. SECURITY INVOKER (the default)
-- — the view runs with the caller's permissions, which for anon means RLS
-- on the underlying table would block reads. We therefore grant SELECT on
-- the VIEW directly to anon; the table policies still gate everything else.

create or replace view public.lng_widget_service_type_config as
  select
    service_type,
    request_smile_photos,
    show_upgrades
  from public.lng_service_type_widget_config;

-- Bypass underlying-table RLS for the anon view. Without this, anon SELECT
-- via the view would hit the RLS policies and return zero rows. The view
-- exposes only the two booleans + the key — no PII, no internal state.
alter view public.lng_widget_service_type_config set (security_invoker = off);

grant select on public.lng_widget_service_type_config to anon, authenticated;

comment on view public.lng_widget_service_type_config is
  'Anon-readable projection of lng_service_type_widget_config. Consumed by the customer-facing widget at load time so it knows which steps to render per service. Maintained by Admin → Widget.';

-- ─── Seed click_in_veneers so existing behaviour is preserved ────────────────
-- The widget's success screen used to hardcode
-- `serviceType === 'click_in_veneers'` for the smile-photos intake.
-- We're about to delete that hardcode and read this flag instead, so
-- the row needs to exist with request_smile_photos = true on day one
-- — otherwise veneers patients would stop being asked for photos the
-- moment the migration lands and the code switches over.
insert into public.lng_service_type_widget_config (service_type, request_smile_photos, show_upgrades)
values ('click_in_veneers', true, true)
on conflict (service_type) do update
  set request_smile_photos = excluded.request_smile_photos
  where public.lng_service_type_widget_config.request_smile_photos is distinct from excluded.request_smile_photos;
