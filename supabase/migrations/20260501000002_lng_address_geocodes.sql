-- 20260501000002_lng_address_geocodes.sql
--
-- Address-level geocode cache. Unlike lng_postcode_geocodes (outward
-- only, low cardinality, operationally public), this table stores
-- precise residential addresses (line1 + postcode) and is therefore
-- personal data under UK GDPR / DPA 2018.
--
-- Why this table exists:
--
--   The Reports → Demographics visitor map has two modes. Non-admins
--   see the existing outward-postcode heatmap (lng_postcode_geocodes,
--   low resolution, no PII). Lounge admins / super admin see a pin
--   per unique patient address with the LAP refs and cart items they
--   booked, which is materially more useful for catchment analysis
--   but only proportionate to share with clinical leadership.
--
-- Privacy posture:
--
--   • RLS gates SELECT to public.auth_is_lng_admin() OR
--     public.auth_is_super_admin(). No INSERT/UPDATE policy — writes
--     go through the geocode-address edge function with the service
--     role key, which performs its own admin check before any cache
--     write so non-admins cannot pollute the cache by calling the
--     function directly.
--
--   • Stored shape is the *normalised* address (line1 lowercased and
--     space-collapsed; postcode uppercased and space-stripped). The
--     normalised form is the cache key — two callers that submit
--     "10  Acacia Avenue " and "10 acacia avenue" share one row.
--
-- See docs/02-data-protection.md for the DPIA entry covering this
-- processing.

create table if not exists public.lng_address_geocodes (
  id            uuid primary key default gen_random_uuid(),
  -- Cache key — the *normalised* address. Both callers and the
  -- edge function must normalise identically (see normalisation
  -- contract in the function header).
  line1_norm    text not null check (length(line1_norm) > 0),
  postcode_norm text not null check (postcode_norm = upper(postcode_norm)
                                     and postcode_norm !~ '[[:space:]]'),
  -- Resolved coordinates from the geocoder. Numeric(9,6) gives
  -- ~10 cm precision globally — overkill for a heatmap but the
  -- column type matches lng_postcode_geocodes for consistency.
  lat           numeric(9, 6) not null check (lat between -90 and 90),
  lng           numeric(9, 6) not null check (lng between -180 and 180),
  geocoded_at   timestamptz not null default now(),
  source        text not null default 'google_geocoding',
  unique (line1_norm, postcode_norm)
);

-- Postcode-led queries are common (the edge function looks up
-- candidates by postcode_norm before composite matching), so a
-- single-column index on postcode_norm is the operative one.
create index if not exists lng_address_geocodes_postcode_norm_idx
  on public.lng_address_geocodes (postcode_norm);

-- Geocoded-at descending so an admin maintenance task can sample
-- the most recent additions to the cache without a sort.
create index if not exists lng_address_geocodes_geocoded_at_idx
  on public.lng_address_geocodes (geocoded_at desc);

alter table public.lng_address_geocodes enable row level security;

-- SELECT: Lounge admin or super admin only. Never extend this to
-- regular staff without re-running the DPIA — precise addresses
-- being readable to the front desk would be a different processing
-- context with different lawful-basis analysis.
create policy lng_address_geocodes_admin_read
  on public.lng_address_geocodes
  for select to authenticated
  using (public.auth_is_lng_admin() or public.auth_is_super_admin());

comment on table public.lng_address_geocodes is
  'Address-level (line1 + postcode) → lat/lng cache for the admin-only heatmap in Reports → Demographics. Personal data: read-restricted to Lounge admins / super admin via RLS. Writes go through the geocode-address edge function with the service role key. See docs/02-data-protection.md for the DPIA entry.';

comment on column public.lng_address_geocodes.line1_norm is
  'Normalised first line of the address: trimmed, internal whitespace collapsed to single spaces, lowercased. The cache key.';

comment on column public.lng_address_geocodes.postcode_norm is
  'Normalised postcode: trimmed, all whitespace removed, uppercased. The cache key.';

-- ── Rollback ───────────────────────────────────────────────────────────────
-- drop policy if exists lng_address_geocodes_admin_read on public.lng_address_geocodes;
-- drop index if exists public.lng_address_geocodes_geocoded_at_idx;
-- drop index if exists public.lng_address_geocodes_postcode_norm_idx;
-- drop table if exists public.lng_address_geocodes;
