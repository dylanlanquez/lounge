-- 20260514000003_lwo_catalogue_anon_read.sql
--
-- Let the customer-facing widget read active catalogue rows.
--
-- Why this is missing: the existing `lwo_catalogue_read` RLS policy
-- is scoped to {authenticated}. Anon callers (the embedded widget
-- on venneir.com / denture-services.co.uk) get zero rows back from
-- the catalogue resolver in widgets/shared/data.ts ->
-- useResolvedCatalogueRow. Symptom: the widget's footer "On the
-- day" price preview hides because serviceLinePence stays at 0,
-- and the dedicated SummaryStep price card showed no service line.
--
-- The fix is to expose ACTIVE rows to anon. Inactive rows stay
-- hidden — the till team uses `active=false` to retire products,
-- and those shouldn't leak prices to the public.
--
-- We drop the old read policy and re-create it with anon +
-- authenticated, both filtered to active rows. SELECT only — INSERT
-- / UPDATE / DELETE remain authenticated-only via the separate
-- lwo_catalogue_write policy.

drop policy if exists lwo_catalogue_read on public.lwo_catalogue;

create policy lwo_catalogue_read
  on public.lwo_catalogue
  for select
  to anon, authenticated
  using (active = true);

comment on policy lwo_catalogue_read on public.lwo_catalogue is
  'Public read of active catalogue rows for the booking widget. Inactive rows stay hidden from anon and authenticated alike.';
