-- ─────────────────────────────────────────────────────────────────────────────
-- Lounge — branding & clinic settings (seed lng_settings keys)
--
-- Seeds the lng_settings keys that drive transactional email branding
-- (logo, accent colour, sender name) and the clinic-level contact
-- info that admins want to edit from one place: public email,
-- website, booking link, map URL, opening hours, and legal info.
--
-- Why lng_settings, not new columns on `locations`:
--
-- The locations table is shared with Meridian (it lives in the same
-- Supabase project, schema owned by Meridian's migrations). Adding
-- columns there would couple Lounge to Meridian's schema and risk
-- Meridian's RLS / migrations stepping on Lounge's data. lng_settings
-- already supports per-location scoping via location_id; storing the
-- new fields here keeps the boundary clean: name/address/city/phone
-- (already on locations) stay where Meridian owns them and Lounge
-- writes via the existing shared row, while everything new lives
-- under Lounge's roof.
--
-- All keys are seeded with location_id = NULL (global default). When
-- an admin overrides a key for their location, a per-location row is
-- inserted with location_id set, and the read path falls back from
-- per-location → global automatically.
--
-- Idempotent: ON CONFLICT DO NOTHING means re-running the migration
-- is a no-op if the keys already exist (preserves admin edits made
-- after first apply).
-- ─────────────────────────────────────────────────────────────────────────────

insert into public.lng_settings (location_id, key, value, description)
values
  -- ── Branding ──────────────────────────────────────────────────────────────
  (
    null,
    'email.brand_logo_url',
    to_jsonb('https://lounge.venneir.com/lounge-logo.png'::text),
    'Public URL of the logo shown at the top of every transactional email. Must be absolute and publicly fetchable from the recipient''s mail client.'
  ),
  (
    null,
    'email.brand_logo_show',
    to_jsonb(true),
    'Whether to render the logo header in transactional emails. Toggle off if you want a plain-text feel.'
  ),
  (
    null,
    'email.brand_logo_max_width',
    to_jsonb(120),
    'Max-width of the logo in pixels. 100–180 looks balanced inside the 600px-wide email card.'
  ),
  (
    null,
    'email.brand_accent_color',
    to_jsonb('#0E1414'::text),
    'Brand accent colour. Used as the default button background, link colour, and divider tint when copy doesn''t override them. Hex including the leading #.'
  ),

  -- ── Email sender ──────────────────────────────────────────────────────────
  (
    null,
    'email.from_name',
    to_jsonb('Venneir Lounge'::text),
    '"From" name shown in the recipient''s inbox, paired with the verified Resend sending address.'
  ),
  (
    null,
    'email.reply_to',
    to_jsonb(''::text),
    'Reply-to address. Where patient replies to a transactional email land. Leave empty to fall back to the From address.'
  ),

  -- ── Clinic contact (location-level, parked here to avoid coupling to Meridian's locations schema)
  (
    null,
    'clinic.public_email',
    to_jsonb(''::text),
    'Public-facing clinic email address shown to patients. Used as {{publicEmail}} in templates and in email footers.'
  ),
  (
    null,
    'clinic.website_url',
    to_jsonb(''::text),
    'Clinic website URL. Used as {{websiteUrl}} in templates.'
  ),
  (
    null,
    'clinic.booking_url',
    to_jsonb(''::text),
    'Public booking page URL. Used as {{bookingLink}} for "book your next appointment" CTAs.'
  ),
  (
    null,
    'clinic.map_url',
    to_jsonb(''::text),
    'Google Maps URL for the clinic. Used in confirmation emails next to the address ("see on map").'
  ),

  -- ── Opening times ─────────────────────────────────────────────────────────
  -- 7-element array. Index 0 = Monday, 6 = Sunday. Each element is
  -- either { "closed": true } or { "open": "HH:mm", "close": "HH:mm" }.
  -- Defaults match a typical clinic week (closed Sunday, half-day Saturday).
  (
    null,
    'clinic.opening_hours',
    $JSON$[
      {"open":"09:00","close":"18:00"},
      {"open":"09:00","close":"18:00"},
      {"open":"09:00","close":"18:00"},
      {"open":"09:00","close":"18:00"},
      {"open":"09:00","close":"18:00"},
      {"open":"10:00","close":"16:00"},
      {"closed":true}
    ]$JSON$::jsonb,
    'Weekly clinic opening times. 7-element array, Mon=0 .. Sun=6. Each element either {"closed":true} or {"open":"HH:mm","close":"HH:mm"}.'
  ),

  -- ── Legal ─────────────────────────────────────────────────────────────────
  (
    null,
    'legal.company_number',
    to_jsonb(''::text),
    'UK Companies House registration number. UK statute requires this on customer-facing comms for limited companies.'
  ),
  (
    null,
    'legal.vat_number',
    to_jsonb(''::text),
    'VAT registration number. Leave empty if not VAT-registered.'
  ),
  (
    null,
    'legal.registered_address',
    to_jsonb(''::text),
    'Registered business address from Companies House. Often differs from the clinic address; legally must be the registered one. Empty to omit.'
  )
on conflict (key) where location_id is null do nothing;
