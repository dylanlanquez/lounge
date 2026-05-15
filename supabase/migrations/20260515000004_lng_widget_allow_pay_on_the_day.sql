-- 20260515000004_lng_widget_allow_pay_on_the_day.sql
--
-- Per-booking-type switch for the widget's "Pay on the day" CTA.
--
-- Background. The widget historically offered two payment paths:
--   • a partial deposit captured up-front (Calendly-style)
--   • or pay-in-full on the day at the till
-- A recent rework swapped both into a single "Pay £full now / Pay on
-- the day" pair across every service. That regressed click-in veneers
-- and same-day-appliance bookings, where the practice has always
-- required a £25 deposit at booking. This migration restores the
-- per-booking-type toggle so admin can choose which CTA pair the
-- widget shows for each service:
--
--   widget_allow_pay_on_the_day = TRUE   → "Pay on the day" CTA visible
--   widget_deposit_pence > 0             → "Pay deposit £X" CTA visible
--   "Pay in full"                        → always visible (the third CTA)
--
-- Three combinations the widget renders cleanly:
--   • deposit only         (click-in, same-day):    Deposit + Full
--   • on-the-day only      (denture-repair):        Full + On the day
--   • both flags set                                Deposit + Full + On the day
--
-- Default FALSE matches the legacy deposit-only semantics — a
-- click-in / same-day booking shouldn't suddenly grow an "on the day"
-- option the practice didn't sign off on. Denture-repair is seeded
-- TRUE so today's "Pay on the day" UX continues working.
--
-- The lng_widget_booking_types view is regenerated to expose the new
-- column as `allow_pay_on_the_day` so the widget's anon read picks it
-- up without any server-side change.
--
-- Apply order per CLAUDE.md: shadow first, then production.
-- Rollback: drop the column + recreate the view without it.

alter table public.lng_booking_type_config
  add column if not exists widget_allow_pay_on_the_day boolean not null default false;

comment on column public.lng_booking_type_config.widget_allow_pay_on_the_day is
  'When TRUE the booking widget surfaces a "Pay on the day" CTA alongside the standard "Pay in full" / deposit options. Set per booking-type via the Lounge admin Widget tab.';

-- Seed: denture-repair is the only service that historically had this
-- on; everything else stays at the default (FALSE) and continues to
-- show the deposit + full pair.
update public.lng_booking_type_config
set widget_allow_pay_on_the_day = true
where service_type = 'denture_repair';

-- Regenerate the widget read view so the new column flows through to
-- the anon-readable surface. Postgres can't reorder a view's columns
-- via CREATE OR REPLACE — adding a column in the middle of the
-- existing list trips ERROR 42P16, so we DROP first. Anon callers
-- are read-only and re-fetch on every widget mount; nothing depends
-- on the view between drop + recreate.
drop view if exists public.lng_widget_booking_types;
create view public.lng_widget_booking_types as
  SELECT
    id,
    COALESCE(NULLIF(TRIM(BOTH FROM display_label), ''::text), initcap(replace(service_type, '_'::text, ' '::text))) AS label,
    COALESCE(widget_description, ''::text) AS description,
    widget_deposit_pence AS deposit_pence,
    widget_allow_staff_pick AS allow_staff_pick,
    widget_allow_pay_on_the_day AS allow_pay_on_the_day,
    COALESCE(duration_default, duration_min, 30) AS duration_minutes,
    service_type
  FROM lng_booking_type_config
  WHERE widget_visible = true
    AND repair_variant IS NULL
    AND product_key IS NULL
    AND arch IS NULL;

comment on view public.lng_widget_booking_types is
  'Public, anon-readable view of widget-visible booking types. Drives the booking widget service picker + payment CTA combination. Recomputed on read.';
