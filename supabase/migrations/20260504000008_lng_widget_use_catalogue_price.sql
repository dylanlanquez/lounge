-- ─────────────────────────────────────────────────────────────────────────────
-- Lounge — booking widget data layer (phase 2c)
--
-- Stops the widget from carrying its own copy of label + price. Both
-- already exist as canonical fields elsewhere:
--
--   • Label  → lng_booking_type_config.display_label
--   • Price  → lwo_catalogue.unit_price / both_arches_price, resolved
--              by axis pins (service_type + product_key /
--              repair_variant / arch_match)
--
-- The widget reads display_label as-is, and queries lwo_catalogue
-- after the axes step locks down which catalogue row applies. One
-- source of truth, no drift.
--
-- The lng_widget_booking_types view is rebuilt to reflect that:
-- price_pence is removed, label always reads from display_label
-- (with a service_type humanisation fallback). widget_visible,
-- widget_description, widget_deposit_pence, widget_allow_staff_pick
-- stay — those are widget-only concerns the catalogue can't speak to.
--
-- The widget_label and widget_price_pence columns on
-- lng_booking_type_config are LEFT in place (not dropped). Keeps
-- the migration non-destructive — any rows that had them set
-- continue to carry the value, the view just stops emitting it.
-- A future cleanup can drop the columns once we're sure nothing
-- reads them.
-- ─────────────────────────────────────────────────────────────────────────────

-- Drop and recreate so we can change the column set. Postgres
-- only allows column-additive changes via CREATE OR REPLACE; this
-- migration removes the now-redundant `label` (was widget_label
-- aliased) and `price_pence` columns so we have to rebuild.
drop view if exists public.lng_widget_booking_types;

create view public.lng_widget_booking_types as
  select
    id,
    -- Patient-facing label = the operator's display_label, falling
    -- back to a humanised service_type if the row hasn't been
    -- labelled yet ("click_in_veneers" → "Click in veneers").
    coalesce(
      nullif(trim(display_label), ''),
      initcap(replace(service_type, '_', ' '))
    ) as label,
    coalesce(widget_description, '') as description,
    widget_deposit_pence as deposit_pence,
    widget_allow_staff_pick as allow_staff_pick,
    coalesce(duration_default, duration_min, 30) as duration_minutes,
    service_type
  from public.lng_booking_type_config
  where widget_visible = true
    and repair_variant is null
    and product_key is null
    and arch is null;

grant select on public.lng_widget_booking_types to anon, authenticated;

-- Backfill display_label for the three rows we seeded as widget-
-- visible in 20260504000007. Their widget_label held the patient-
-- facing copy we want; mirror that into display_label so the
-- operator sees the same word and the duplication is gone.
update public.lng_booking_type_config
set display_label = coalesce(nullif(trim(display_label), ''), widget_label)
where widget_visible = true
  and widget_label is not null
  and trim(widget_label) <> '';

comment on view public.lng_widget_booking_types is
  'Widget-visible parent booking types, anon-readable. Label reads from display_label (operator-side); price is resolved by the widget against lwo_catalogue using the axis pins. Source of truth for the customer-facing booking widget Service step.';
