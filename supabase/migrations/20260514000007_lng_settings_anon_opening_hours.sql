-- Allow the anon-key booking widget to read clinic opening hours
-- so the calendar can dim + disable days the clinic is closed.
--
-- Without this policy the widget's useClinicSettings() call returns
-- zero rows (lng_settings was authenticated-only), and the
-- TypeScript hook silently falls back to its DEFAULT_OPENING which
-- has Saturday open 10:00-16:00. Result: customers could click
-- Saturday on the widget calendar even when the admin had marked
-- it closed in Settings → Opening times.
--
-- Scope is intentionally narrow: ONLY the global (location_id IS
-- NULL) clinic.opening_hours row is exposed to anon. Email
-- templates, legal info, virtual host emails, and per-location
-- overrides remain staff-only.

create policy lng_settings_widget_anon_opening_hours
  on public.lng_settings for select
  to anon
  using (
    location_id is null
    and key = 'clinic.opening_hours'
  );
