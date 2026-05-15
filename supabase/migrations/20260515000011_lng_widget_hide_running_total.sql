-- 20260515000011_lng_widget_hide_running_total.sql
--
-- Per-booking-type switch for the widget's running-total footer
-- pill. Twin shape of widget_allow_pay_in_full + widget_allow_pay_on_the_day
-- so the admin tab can flip them together.
--
-- The footer shows a running "Total · £X" line on every step before
-- Details so the patient sees the price building up as they pick
-- arches / repairs / upgrades. For some services Dylan wants this
-- hidden — the price is for the in-clinic team to discuss, not for
-- the patient to see partway through their flow.
--
-- Default TRUE (hide) per Dylan's preference: he wants every existing
-- booking type to start hidden, then opt specific ones back in by
-- flipping the toggle off. New rows inherit the same default.
--
-- The Review-step BookingReview card still shows the full breakdown
-- regardless — this flag only controls the small footer pill on the
-- earlier steps. The customer always sees prices at the
-- commit moment; they just don't see a running total along the way.
--
-- Apply order per CLAUDE.md: shadow first, then production.
-- Rollback: drop the column + recreate the view without it.

alter table public.lng_booking_type_config
  add column if not exists widget_hide_running_total boolean not null default true;

comment on column public.lng_booking_type_config.widget_hide_running_total is
  'When TRUE the booking widget hides the running-total pill from the sticky footer on every step before Review. Default TRUE — Dylan prefers the price stays out of sight until the customer reaches the summary screen, so the patient does not anchor on a partial total while they are still picking arches / repairs / upgrades.';

-- Regenerate the widget read view so the new column flows through to
-- the anon-readable surface. Drop + recreate (Postgres can't reorder
-- a view's columns via CREATE OR REPLACE — adding a column in the
-- middle of the existing list trips ERROR 42P16).
drop view if exists public.lng_widget_booking_types;
create view public.lng_widget_booking_types as
  SELECT
    id,
    COALESCE(NULLIF(TRIM(BOTH FROM display_label), ''::text), initcap(replace(service_type, '_'::text, ' '::text))) AS label,
    COALESCE(widget_description, ''::text) AS description,
    widget_deposit_pence AS deposit_pence,
    widget_allow_staff_pick AS allow_staff_pick,
    widget_allow_pay_in_full AS allow_pay_in_full,
    widget_allow_pay_on_the_day AS allow_pay_on_the_day,
    widget_hide_running_total AS hide_running_total,
    COALESCE(duration_default, duration_min, 30) AS duration_minutes,
    service_type
  FROM lng_booking_type_config
  WHERE widget_visible = true
    AND repair_variant IS NULL
    AND product_key IS NULL
    AND arch IS NULL;

comment on view public.lng_widget_booking_types is
  'Public, anon-readable view of widget-visible booking types. Drives the booking widget service picker, payment CTA combination, and footer running-total visibility. Recomputed on read.';
