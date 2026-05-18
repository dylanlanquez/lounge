-- 20260518000005_lng_email_brand_logo_url_dark.sql
--
-- Adds an optional dark-mode logo URL for transactional emails.
-- Currently the email shell renders one logo on a white card. In
-- email clients that force a dark background regardless of our
-- color-scheme directive (Gmail Android, some Outlook web flavours),
-- a black logo on the now-darkened card becomes invisible.
--
-- Industry pattern: declare the email as light-mode (which fixes
-- Apple Mail / Outlook for Mac / Outlook iOS / Outlook macOS), AND
-- ship a light-variant logo URL that clients which DO honour
-- prefers-color-scheme can swap in via <picture>. The dark logo is
-- only used when the email client tells us "user is in dark mode";
-- everything else still gets the black logo on white.
--
-- This migration just stores the setting key. Empty string by
-- default — the admin pastes their light-variant URL in Admin →
-- Branding. When unset, the renderer falls back to a plain <img>
-- using the existing logo URL, behaviour-identical to today.

insert into public.lng_settings (location_id, key, value)
values (null, 'email.brand_logo_url_dark', to_jsonb(''::text))
on conflict do nothing;

-- ── Rollback ──────────────────────────────────────────────────────
-- delete from public.lng_settings
--  where key = 'email.brand_logo_url_dark' and location_id is null;
