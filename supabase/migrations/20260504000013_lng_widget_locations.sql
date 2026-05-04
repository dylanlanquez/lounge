-- ─────────────────────────────────────────────────────────────────────────────
-- Lounge — widget-visible locations
--
-- Phase 2c widget hardcodes a single "Glasgow Lounge" entry in
-- src/widget/data.ts (WIDGET_LOCATIONS) and the edge functions
-- resolve a stub id ("loc-1") to the default Venneir lab. Phase 6
-- moves the widget to live data so multi-location embeds can
-- show a real list.
--
-- This view exposes only the columns the widget needs (id, name,
-- composed address line, city, phone) and only the rows the
-- widget should advertise — Venneir-owned labs, non-archived. Same
-- filter the calendly-webhook function uses to pick its default
-- location, so widget submissions and Calendly imports route to
-- the same set.
--
-- Anon-readable: the patient is unauth'd. The view exposes no PII
-- and no operational fields (finance, opening hours JSON, etc).
--
-- Rollback:
--   drop view public.lng_widget_locations;
-- ─────────────────────────────────────────────────────────────────────────────

drop view if exists public.lng_widget_locations;

create view public.lng_widget_locations
with (security_invoker = true)
as
select
  l.id,
  l.name,
  l.city,
  -- Composed line: "138 Main Street, Glasgow" — joins the two
  -- non-null pieces with a comma, drops the comma when one side
  -- is missing. Keeps this view minimal so the client can format
  -- exactly as it wants in the picker UI.
  trim(both ', ' from concat_ws(', ', nullif(l.address, ''), nullif(l.city, ''))) as address_line,
  l.phone
from public.locations l
where l.type       = 'lab'
  and l.is_venneir = true
order by l.name asc;

comment on view public.lng_widget_locations is
  'Customer-facing booking widget — list of Venneir labs the widget can advertise. Anon-readable. Filtered to (type=lab AND is_venneir=true) so the widget renders the same set the calendly-webhook resolver uses for its default location.';

grant select on public.lng_widget_locations to anon, authenticated;
