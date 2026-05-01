-- 20260501000001_lng_postcode_geocodes.sql
--
-- Cache table for outward-postcode → lat/lng lookups, fed by the
-- geocode-postcode edge function. Two design choices:
--
--   1. Outward codes only ("SW1A", "M1", "EH3"). Privacy-safer than
--      caching full postcodes (no individual address ever lands
--      here) and the typical cardinality is in the low thousands
--      per country, so cache hit rate is very high after the first
--      few report opens.
--
--   2. The geocoding source is parameterised so a future swap to a
--      different provider (e.g. ONS UK postcode API for free
--      geocodes) can populate this table alongside the Google
--      results without a schema change.
--
-- RLS: read-open to authenticated (the Reports map needs it).
-- Writes go through the geocode-postcode edge function with the
-- service role key, never directly from the client — so we don't
-- expose an INSERT policy here.

create table if not exists public.lng_postcode_geocodes (
  outward      text primary key
                 check (length(outward) >= 2 and length(outward) <= 4
                        and outward = upper(outward)),
  lat          numeric(9, 6) not null check (lat between -90 and 90),
  lng          numeric(9, 6) not null check (lng between -180 and 180),
  geocoded_at  timestamptz not null default now(),
  source       text not null default 'google_geocoding'
);

create index if not exists lng_postcode_geocodes_geocoded_idx
  on public.lng_postcode_geocodes (geocoded_at desc);

alter table public.lng_postcode_geocodes enable row level security;

create policy lng_postcode_geocodes_read on public.lng_postcode_geocodes
  for select to authenticated using (true);

comment on table public.lng_postcode_geocodes is
  'Outward-postcode → lat/lng cache used by the Reports visitor heatmap. Insert-only via the geocode-postcode edge function (service role); never written directly from the client.';

-- ── Rollback ───────────────────────────────────────────────────────────────
-- drop table if exists public.lng_postcode_geocodes;
