-- 20260517000007_lng_resolver_child_extra_phases.sql
--
-- Lets a child config (e.g. denture_repair / Relining) DEFINE phases
-- the parent doesn't have. Until this migration the resolver iterated
-- over parent phases only and applied child overrides field-by-field
-- at matching phase_index. Child phase rows at indices beyond the
-- parent's count silently disappeared from the resolved shape — which
-- meant the Booking-types editor's "+ Add" affordance on overrides
-- (M17 UI patch) couldn't actually introduce a variant-only step
-- (Relining needs a "Fitting" phase the default denture repair does
-- not have).
--
-- Behaviour:
--   * Phases at indices present on the parent: same as M12 — child
--     row replaces every field wholesale when present, otherwise the
--     parent's row stands.
--   * Phases at indices present ONLY on the child: returned as-is.
--     Label, patient_required, durations, and pools all come from
--     the child row.
--
-- Implemented as a UNION ALL: parent-driven branch (every parent
-- index, with optional child override applied) plus child-only branch
-- (every child index that doesn't exist on the parent). The two sets
-- are disjoint by construction.
--
-- Signature unchanged from M12 — DROP + CREATE used because the
-- RETURNS TABLE shape must remain stable for the materialiser and
-- conflict checker that read by named field. Columns kept in the
-- same order and with the same names.
-- ─────────────────────────────────────────────────────────────────

drop function if exists public.lng_booking_type_resolve(text, text, text, text);

create function public.lng_booking_type_resolve(
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

  -- Resolved phase array. Two sources combined:
  --
  --   1. Every parent phase, with the matching child phase row
  --      replacing all fields wholesale when present (M12 row-level
  --      override).
  --   2. Every child phase whose phase_index is NOT present on the
  --      parent — variant-only steps the parent doesn't have. All
  --      fields come from the child row directly.
  --
  -- The two sets are disjoint by construction (a given phase_index
  -- can only land in one branch), so UNION ALL + ordered agg gives
  -- one entry per effective phase.
  select coalesce(jsonb_agg(elt order by (elt->>'phase_index')::int), '[]'::jsonb)
    into resolved_phases
    from (
      -- Parent-driven branch: one row per parent phase_index.
      select jsonb_build_object(
               'phase_index',      pp.phase_index,
               'label',            coalesce(cp.label, pp.label),
               'patient_required', coalesce(cp.patient_required, pp.patient_required),
               'duration_min',     coalesce(cp.duration_min,     pp.duration_min),
               'duration_max',     coalesce(cp.duration_max,     pp.duration_max),
               'duration_default', coalesce(cp.duration_default, pp.duration_default),
               'pool_ids',         case
                 when cp.id is not null then coalesce(
                   (select array_agg(p2.pool_id order by p2.pool_id)
                      from public.lng_booking_type_phase_pools p2
                     where p2.phase_id = cp.id),
                   array[]::text[]
                 )
                 else coalesce(
                   (select array_agg(p2.pool_id order by p2.pool_id)
                      from public.lng_booking_type_phase_pools p2
                     where p2.phase_id = pp.id),
                   array[]::text[]
                 )
               end
             ) as elt
        from public.lng_booking_type_phases pp
        left join public.lng_booking_type_phases cp
               on child_row.id is not null
              and cp.config_id   = child_row.id
              and cp.phase_index = pp.phase_index
       where pp.config_id = parent_row.id

      union all

      -- Child-only branch: child phase_index values that do NOT
      -- match any parent phase. Every field from the child row.
      select jsonb_build_object(
               'phase_index',      cp.phase_index,
               'label',            cp.label,
               'patient_required', cp.patient_required,
               'duration_min',     cp.duration_min,
               'duration_max',     cp.duration_max,
               'duration_default', cp.duration_default,
               'pool_ids',         coalesce(
                 (select array_agg(p2.pool_id order by p2.pool_id)
                    from public.lng_booking_type_phase_pools p2
                   where p2.phase_id = cp.id),
                 array[]::text[]
               )
             ) as elt
        from public.lng_booking_type_phases cp
       where child_row.id is not null
         and cp.config_id = child_row.id
         and not exists (
           select 1
             from public.lng_booking_type_phases pp
            where pp.config_id   = parent_row.id
              and pp.phase_index = cp.phase_index
         )
    ) merged;

  -- Aggregated pool_ids (legacy field) — sourced from parent phase
  -- pools only. Same as M12; the field is unchanged.
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
      p_service_type                                                    as service_type,
      p_repair_variant                                                  as repair_variant,
      p_product_key                                                     as product_key,
      p_arch                                                            as arch,
      coalesce(child_row.working_hours,    parent_row.working_hours)    as working_hours,
      coalesce(child_row.duration_min,     parent_row.duration_min)     as duration_min,
      coalesce(child_row.duration_max,     parent_row.duration_max)     as duration_max,
      coalesce(child_row.duration_default, parent_row.duration_default) as duration_default,
      coalesce(child_row.max_concurrent,   parent_row.max_concurrent)   as max_concurrent,
      pools                                                             as pool_ids,
      coalesce(child_row.notes,            parent_row.notes)            as notes,
      case
        when child_row.id is not null then 'child'
        else 'parent'
      end                                                               as source,
      resolved_phases                                                   as phases,
      nullif(block_total, 0)                                            as block_duration_minutes,
      pf_min                                                            as patient_facing_min_minutes,
      pf_max                                                            as patient_facing_max_minutes;
end;
$$;

comment on function public.lng_booking_type_resolve(text, text, text, text) is
  'Phase + duration + pool resolver for a (service_type, repair_variant?, product_key?, arch?) axis pin. Returns the effective phase shape after applying child row-level overrides (M12) AND any child-only phases at indices the parent does not declare (M17 — denture_repair / Relining can have a Fitting step the parent does not).';
