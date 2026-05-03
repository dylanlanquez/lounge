-- 20260503000004_lng_resolve_with_phases.sql
--
-- ADR-006 / slice doc `docs/slices/booking-phases.md` — M4.
--
-- Rewrites lng_booking_type_resolve to return three new fields on
-- top of everything it returned before:
--
--   phases                          jsonb  — resolved phase rows in
--                                            phase_index order, each
--                                            with parent-fallback
--                                            applied per duration
--                                            field.
--   block_duration_minutes          int    — sum of phase
--                                            duration_default values.
--   patient_facing_duration_minutes int    — resolved from child or
--                                            parent; falls back to
--                                            block_duration_minutes
--                                            when both null.
--
-- The legacy fields (working_hours, duration_min/max/default,
-- max_concurrent, pool_ids, notes, source) are unchanged so existing
-- callers keep working. The pool_ids field is now sourced from
-- lng_booking_type_phase_pools (aggregated across all phases), with
-- a defensive fallback to lng_booking_service_pools for any parent
-- that has no phase rows (shouldn't happen after M1, but the fallback
-- means a config bug doesn't take the resolver down).
--
-- ── Pool inheritance for child phases ─────────────────────────────
-- In v1, child config rows inherit pool consumption from the parent
-- phase wholesale (children retune durations only — see ADR-006
-- §6.3.3). The phases jsonb array therefore reads pool_ids from the
-- parent phase row regardless of whether the child has its own
-- duration override.
--
-- ── Idempotency ───────────────────────────────────────────────────
-- DROP FUNCTION + CREATE — same shape as the previous _04 migration.
-- Safe to re-run.

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
  patient_facing_duration_minutes int
)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  child_row        public.lng_booking_type_config;
  parent_row       public.lng_booking_type_config;
  pools            text[];
  resolved_phases  jsonb;
  block_total      int;
  patient_facing   int;
begin
  -- ── Parent ──
  select * into parent_row
    from public.lng_booking_type_config c
   where c.service_type    = p_service_type
     and c.repair_variant is null
     and c.product_key    is null
     and c.arch           is null
   limit 1;

  -- ── Child override (only one of the three keys is non-null) ──
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

  -- ── Resolved phase array (parent shape + per-phase_index merge) ──
  -- For each parent phase, look up the same phase_index on the child
  -- config (if any) and merge per-field. Pool_ids inherit wholesale
  -- from the parent phase in v1.
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'phase_index',      pp.phase_index,
             'label',            pp.label,
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

  -- ── Legacy pool_ids field — aggregated across all parent phases ──
  -- Defensive fallback to lng_booking_service_pools when a parent
  -- has no phase rows yet (shouldn't happen post-M1).
  select coalesce(array_agg(distinct pool_id order by pool_id),
                  array[]::text[])
    into pools
    from (
      select pp.pool_id
        from public.lng_booking_type_phase_pools pp
        join public.lng_booking_type_phases ph on ph.id = pp.phase_id
       where ph.config_id = parent_row.id
    ) phase_pools;

  if pools is null or cardinality(pools) = 0 then
    select coalesce(array_agg(sp.pool_id order by sp.pool_id),
                    array[]::text[])
      into pools
      from public.lng_booking_service_pools sp
     where sp.service_type = p_service_type;
  end if;

  -- ── Block duration = sum of resolved phase defaults ──
  select coalesce(sum((elt->>'duration_default')::int), 0)
    into block_total
    from jsonb_array_elements(resolved_phases) elt;

  -- ── Patient-facing: child wins, then parent, then derived block ──
  patient_facing := coalesce(
    child_row.patient_facing_duration_minutes,
    parent_row.patient_facing_duration_minutes,
    nullif(block_total, 0)
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
      patient_facing;
end;
$$;

revoke all on function public.lng_booking_type_resolve(text, text, text, text) from public;
grant execute on function public.lng_booking_type_resolve(text, text, text, text) to authenticated;

comment on function public.lng_booking_type_resolve(text, text, text, text) is
  'Returns the effective booking-type config for (service, repair_variant?, product_key?, arch?). Includes the resolved phase array (parent shape, child duration overrides applied per phase_index), the derived block_duration_minutes, and the patient-facing duration (child→parent→block fallback). Legacy fields (working_hours, durations, pool_ids) preserved for backwards compatibility. See ADR-006.';

-- ── Rollback (restores the M1 / pre-phases shape) ─────────────────
-- The previous version of this function lived in
-- 20260501000004_lng_booking_resource_pools.sql; re-apply that file
-- to restore.
