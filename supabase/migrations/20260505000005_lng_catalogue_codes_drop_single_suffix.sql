-- Rename catalogue codes: drop the '_single' suffix.
-- arch_match = 'single' on each row already captures the per-arch nature;
-- the code suffix added no information and confused admin users.
--
-- Mapping:
--   den_reline_single → den_reline
--   ret_single        → ret
--   aln_single        → aln
--   wt_single         → wt
--   ng_single         → ng
--   dg_single         → dg
--   mtr_single        → mtr
--   civ_single        → civ
--
-- lng_cart_items.catalogue_code is a plain text snapshot (no FK), so
-- historical rows are updated here too for reporting consistency —
-- grouping by catalogue_code across time would otherwise split on
-- the rename boundary.

begin;

update public.lwo_catalogue set code = 'den_reline' where code = 'den_reline_single';
update public.lwo_catalogue set code = 'ret'        where code = 'ret_single';
update public.lwo_catalogue set code = 'aln'        where code = 'aln_single';
update public.lwo_catalogue set code = 'wt'         where code = 'wt_single';
update public.lwo_catalogue set code = 'ng'         where code = 'ng_single';
update public.lwo_catalogue set code = 'dg'         where code = 'dg_single';
update public.lwo_catalogue set code = 'mtr'        where code = 'mtr_single';
update public.lwo_catalogue set code = 'civ'        where code = 'civ_single';

-- Backfill cart item snapshots so historical reporting groups cleanly.
update public.lng_cart_items
   set catalogue_code = 'den_reline',
       sku            = case when sku = 'den_reline_single' then 'den_reline' else sku end
 where catalogue_code = 'den_reline_single';

update public.lng_cart_items
   set catalogue_code = 'ret',
       sku            = case when sku = 'ret_single' then 'ret' else sku end
 where catalogue_code = 'ret_single';

update public.lng_cart_items
   set catalogue_code = 'aln',
       sku            = case when sku = 'aln_single' then 'aln' else sku end
 where catalogue_code = 'aln_single';

update public.lng_cart_items
   set catalogue_code = 'wt',
       sku            = case when sku = 'wt_single' then 'wt' else sku end
 where catalogue_code = 'wt_single';

update public.lng_cart_items
   set catalogue_code = 'ng',
       sku            = case when sku = 'ng_single' then 'ng' else sku end
 where catalogue_code = 'ng_single';

update public.lng_cart_items
   set catalogue_code = 'dg',
       sku            = case when sku = 'dg_single' then 'dg' else sku end
 where catalogue_code = 'dg_single';

update public.lng_cart_items
   set catalogue_code = 'mtr',
       sku            = case when sku = 'mtr_single' then 'mtr' else sku end
 where catalogue_code = 'mtr_single';

update public.lng_cart_items
   set catalogue_code = 'civ',
       sku            = case when sku = 'civ_single' then 'civ' else sku end
 where catalogue_code = 'civ_single';

commit;
