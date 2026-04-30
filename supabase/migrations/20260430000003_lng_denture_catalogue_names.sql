-- 20260430000003_lng_denture_catalogue_names.sql
--
-- Make denture-line catalogue names self-describing.
--
-- The picker's denture rows ported from lwo_catalogue read fine in
-- the picker (they sit under a "Denture repairs" section header), but
-- once a row lands on a Ready-to-start summary or a receipt the
-- section context is gone and "Broken tooth" / "Relining (both
-- arches)" no longer says what's being repaired. Snapped and Cracked
-- already say "Snapped denture" / "Cracked denture"; the rest are
-- updated here to match.
--
-- Names only — descriptions, prices, codes, and service_type are
-- left untouched. lng_cart_items rows already in the wild keep their
-- frozen `name` snapshots, which is the correct receipt behaviour
-- (history doesn't get rewritten by a catalogue rename).

update public.lwo_catalogue
   set name = 'Broken tooth on denture'
 where code = 'den_broken_tooth';

update public.lwo_catalogue
   set name = 'Add a new tooth to denture'
 where code = 'den_add_tooth';

update public.lwo_catalogue
   set name = 'Reline denture (single arch)'
 where code = 'den_reline_single';

update public.lwo_catalogue
   set name = 'Reline denture (both arches)'
 where code = 'den_reline_both';

-- ── Rollback ────────────────────────────────────────────────────────────────
-- update public.lwo_catalogue set name = 'Broken tooth'             where code = 'den_broken_tooth';
-- update public.lwo_catalogue set name = 'Add a new tooth'          where code = 'den_add_tooth';
-- update public.lwo_catalogue set name = 'Relining (single arch)'   where code = 'den_reline_single';
-- update public.lwo_catalogue set name = 'Relining (both arches)'   where code = 'den_reline_both';
