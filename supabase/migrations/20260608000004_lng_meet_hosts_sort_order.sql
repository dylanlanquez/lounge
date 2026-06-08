-- 20260608000004_lng_meet_hosts_sort_order.sql
--
-- Manual display order for Meet hosts, so an admin can reorder how they
-- appear in the admin list and the booking form's host dropdown (until
-- now the order was hardcoded with Karly pinned first). Mirrors the
-- lwo_catalogue.sort_order pattern: lower = earlier, spaced by 10 so a
-- reorder rewrites only the moved rows.

alter table public.lng_meet_hosts
  add column if not exists sort_order integer not null default 0;

-- Seed existing rows by connection order so the current display (Karly
-- first) is preserved; admins can reorder from there.
with ranked as (
  select id, (row_number() over (order by created_at)) * 10 as so
  from public.lng_meet_hosts
)
update public.lng_meet_hosts h
set sort_order = ranked.so
from ranked
where ranked.id = h.id and h.sort_order = 0;

comment on column public.lng_meet_hosts.sort_order is
  'Manual display order for the admin host list + booking host dropdown. Lower = earlier. Reordered from Admin > Services.';

NOTIFY pgrst, 'reload schema';
