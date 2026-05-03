-- 20260503000009_lng_booking_type_display_label.sql
--
-- Adds an editable display_label on lng_booking_type_config so admins
-- can rename the title of any override row (e.g. catalogue-derived
-- "Cracked denture" → "Cracked denture (front teeth)" without
-- editing the catalogue). Parent rows can also use this to override
-- the service display name if they ever need to.
--
-- ── Behaviour ────────────────────────────────────────────────────
-- Null = fall back to the auto-derived label (catalogue
-- repair_variant, humanised product_key, archLabel, or service
-- display name). Non-null = take it verbatim.
--
-- The bookingTypeRowLabel client helper handles the precedence;
-- the resolver already returns the row, so callers can branch on
-- their own without server changes.

alter table public.lng_booking_type_config
  add column if not exists display_label text
    check (display_label is null or length(trim(display_label)) > 0);

comment on column public.lng_booking_type_config.display_label is
  'Optional admin-editable display name for this row. When set, takes precedence over the catalogue / arch / service-derived label everywhere the row surfaces (admin tree, schedule cards, emails). Null = derived label.';

-- ── Rollback ─────────────────────────────────────────────────────
-- alter table public.lng_booking_type_config drop column if exists display_label;
