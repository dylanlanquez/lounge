-- 20260429000005_lng_delete_old_arch_pairs.sql
--
-- Pre-launch cleanup. Migration 04 soft-deleted the eight legacy
-- '*_both' rows so historical receipts could still join against them.
-- We're pre-launch, no real receipts exist, so just bin them — keeps
-- the admin Catalogue list clean.
--
-- Idempotent: by-code DELETE skips rows that don't exist. If a cart_item
-- still references one of these (shouldn't be possible pre-launch), the
-- FK constraint will fail loudly — which is what we want, so we don't
-- silently lose receipt history.

delete from public.lwo_catalogue
 where code in (
   'den_reline_both',
   'ret_both',
   'aln_both',
   'wt_both',
   'ng_both',
   'dg_both',
   'mtr_both',
   'civ_both'
 );
