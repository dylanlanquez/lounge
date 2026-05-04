-- ─────────────────────────────────────────────────────────────────────────────
-- Lounge — booking widget upgrades (phase 2d)
--
-- Lets the admin opt individual catalogue upgrades into the widget,
-- so patients see relevant upsells on the booking form before they
-- commit. Per-upgrade visibility, anon-readable.
--
-- Why a per-upgrade flag: the same `lng_catalogue_upgrades` table
-- powers both the in-clinic till (where staff add upgrades on the
-- spot) and the customer-facing widget. Some upgrades make sense to
-- offer up-front; others are better discussed with the dentist
-- first. The flag lets the admin pick.
--
-- Adds:
--
--   • widget_visible boolean on lng_catalogue_upgrades — off by
--     default, admin opts each upgrade in.
--   • public.lng_widget_upgrades view — anon-readable. Returns
--     upgrade rows joined to their parent catalogue row's
--     service_type / product_key / repair_variant so the widget
--     can pull "all upgrades that apply to my picked catalogue row"
--     in one query.
--
-- Seed: turns on the two existing retainer upgrades (Thicker
-- 1.5mm, Scalloped) so the widget has something to render the
-- moment this lands.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.lng_catalogue_upgrades
  add column if not exists widget_visible boolean not null default false;

create or replace view public.lng_widget_upgrades as
  select
    u.id,
    u.code,
    u.name,
    coalesce(u.description, '') as description,
    u.price as unit_price,
    u.both_arches_price,
    u.sort_order,
    u.catalogue_id,
    -- Surface the parent catalogue row's identity so the widget
    -- can filter by what the patient has picked without a second
    -- round-trip.
    c.service_type,
    c.product_key,
    c.repair_variant,
    c.arch_match
  from public.lng_catalogue_upgrades u
  join public.lwo_catalogue c on c.id = u.catalogue_id
  where u.active = true
    and u.widget_visible = true
    and c.active = true;

grant select on public.lng_widget_upgrades to anon, authenticated;

-- Seed: opt the existing retainer upgrades on so the widget has
-- something visible immediately. Admin can flip them off from the
-- Widget tab if they'd rather not surface online.
update public.lng_catalogue_upgrades
set widget_visible = true
where active = true
  and code in ('thicker-retainers', 'Scalloped');

comment on view public.lng_widget_upgrades is
  'Widget-visible catalogue upgrades, anon-readable. The widget queries this after the patient has resolved a catalogue row (via service + axis pins) to find any upsells that apply.';
