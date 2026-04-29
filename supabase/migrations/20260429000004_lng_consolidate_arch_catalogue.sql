-- 20260429000004_lng_consolidate_arch_catalogue.sql
--
-- Catalogue data cleanup, post-overhaul.
--
-- The catalogue port (migration 23) seeded each arch-priced product as
-- two separate rows: e.g. ret_single (£149) + ret_both (£199),
-- civ_single (£399) + civ_both (£599). After PR 3 of the picker
-- overhaul, the picker can ask for upper / lower / both inside one
-- expanded panel and price each tier from a single row — but only if
-- the data is consolidated to one row per product.
--
-- This migration walks every known *_single / *_both pair and:
--   - Folds the *_both row's price into the *_single row's
--     both_arches_price column.
--   - Renames the *_single row to drop the "Single arch " or
--     "(single arch)" noise so the picker header reads cleanly.
--   - Rewrites the description to cover both arch options.
--   - Confirms arch_match='single' (the picker uses that to know it
--     should expose the arch trio).
--   - Soft-deletes the *_both row (active=false) — it stays in the
--     table for receipt joins on historical line items, but vanishes
--     from the picker.
--
-- Also adds a missing service: 'Impression Appointment'. The seed
-- shipped without one because impression appointments came in via
-- Calendly only; Dylan now wants it bookable on a walk-in too. Inserted
-- inactive so admin can set a real price before it goes live.
--
-- All UPDATEs are by-code and ON CONFLICT-safe, so re-running is a
-- no-op once the cleanup has been applied.

-- ── 1. Pair: Relining (denture repair) ──────────────────────────────────────
update public.lwo_catalogue
   set name              = 'Relining',
       description       = 'Reline upper, lower, or both dentures for improved fit.',
       both_arches_price = 320.00,
       arch_match        = 'single'
 where code = 'den_reline_single';
update public.lwo_catalogue set active = false where code = 'den_reline_both';

-- ── 2. Pair: Essix retainer ─────────────────────────────────────────────────
update public.lwo_catalogue
   set name              = 'Retainer',
       description       = 'Top, bottom, or both arches. Ready in under 2 hours.',
       both_arches_price = 199.00,
       arch_match        = 'single'
 where code = 'ret_single';
update public.lwo_catalogue set active = false where code = 'ret_both';

-- ── 3. Pair: Replacement aligner ────────────────────────────────────────────
update public.lwo_catalogue
   set name              = 'Replacement aligner',
       description       = 'Based on current tooth position. Ready in under 2 hours.',
       both_arches_price = 199.00,
       arch_match        = 'single'
 where code = 'aln_single';
update public.lwo_catalogue set active = false where code = 'aln_both';

-- ── 4. Pair: Whitening tray ─────────────────────────────────────────────────
update public.lwo_catalogue
   set name              = 'Whitening tray',
       description       = 'Top, bottom, or both arches. Ready in under 2 hours.',
       both_arches_price = 199.00,
       arch_match        = 'single'
 where code = 'wt_single';
update public.lwo_catalogue set active = false where code = 'wt_both';

-- ── 5. Pair: Night guard ────────────────────────────────────────────────────
update public.lwo_catalogue
   set name              = 'Night guard',
       description       = 'Top, bottom, or both arches. Choice of thickness and material.',
       both_arches_price = 199.00,
       arch_match        = 'single'
 where code = 'ng_single';
update public.lwo_catalogue set active = false where code = 'ng_both';

-- ── 6. Pair: Day guard ──────────────────────────────────────────────────────
update public.lwo_catalogue
   set name              = 'Day guard',
       description       = 'Slim, discreet, comfortable for daytime wear. Top, bottom, or both arches.',
       both_arches_price = 199.00,
       arch_match        = 'single'
 where code = 'dg_single';
update public.lwo_catalogue set active = false where code = 'dg_both';

-- ── 7. Pair: Missing tooth retainer ─────────────────────────────────────────
update public.lwo_catalogue
   set name              = 'Missing tooth retainer',
       description       = 'Up to 3 teeth, shade matched. Per arch or both arches.',
       both_arches_price = 298.00,
       arch_match        = 'single'
 where code = 'mtr_single';
update public.lwo_catalogue set active = false where code = 'mtr_both';

-- ── 8. Pair: Click-in veneers ───────────────────────────────────────────────
update public.lwo_catalogue
   set name              = 'Click-in veneers',
       description       = 'With storage case and aftercare pack. Upper, lower, or both arches.',
       both_arches_price = 599.00,
       arch_match        = 'single'
 where code = 'civ_single';
update public.lwo_catalogue set active = false where code = 'civ_both';

-- ── 9. Add the missing Impression Appointment service row ──────────────────
-- Inserted inactive so admin can set a real price before it appears in
-- the picker. is_service=true puts it under the Services bucket on
-- first activation. service_type='impression_appointment' wires it
-- into JB-required gating + the impression clinic-board lane.
insert into public.lwo_catalogue (
  code, category, name, description, unit_price, extra_unit_price,
  unit_label, image_url, service_type, product_key, repair_variant,
  arch_match, is_service, sort_order, active
) values (
  'impression_appt',
  'Impression appointments',
  'Impression appointment',
  'In-clinic impression and JB allocation.',
  0,
  null,
  null,
  null,
  'impression_appointment',
  null,
  null,
  'any',
  true,
  900,
  false
)
on conflict (code) do nothing;
