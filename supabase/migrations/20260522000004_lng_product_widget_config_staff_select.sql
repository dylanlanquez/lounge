-- ─────────────────────────────────────────────────────────────────────────────
-- Lounge — broaden SELECT on lng_product_widget_config to all staff
--
-- The original RLS gated reads on auth_is_receptionist() (lab_role =
-- 'receptionist'), so a customer-service account (lab_role =
-- 'customer_service' or similar) got nothing back from
-- useAdminProductConfig. The client's configFor() then fell through
-- to DEFAULT_PRODUCT_CONFIG.request_smile_photos = false, which made
-- the Pre-visit smile photos card invisible to CS on both the
-- AppointmentDetail and VisitDetail surfaces.
--
-- Dylan's call: Manager, Customer Service, and every other staff
-- role must be able to see + upload Pre-visit smile photos. The
-- backing tables (lng_booking_intake_photos, storage bucket) already
-- gate reads on auth_is_lng_staff() — this aligns the widget-config
-- policy to the same allow-list so the rendering gate sees the same
-- "is this a staff user" signal as the data layer.
--
-- Admin-side writes are unchanged (lng_product_widget_config_admin_all
-- still requires is_admin()), so CS reading the config can't be used
-- to modify it.
-- ─────────────────────────────────────────────────────────────────────────────

drop policy if exists lng_product_widget_config_receptionist_select
  on public.lng_product_widget_config;

do $$ begin
  create policy lng_product_widget_config_staff_select
    on public.lng_product_widget_config for select
    to authenticated
    using (public.auth_is_lng_staff() or public.auth_is_super_admin());
exception when duplicate_object then null; end $$;
