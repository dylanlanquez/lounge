-- 20260503000011_lng_drop_service_pools.sql
--
-- Drops lng_booking_service_pools — the legacy service-level pool
-- consumption table that was superseded by per-phase pool
-- consumption (lng_booking_type_phase_pools, ADR-006). At this
-- point:
--
--   * Every parent config has at least one phase row (M1 seed).
--   * The conflict checker (M5) walks lng_appointment_phases ×
--     lng_booking_type_phase_pools — never reads service_pools.
--   * The resolver's defensive fallback to service_pools is
--     removed in this migration.
--   * The Resources admin tab (renamed from Conflicts) reads
--     usage from a phase-pool join, not the service junction.
--
-- ── Resolver: drop the service-pool fallback ────────────────────
-- The previous resolver fell back to lng_booking_service_pools
-- when a parent config had no phase rows. That branch is now dead
-- code (every parent has phases) and we want to drop the table,
-- so this migration also re-creates lng_booking_type_resolve
-- without the fallback.

drop function if exists public.lng_booking_type_resolve(text, text, text, text);

create or replace function public.lng_booking_type_resolve(
  p_service_type   text,
  p_repair_variant text default null,
  p_product_key    text default null,
  p_arch           text default null
)
returns table (
  service_type                    text,
  repair_variant                  text,
  product_key                     text,
  arch                            text,
  working_hours                   jsonb,
  duration_min                    int,
  duration_max                    int,
  duration_default                int,
  max_concurrent                  int,
  pool_ids                        text[],
  notes                           text,
  source                          text,
  phases                          jsonb,
  block_duration_minutes          int,
  patient_facing_min_minutes      int,
  patient_facing_max_minutes      int
)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  child_row             public.lng_booking_type_config;
  parent_row            public.lng_booking_type_config;
  pools                 text[];
  resolved_phases       jsonb;
  block_total           int;
  pf_min                int;
  pf_max                int;
begin
  select * into parent_row
    from public.lng_booking_type_config c
   where c.service_type    = p_service_type
     and c.repair_variant is null
     and c.product_key    is null
     and c.arch           is null
   limit 1;

  if p_repair_variant is not null then
    select * into child_row
      from public.lng_booking_type_config c
     where c.service_type    = p_service_type
       and c.repair_variant  = p_repair_variant
       and c.product_key    is null
       and c.arch           is null
     limit 1;
  elsif p_product_key is not null then
    select * into child_row
      from public.lng_booking_type_config c
     where c.service_type    = p_service_type
       and c.repair_variant is null
       and c.product_key     = p_product_key
       and c.arch           is null
     limit 1;
  elsif p_arch is not null then
    select * into child_row
      from public.lng_booking_type_config c
     where c.service_type    = p_service_type
       and c.repair_variant is null
       and c.product_key    is null
       and c.arch            = p_arch
     limit 1;
  end if;

  -- Resolved phase array — parent shape, with child-row fields
  -- coalesced per phase_index.
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'phase_index',      pp.phase_index,
             'label',            coalesce(cp.label_override, pp.label),
             'patient_required', pp.patient_required,
             'duration_min',     coalesce(cp.duration_min,     pp.duration_min),
             'duration_max',     coalesce(cp.duration_max,     pp.duration_max),
             'duration_default', coalesce(cp.duration_default, pp.duration_default),
             'pool_ids',         coalesce(
               (select array_agg(p2.pool_id order by p2.pool_id)
                  from public.lng_booking_type_phase_pools p2
                 where p2.phase_id = pp.id),
               array[]::text[]
             )
           )
           order by pp.phase_index
         ), '[]'::jsonb)
    into resolved_phases
    from public.lng_booking_type_phases pp
    left join public.lng_booking_type_phases cp
           on child_row.id is not null
          and cp.config_id   = child_row.id
          and cp.phase_index = pp.phase_index
   where pp.config_id = parent_row.id;

  -- Aggregated pool_ids (legacy field) — sourced exclusively from
  -- phase pools. The defensive fallback to lng_booking_service_pools
  -- is removed; if a parent has zero phases we return an empty list.
  select coalesce(array_agg(distinct pool_id order by pool_id),
                  array[]::text[])
    into pools
    from (
      select pp.pool_id
        from public.lng_booking_type_phase_pools pp
        join public.lng_booking_type_phases ph on ph.id = pp.phase_id
       where ph.config_id = parent_row.id
    ) phase_pools;

  select coalesce(sum((elt->>'duration_default')::int), 0)
    into block_total
    from jsonb_array_elements(resolved_phases) elt;

  pf_min := coalesce(
    child_row.patient_facing_min_minutes,
    parent_row.patient_facing_min_minutes,
    nullif(block_total, 0)
  );

  pf_max := coalesce(
    child_row.patient_facing_max_minutes,
    parent_row.patient_facing_max_minutes
  );

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
      case when child_row.id is not null then 'child' else 'parent' end,
      resolved_phases,
      nullif(block_total, 0),
      pf_min,
      pf_max;
end;
$$;

revoke all on function public.lng_booking_type_resolve(text, text, text, text) from public;
grant execute on function public.lng_booking_type_resolve(text, text, text, text) to authenticated;

comment on function public.lng_booking_type_resolve(text, text, text, text) is
  'Returns the effective booking-type config for (service, repair_variant?, product_key?, arch?). Phases jsonb merges parent shape with child-row overrides per phase_index. Pool_ids derived exclusively from lng_booking_type_phase_pools (no fallback to the dropped lng_booking_service_pools). See ADR-006.';

-- ── Drop the legacy table ───────────────────────────────────────
drop table if exists public.lng_booking_service_pools;

-- ── Rollback ────────────────────────────────────────────────────
-- Re-apply 20260501000004_lng_booking_resource_pools.sql to recreate
-- the table + service-level pool data; then re-apply
-- 20260503000010_lng_phase_label_override.sql to restore the
-- previous resolver shape (which had the defensive fallback).
