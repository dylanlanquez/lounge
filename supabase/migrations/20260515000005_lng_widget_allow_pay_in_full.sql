-- 20260515000005_lng_widget_allow_pay_in_full.sql
--
-- Per-booking-type switch for the widget's "Pay in full" CTA.
-- Twin of widget_allow_pay_on_the_day (20260515000004); together they
-- give the admin full control of which payment CTAs surface per
-- booking type:
--
--   widget_deposit_pence > 0           → "Pay deposit £X" CTA
--   widget_allow_pay_in_full = TRUE    → "Pay in full"     CTA
--   widget_allow_pay_on_the_day = TRUE → "Pay on the day"  CTA
--
-- Defaults to TRUE because "Pay in full" was the historical universal
-- option; turning it OFF lets a clinic restrict a service to deposit-
-- only or on-the-day-only flows. The widget falls back to a single
-- "Pay in full" CTA when every flag is off + no deposit is set, so a
-- misconfigured row still books rather than locking the customer out.
--
-- Apply order per CLAUDE.md: shadow first, then production.
-- Rollback: drop the column + recreate the view without it.

alter table public.lng_booking_type_config
  add column if not exists widget_allow_pay_in_full boolean not null default true;

comment on column public.lng_booking_type_config.widget_allow_pay_in_full is
  'When TRUE the booking widget surfaces a "Pay in full" CTA on the details footer. Set per booking-type via the Lounge admin Widget tab. Default TRUE — existing services keep the historical option.';

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
    COALESCE(duration_default, duration_min, 30) AS duration_minutes,
    service_type
  FROM lng_booking_type_config
  WHERE widget_visible = true
    AND repair_variant IS NULL
    AND product_key IS NULL
    AND arch IS NULL;

comment on view public.lng_widget_booking_types is
  'Public, anon-readable view of widget-visible booking types. Drives the booking widget service picker + payment CTA combination. Recomputed on read.';
