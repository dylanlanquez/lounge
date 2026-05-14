-- ─────────────────────────────────────────────────────────────────────────────
-- Lounge — Stripe live/test mode toggle
--
-- A single flag in lng_settings that picks which set of Stripe
-- credentials the widget + edge functions use. API keys themselves
-- stay in env vars / Supabase function secrets (the proper place
-- for secrets); only the mode lives in the DB so an admin can flip
-- between live + test from the Lounge admin UI without redeploying.
--
-- Resolution:
--   widget bundle reads `stripe.mode` from useClinicSettings()
--     mode='live' → env.STRIPE_PUBLISHABLE_KEY_LIVE (fallback STRIPE_PUBLISHABLE_KEY)
--     mode='test' → env.STRIPE_PUBLISHABLE_KEY_TEST
--   widget-create-payment-intent + widget-stripe-webhook read the
--   row via the service-role client and pick the matching secrets.
--
-- Anon RLS gains read access to `stripe.mode` (the value is a
-- harmless 'live' / 'test' string, no secrets exposed).
-- ─────────────────────────────────────────────────────────────────────────────

-- Seed the default mode = 'live' so existing deployments keep
-- behaving exactly as they did before this migration landed.
insert into public.lng_settings (key, value)
values ('stripe.mode', '"live"'::jsonb)
on conflict (key) where location_id is null do nothing;

-- Drop + re-create the widget-anon select policy to include
-- stripe.mode alongside the existing clinic.opening_hours row.
drop policy if exists lng_settings_widget_anon_opening_hours
  on public.lng_settings;

create policy lng_settings_widget_anon_select
  on public.lng_settings for select
  to anon
  using (
    location_id is null
    and key in ('clinic.opening_hours', 'stripe.mode')
  );
