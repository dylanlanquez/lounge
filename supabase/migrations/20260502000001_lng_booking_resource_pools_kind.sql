-- 20260502000001_lng_booking_resource_pools_kind.sql
--
-- Resource pools were introduced as a single bag of "things in your
-- clinic that limit concurrent capacity": chairs, lab benches,
-- consult rooms. In practice the same pool model also fits *staff
-- roles* — there's only one impression-taker, so the "impression
-- takers" pool's capacity is 1, and the conflict checker treats it
-- exactly the same as a chair pool. The infrastructure has always
-- supported this; the UI just hadn't been told it was a thing.
--
-- This migration adds a `kind` discriminator so the admin UI can
-- visually group pools (Spaces & equipment vs Staff roles) and
-- so future logic — service-rule sentence builders, capacity
-- audits — can branch on the type without re-deriving from the
-- display name.
--
-- The conflict checker itself is unchanged: pools work the same
-- regardless of kind. This is a presentation-layer feature with a
-- column added to support it.
--
-- Rollback: ALTER TABLE public.lng_booking_resource_pools DROP COLUMN kind;

alter table public.lng_booking_resource_pools
  add column if not exists kind text not null default 'resource'
    check (kind in ('resource', 'staff_role'));

create index if not exists lng_booking_resource_pools_kind_idx
  on public.lng_booking_resource_pools (kind);

comment on column public.lng_booking_resource_pools.kind is
  'Discriminator for the admin UI: ''resource'' (chairs / equipment / rooms — physical things) or ''staff_role'' (impression takers, denture techs — people in a role). Conflict-check logic is identical; this only affects how the pool is grouped + labelled in Admin → Conflicts.';
