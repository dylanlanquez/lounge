-- ─────────────────────────────────────────────────────────────────────────────
-- Lounge — booking widget data layer (phase 2c, part 2)
--
-- Per-product visibility for the widget. A booking type may carry
-- multiple products (Same-day appliance has 7 — retainer, aligner,
-- night guard, etc). The admin needs to opt each product in or out
-- of the widget independently of the parent service:
--
--   • Service is widget-visible → service shows on Step 2
--   • Each product is widget-visible → that product appears in the
--     "What kind?" axis step. Hidden products simply don't render.
--
-- One column on lwo_catalogue (widget_visible boolean) handles it.
-- Public, anon-readable view exposes the visible product set so the
-- widget can fetch without authenticating. Same architecture pattern
-- as lng_widget_booking_types: column on the source table + a thin
-- public view.
--
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.lwo_catalogue
  add column if not exists widget_visible boolean not null default false;

-- Anon-readable view of widget-visible catalogue rows. Carries the
-- same fields the existing axes loader needs (name, arch_match,
-- price), plus service_type / product_key / repair_variant for
-- matching, plus unit_price + both_arches_price for the widget's
-- price resolution.
create or replace view public.lng_widget_catalogue as
  select
    id,
    code,
    name,
    description,
    service_type,
    product_key,
    repair_variant,
    arch_match,
    unit_price,
    both_arches_price,
    sort_order
  from public.lwo_catalogue
  where active = true
    and widget_visible = true;

grant select on public.lng_widget_catalogue to anon, authenticated;

-- ── Seed: opt the catalogue rows for our three widget-visible
--    services in. Same idea as the booking-type seed in 0007 — the
--    widget should have something to render the moment this lands;
--    the admin tweaks the visible set from the Widget tab.

update public.lwo_catalogue
set widget_visible = true
where active = true
  and (
    -- Click-in veneers: only one row, the parent product itself.
    (service_type = 'click_in_veneers' and code = 'civ_single')
    -- Impressions appointment: just the one row exists today.
    or (service_type = 'impression_appointment' and code = 'impression_appt')
    -- Same-day appliance: open with the four most-asked products.
    -- Aligner, missing-tooth retainer, whitening kit are widget-
    -- hidden by default — admin can flip them on later.
    or (
      service_type = 'same_day_appliance'
      and code in ('ret_single', 'wt_single', 'ng_single', 'dg_single')
    )
  );

comment on view public.lng_widget_catalogue is
  'Widget-visible catalogue rows, anon-readable. Drives the per-axis option set on the widget (which products in a given service are offered) and resolves the price for the booking summary once axes are pinned.';
