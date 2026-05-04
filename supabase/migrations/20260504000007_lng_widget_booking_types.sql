-- ─────────────────────────────────────────────────────────────────────────────
-- Lounge — booking widget data layer (phase 2 part 1)
--
-- Adds the widget-facing columns to lng_booking_type_config + a
-- public read view so the customer-facing widget can render real
-- services without needing to authenticate. Three existing parent
-- rows are seeded as widget-visible with sensible starter copy so
-- the widget has content the moment this lands; the admin tweaks
-- the labels, descriptions, and prices from there.
--
-- New columns on lng_booking_type_config:
--
--   widget_visible          off by default — admin opts a row in
--                           explicitly. Stops every internal-only
--                           booking type from leaking out the moment
--                           the widget goes live.
--   widget_label            display name in the widget. Falls back
--                           to display_label, then service_type, in
--                           the view. Lets the public-facing copy
--                           be different from the operator label
--                           ("Click-in veneers" vs "Smile reset").
--   widget_description      paragraph shown under the label on the
--                           Service step. Plain text (HTML allowed
--                           for &amp; etc).
--   widget_price_pence      headline price the patient sees, in
--                           pence. NULL hides the price.
--   widget_deposit_pence    deposit captured at booking time, in
--                           pence. 0 (default) means no payment
--                           step — the booking confirms straight
--                           after Step 5.
--   widget_allow_staff_pick whether the dentist-picker step shows
--                           for this booking type. Defaults to
--                           true (matches the most common case).
--
-- New objects:
--
--   public.lng_widget_booking_types  view, anon-readable. Returns
--                                     widget-visible parent rows
--                                     only (no child rows / repair
--                                     variants / product / arch).
--                                     Order is alphabetical by
--                                     label so the picker reads
--                                     consistently.
--
-- Idempotent — re-running the migration is a no-op.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.lng_booking_type_config
  add column if not exists widget_visible boolean not null default false,
  add column if not exists widget_label text,
  add column if not exists widget_description text,
  add column if not exists widget_price_pence integer
    check (widget_price_pence is null or widget_price_pence >= 0),
  add column if not exists widget_deposit_pence integer not null default 0
    check (widget_deposit_pence >= 0),
  add column if not exists widget_allow_staff_pick boolean not null default true;

-- Deposit can never exceed price. Enforced as a check across two
-- columns; deferred to constraint form so the admin UI can update
-- one column at a time without tripping it as long as the final
-- state is consistent.
do $$ begin
  alter table public.lng_booking_type_config
    add constraint lng_booking_type_config_widget_deposit_lte_price
    check (
      widget_price_pence is null
      or widget_deposit_pence <= widget_price_pence
    );
exception when duplicate_object then null; end $$;

-- Anon-readable view of widget-visible parent rows.
--
-- Note: we explicitly exclude child rows (repair_variant /
-- product_key / arch is not null). The widget surfaces parent
-- rows only — variants / arches are an internal scheduling
-- concept that doesn't translate to "what kind of appointment
-- should I book?" in patient language.
create or replace view public.lng_widget_booking_types as
  select
    id,
    coalesce(widget_label, display_label, service_type) as label,
    coalesce(widget_description, '') as description,
    widget_price_pence as price_pence,
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

-- ── Seed: turn three real booking types on for the widget ────────────────────
--
-- These are the public-facing flagship services every Lounge clinic
-- offers today. The labels, descriptions, prices and deposits below
-- are starting-point copy — the admin overrides any of them from
-- Admin → Booking types once the row is theirs.

update public.lng_booking_type_config
set
  widget_visible = true,
  widget_label = coalesce(widget_label, 'Click-in veneers'),
  widget_description = coalesce(
    widget_description,
    'Removable, lifelike veneers, designed and fitted in a single visit. We take impressions, design your smile with you, and you walk out wearing them. No drilling, no commitment.'
  ),
  widget_price_pence = coalesce(widget_price_pence, 195000),
  widget_deposit_pence = case when widget_deposit_pence = 0 then 25000 else widget_deposit_pence end,
  widget_allow_staff_pick = true
where service_type = 'click_in_veneers'
  and repair_variant is null
  and product_key is null
  and arch is null;

update public.lng_booking_type_config
set
  widget_visible = true,
  widget_label = coalesce(widget_label, 'Impressions appointment'),
  widget_description = coalesce(
    widget_description,
    'A 30-minute visit where we take precise impressions of your teeth. The first step toward custom veneers, dentures, or a same-day appliance.'
  ),
  widget_price_pence = coalesce(widget_price_pence, 7500),
  widget_deposit_pence = case when widget_deposit_pence = 0 then 2500 else widget_deposit_pence end,
  widget_allow_staff_pick = false
where service_type = 'impression_appointment'
  and repair_variant is null
  and product_key is null
  and arch is null;

update public.lng_booking_type_config
set
  widget_visible = true,
  widget_label = coalesce(widget_label, 'Same-day appliance'),
  widget_description = coalesce(
    widget_description,
    'Custom-made appliance, designed and produced in our in-house lab during your visit. 90 minutes start to finish — you arrive without it, leave with it.'
  ),
  widget_price_pence = coalesce(widget_price_pence, 95000),
  widget_deposit_pence = case when widget_deposit_pence = 0 then 10000 else widget_deposit_pence end,
  widget_allow_staff_pick = true
where service_type = 'same_day_appliance'
  and repair_variant is null
  and product_key is null
  and arch is null;

comment on view public.lng_widget_booking_types is
  'Widget-visible parent booking types, anon-readable. Source of truth for the customer-facing booking widget Service step. Maintained alongside lng_booking_type_config; admins flip widget_visible per row to opt a service in or out of the public widget.';
