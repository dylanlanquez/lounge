-- 20260501000004_lng_booking_resource_pools.sql
--
-- Concurrency / capacity model for the native Lounge booking system.
-- Builds on lng_booking_type_config (hours + durations) by adding the
-- "what can run at the same time as what" layer that the reschedule
-- flow's conflict checker (PR-6) and the admin Conflicts & capacity
-- page (PR-5) both read from.
--
-- ── Mental model ───────────────────────────────────────────────────
--
-- A clinic has a small number of finite resources: chairs, a lab
-- bench, a consultation room. Each is a *pool* with a capacity (the
-- number of simultaneous bookings it can absorb).
--
-- Each service type consumes one unit of one or more pools while a
-- booking of that service is in progress. A new booking at time T
-- is allowed iff for every pool the service consumes, the count of
-- bookings already overlapping T (that also consume that pool)
-- + 1 <= the pool's capacity.
--
-- This captures both "we have 2 chairs" (chairs capacity = 2) and
-- "click-in veneers and same-day appliances can't run simultaneously
-- because they share the lab bench" (both consume `lab-bench` which
-- has capacity 1) without needing a pairwise compatibility matrix.
--
-- Plus a per-booking-type `max_concurrent` cap on lng_booking_type_
-- config for cases where the resource model isn't enough (e.g.
-- "we only do 1 whitening kit fitting at a time even though we have
-- 2 chairs" — set max_concurrent on the same-day-appliance/whitening_kit
-- child override row).
--
-- Pool consumption is set at the *service type* level only for v1.
-- Children of a service inherit the parent's pool consumption.
-- Per-child pool overrides are deferred (YAGNI) — easy to add later
-- with another junction table keyed on the full child tuple.
--
-- ── Privacy / RLS ──────────────────────────────────────────────────
-- All staff can SELECT (the reschedule slot picker needs the rules
-- to know whether a slot is free). Only admins can write — these
-- are operational settings.
--
-- See the migration-workflow runbook for the apply procedure.

-- ── lng_booking_resource_pools ─────────────────────────────────────
-- Named resources with bounded capacity. The id is a slug used as
-- the FK across the rest of the schema; it must be lowercase
-- letters + digits + hyphens so it composes cleanly in URLs and
-- logs.

create table if not exists public.lng_booking_resource_pools (
  id            text primary key check (id ~ '^[a-z][a-z0-9-]+$'),
  display_name  text not null,
  capacity      int not null check (capacity > 0),
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger lng_booking_resource_pools_set_updated_at
  before update on public.lng_booking_resource_pools
  for each row execute function public.touch_updated_at();

alter table public.lng_booking_resource_pools enable row level security;

create policy lng_booking_resource_pools_read
  on public.lng_booking_resource_pools
  for select to authenticated using (true);

create policy lng_booking_resource_pools_admin_write
  on public.lng_booking_resource_pools
  for all to authenticated
  using (public.auth_is_lng_admin() or public.auth_is_super_admin())
  with check (public.auth_is_lng_admin() or public.auth_is_super_admin());

comment on table public.lng_booking_resource_pools is
  'Named resources with bounded capacity (chairs, consult rooms, lab benches). A booking consumes 1 unit of every pool its service type is mapped to via lng_booking_service_pools, for the duration of the booking. Capacity governs concurrent claims.';

-- ── lng_booking_service_pools ──────────────────────────────────────
-- Junction: which pools does each service type consume? A row here
-- means: when ANY booking of this service type is running, it
-- occupies 1 unit of capacity in this pool. Children of a service
-- inherit the parent's pool list at resolve time (per-child
-- overrides are not yet supported).

create table if not exists public.lng_booking_service_pools (
  service_type  text not null
                  check (service_type in (
                    'denture_repair',
                    'click_in_veneers',
                    'same_day_appliance',
                    'impression_appointment',
                    'other'
                  )),
  pool_id       text not null references public.lng_booking_resource_pools(id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (service_type, pool_id)
);

create index if not exists lng_booking_service_pools_pool_idx
  on public.lng_booking_service_pools (pool_id);

alter table public.lng_booking_service_pools enable row level security;

create policy lng_booking_service_pools_read
  on public.lng_booking_service_pools
  for select to authenticated using (true);

create policy lng_booking_service_pools_admin_write
  on public.lng_booking_service_pools
  for all to authenticated
  using (public.auth_is_lng_admin() or public.auth_is_super_admin())
  with check (public.auth_is_lng_admin() or public.auth_is_super_admin());

comment on table public.lng_booking_service_pools is
  'Per-service-type pool consumption. A row (denture_repair, chairs) means every denture-repair booking occupies 1 chair-pool unit while it runs.';

-- ── max_concurrent on lng_booking_type_config ──────────────────────
-- Per-booking-type cap on simultaneous bookings of THIS specific
-- type, independent of the pool model. Inherits to children the
-- same way working_hours / duration_* do.
--
-- Use case: "we have 2 chairs (so resource pools allow 2 concurrent
-- bookings of any chair-using service) but we only do 1 whitening
-- kit fitting at a time because the technician needs to be present
-- the whole way through". Set max_concurrent = 1 on the
-- (same_day_appliance, whitening_kit) child override.

alter table public.lng_booking_type_config
  add column if not exists max_concurrent int
    check (max_concurrent is null or max_concurrent > 0);

