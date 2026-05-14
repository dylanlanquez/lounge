-- Add postcode to the shared `locations` table + seed the Venneir
-- clinic with its UK postcode (ML1 5UH).
--
-- Reception staff have been asking for the postcode to appear on
-- the AppointmentDetail Location row alongside the street address
-- and city, so the full deliverable address sits in one place
-- without them having to look it up. The Branding admin tab now
-- carries a Postcode input that writes back here too — locations is
-- the single source of truth for clinic address fields shared with
-- Meridian.
--
-- Idempotent: `add column if not exists`, and the seed update only
-- fires on rows where postcode is currently null/empty so re-runs
-- can't clobber a manual edit.

alter table public.locations
  add column if not exists postcode text;

update public.locations
   set postcode = 'ML1 5UH'
 where is_venneir = true
   and type = 'lab'
   and (postcode is null or postcode = '');