comment on column public.lng_booking_type_config.max_concurrent is
  'Optional per-booking-type cap on simultaneous bookings of this exact type. Independent of resource-pool capacity — both rules apply (a booking is allowed iff it satisfies both). Null = inherit from parent.';

-- ── Resolver — refresh to include max_concurrent and pool ids ──────
-- Same shape as before; we add max_concurrent to the returned tuple
-- and a `pool_ids` array containing the parent service's pool list
-- (children inherit). The reschedule slot picker's conflict check
-- reads everything it needs from one round-trip.

drop function if exists public.lng_booking_type_resolve(text, text, text, text);

create or replace function public.lng_booking_type_resolve(
  p_service_type   text,
  p_repair_variant text default null,
  p_product_key    text default null,
  p_arch           text default null
)
returns table (
  service_type     text,
  repair_variant   text,
  product_key      text,
  arch             text,
  working_hours    jsonb,
  duration_min     int,
  duration_max     int,
  duration_default int,
  max_concurrent   int,
  pool_ids         text[],
  notes            text,
  source           text -- 'child' | 'parent' — duration/hours source
)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  child_row   public.lng_booking_type_config;
  parent_row  public.lng_booking_type_config;
  pools       text[];
begin
  select * into parent_row
    from public.lng_booking_type_config c
   where c.service_type = p_service_type
     and c.repair_variant is null
     and c.product_key is null
     and c.arch is null
   limit 1;

  if p_repair_variant is not null then
    select * into child_row
      from public.lng_booking_type_config c
     where c.service_type = p_service_type
       and c.repair_variant = p_repair_variant
       and c.product_key is null
       and c.arch is null
     limit 1;
  elsif p_product_key is not null then
    select * into child_row
      from public.lng_booking_type_config c
     where c.service_type = p_service_type
       and c.repair_variant is null
       and c.product_key = p_product_key
       and c.arch is null
     limit 1;
  elsif p_arch is not null then
    select * into child_row
      from public.lng_booking_type_config c
     where c.service_type = p_service_type
       and c.repair_variant is null
       and c.product_key is null
       and c.arch = p_arch
     limit 1;
  end if;

  -- Pool consumption is service-level only in v1. Children inherit
  -- the parent service's pool list wholesale. Table alias avoids
  -- the column / plpgsql-variable name collision on service_type.
  select coalesce(array_agg(sp.pool_id order by sp.pool_id), array[]::text[])
    into pools
    from public.lng_booking_service_pools sp
   where sp.service_type = p_service_type;

  return query
    select
      p_service_type,
      p_repair_variant,
      p_product_key,
      p_arch,
      coalesce(child_row.working_hours,    parent_row.working_hours),
      coalesce(child_row.duration_min,     parent_row.duration_min),
      coalesce(child_row.duration_max,     parent_row.duration_max),
      coalesce(child_row.duration_default, parent_row.duration_default),
      coalesce(child_row.max_concurrent,   parent_row.max_concurrent),
      pools,
      coalesce(child_row.notes,            parent_row.notes),
      case when child_row.id is not null then 'child' else 'parent' end;
end;
$$;

revoke all on function public.lng_booking_type_resolve(text, text, text, text) from public;
grant execute on function public.lng_booking_type_resolve(text, text, text, text) to authenticated;

-- ── Seed: default pools and service-pool consumption ──────────────
-- A small clinic with 2 chairs, 1 lab bench, 1 consult room. Admin
-- can edit these via the Conflicts & capacity page (PR-5).

insert into public.lng_booking_resource_pools (id, display_name, capacity, notes) values
  ('chairs',       'Chairs',           2, 'Treatment chairs available simultaneously.'),
  ('lab-bench',    'Lab bench',        1, 'Used for veneer fittings and same-day fabrication.'),
  ('consult-room', 'Consultation room', 1, 'Used for impressions and consultations.')
on conflict (id) do nothing;

insert into public.lng_booking_service_pools (service_type, pool_id) values
  ('denture_repair',         'chairs'),
  ('click_in_veneers',       'chairs'),
  ('click_in_veneers',       'lab-bench'),
  ('same_day_appliance',     'chairs'),
  ('same_day_appliance',     'lab-bench'),
  ('impression_appointment', 'consult-room'),
  ('other',                  'consult-room')
on conflict (service_type, pool_id) do nothing;

-- ── Rollback ───────────────────────────────────────────────────────
-- drop function if exists public.lng_booking_type_resolve(text, text, text, text);
-- alter table public.lng_booking_type_config drop column if exists max_concurrent;
-- drop policy if exists lng_booking_service_pools_admin_write on public.lng_booking_service_pools;
-- drop policy if exists lng_booking_service_pools_read on public.lng_booking_service_pools;
-- drop index if exists public.lng_booking_service_pools_pool_idx;
-- drop table if exists public.lng_booking_service_pools;
-- drop policy if exists lng_booking_resource_pools_admin_write on public.lng_booking_resource_pools;
-- drop policy if exists lng_booking_resource_pools_read on public.lng_booking_resource_pools;
-- drop trigger if exists lng_booking_resource_pools_set_updated_at on public.lng_booking_resource_pools;
-- drop table if exists public.lng_booking_resource_pools;
