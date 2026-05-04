-- 20260504000002_lng_multi_axis_overrides.sql
--
-- Implements ADR-007. Generalises booking-type overrides from
-- "exactly one of {repair_variant, product_key, arch}" to "any subset
-- of a per-service axis registry". Resolver walks the
-- specificity-sorted chain and returns the row-level winner per
-- phase_index, axis-priority breaking ties.
--
-- ── What changes in the schema ──────────────────────────────────
--
-- 1. The at_most_one_child_key check constraint is dropped. Existing
--    single-axis rows (specificity = 1) remain valid; multi-axis rows
--    (specificity ≥ 2) become possible.
-- 2. The unique key (service_type, repair_variant, product_key, arch)
--    NULLS NOT DISTINCT is unchanged — already permits multi-axis
--    combos and continues to enforce uniqueness across the full key.
--
-- ── Resolver semantics ──────────────────────────────────────────
--
-- Given a request (service_type, repair_variant?, product_key?,
-- arch?), the resolver:
--
--   1. Builds the candidate set: every row with this service_type
--      where for each axis EITHER the row's axis value is NULL
--      (row doesn't pin that axis) OR the row's axis value equals the
--      request's value (row pins to the request).
--   2. Computes specificity = count of axes pinned to the request
--      (i.e. row.axis is non-null and equals p_axis).
--   3. Computes an axis-priority bitmap:
--        repair_variant pinned ⇒ +100
--        product_key   pinned ⇒ +10
--        arch          pinned ⇒ +1
--      Higher = wins ties at equal specificity. The numeric weights
--      (100/10/1) are arbitrary so long as variant > product > arch
--      and the deltas don't overflow when combined; bitmap is also
--      a stable secondary sort within a specificity tier.
--   4. Orders candidates by (specificity DESC, axis_priority DESC).
--      Most specific first, parent (specificity 0) last.
--   5. Walks the chain: for every scalar field (working_hours,
--      duration_*, max_concurrent, patient_facing_*, notes), takes
--      the first non-null value down the chain.
--   6. Resolves phases per phase_index: for each phase_index in the
--      parent's phase canvas, picks the phase row from the
--      most-specific config in the chain that has a phase at that
--      index. Pool consumption and all other fields come from the
--      winning child phase row wholesale (M12 row-level override
--      semantics, generalised to walk the chain instead of just
--      child→parent).
--
-- ── Backwards compatibility ────────────────────────────────────
--
-- Every existing override has at most one axis pinned. Their chain
-- length is 2 (themselves + parent), and the resolver's walk
-- produces identical output to the previous M12 implementation.
-- No data migration needed.
--
-- ── Why the axis-priority weights are global ───────────────────
--
-- The registry that defines per-service axis order lives in code
-- (src/lib/queries/bookingTypeAxes.ts). The DB doesn't need to know
-- per-service order because the universal order
-- variant > product > arch is consistent with every per-service
-- declaration we ship. If a future service declares axes in a
-- different order, that's a code-side convention; the resolver's
-- global tiebreak still gives a deterministic, predictable answer
-- (the dimension that's most expensive to override wins).

-- ── 1. Drop the single-axis constraint ──────────────────────────
alter table public.lng_booking_type_config
  drop constraint if exists at_most_one_child_key;

-- ── 2. Resolver — chain walk with axis priority ────────────────
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
  parent_row              public.lng_booking_type_config;
  resolved_phases         jsonb;
  pools                   text[];
  block_total             int;
  pf_min                  int;
  pf_max                  int;
  resolved_working_hours  jsonb;
  resolved_dur_min        int;
  resolved_dur_max        int;
  resolved_dur_default    int;
  resolved_max_concurrent int;
  resolved_notes          text;
  source_label            text;
  best_specificity        int;
begin
  -- Parent: the all-axes-null row. This anchors the phase canvas
  -- and is always the chain's terminal fallback.
  select * into parent_row
    from public.lng_booking_type_config c
   where c.service_type    = p_service_type
     and c.repair_variant is null
     and c.product_key    is null
     and c.arch           is null
   limit 1;

  -- Build the ordered candidate chain in a CTE-style with-statement.
  -- Each row matches if every axis it pins equals the request's
  -- value (or doesn't pin that axis at all). Sort by specificity
  -- (count of axes the row pins to the request) DESC, then by the
  -- axis-priority bitmap DESC.
  with candidates as (
    select c.*,
      ((case when c.repair_variant is not null then 1 else 0 end) +
       (case when c.product_key is not null then 1 else 0 end) +
       (case when c.arch is not null then 1 else 0 end)) as specificity,
      ((case when c.repair_variant is not null then 100 else 0 end) +
       (case when c.product_key is not null then 10 else 0 end) +
       (case when c.arch is not null then 1 else 0 end)) as axis_priority
      from public.lng_booking_type_config c
     where c.service_type = p_service_type
       and (c.repair_variant is null or c.repair_variant = p_repair_variant)
       and (c.product_key   is null or c.product_key   = p_product_key)
       and (c.arch          is null or c.arch          = p_arch)
  ),
  ordered_chain as (
    select *, row_number() over (order by specificity desc, axis_priority desc) as chain_pos
      from candidates
  )
  -- For each scalar field, the first non-null in chain order wins.
  select
    (select oc.working_hours    from ordered_chain oc where oc.working_hours    is not null order by oc.chain_pos limit 1),
    (select oc.duration_min     from ordered_chain oc where oc.duration_min     is not null order by oc.chain_pos limit 1),
    (select oc.duration_max     from ordered_chain oc where oc.duration_max     is not null order by oc.chain_pos limit 1),
    (select oc.duration_default from ordered_chain oc where oc.duration_default is not null order by oc.chain_pos limit 1),
    (select oc.max_concurrent   from ordered_chain oc where oc.max_concurrent   is not null order by oc.chain_pos limit 1),
    (select oc.notes            from ordered_chain oc where oc.notes            is not null order by oc.chain_pos limit 1),
    (select coalesce(max(oc.specificity), 0) from ordered_chain oc)
    into resolved_working_hours,
         resolved_dur_min,
         resolved_dur_max,
         resolved_dur_default,
         resolved_max_concurrent,
         resolved_notes,
         best_specificity;

  source_label := case when best_specificity > 0 then 'child' else 'parent' end;

  -- Phase canvas comes from the parent. For each parent phase_index,
  -- the winning phase row is the one in the most-specific config row
  -- that has a phase at that index. Found via a lateral join: for
  -- each parent phase, scan child phase rows whose config_id sits in
  -- ordered_chain ahead of the parent, ordered by chain_pos. The
  -- first hit wins. If none, the parent phase row stands.
  --
  -- Pool list per phase: from the winning row's id, look up
  -- lng_booking_type_phase_pools. Whatever the winner has (possibly
  -- empty) is the result; no merging across the chain.
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'phase_index',      pp.phase_index,
             'label',            wphase.label,
             'patient_required', wphase.patient_required,
             'duration_min',     wphase.duration_min,
             'duration_max',     wphase.duration_max,
             'duration_default', wphase.duration_default,
             'pool_ids',         coalesce(
               (select array_agg(p2.pool_id order by p2.pool_id)
                  from public.lng_booking_type_phase_pools p2
                 where p2.phase_id = wphase.id),
               array[]::text[]
             )
           )
           order by pp.phase_index
         ), '[]'::jsonb)
    into resolved_phases
    from public.lng_booking_type_phases pp
    -- For each parent phase, find the winning phase row using the
    -- chain order. The lateral subquery joins phase rows from any
    -- chain row to ordered_chain so we can sort by chain_pos.
    cross join lateral (
      with chain_for_phase as (
        select c.id as config_id,
          ((case when c.repair_variant is not null then 1 else 0 end) +
           (case when c.product_key is not null then 1 else 0 end) +
           (case when c.arch is not null then 1 else 0 end)) as specificity,
          ((case when c.repair_variant is not null then 100 else 0 end) +
           (case when c.product_key is not null then 10 else 0 end) +
           (case when c.arch is not null then 1 else 0 end)) as axis_priority
          from public.lng_booking_type_config c
         where c.service_type = p_service_type
           and (c.repair_variant is null or c.repair_variant = p_repair_variant)
           and (c.product_key   is null or c.product_key   = p_product_key)
           and (c.arch          is null or c.arch          = p_arch)
      )
      select wp.*
        from public.lng_booking_type_phases wp
        join chain_for_phase cp on cp.config_id = wp.config_id
       where wp.phase_index = pp.phase_index
       order by cp.specificity desc, cp.axis_priority desc
       limit 1
    ) wphase
   where pp.config_id = parent_row.id;

  -- Aggregated pool_ids (legacy field, used by callers that don't
  -- consume per-phase pools yet). Source: every distinct pool_id
  -- referenced by ANY phase in the parent's canvas — same behaviour
  -- as M12 since this field is informational only.
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

  -- Patient-facing window: same chain semantics as the scalar
  -- fields above. Falls through to block_total only when neither
  -- the chain nor parent define a min.
  select
    coalesce(
      (select oc.patient_facing_min_minutes from (
         select c.patient_facing_min_minutes,
           ((case when c.repair_variant is not null then 1 else 0 end) +
            (case when c.product_key is not null then 1 else 0 end) +
            (case when c.arch is not null then 1 else 0 end)) as specificity,
           ((case when c.repair_variant is not null then 100 else 0 end) +
            (case when c.product_key is not null then 10 else 0 end) +
            (case when c.arch is not null then 1 else 0 end)) as axis_priority
           from public.lng_booking_type_config c
          where c.service_type = p_service_type
            and (c.repair_variant is null or c.repair_variant = p_repair_variant)
            and (c.product_key   is null or c.product_key   = p_product_key)
            and (c.arch          is null or c.arch          = p_arch)
       ) oc
       where oc.patient_facing_min_minutes is not null
       order by oc.specificity desc, oc.axis_priority desc
       limit 1),
      nullif(block_total, 0)
    )
    into pf_min;

  select
    (select oc.patient_facing_max_minutes from (
       select c.patient_facing_max_minutes,
         ((case when c.repair_variant is not null then 1 else 0 end) +
          (case when c.product_key is not null then 1 else 0 end) +
          (case when c.arch is not null then 1 else 0 end)) as specificity,
         ((case when c.repair_variant is not null then 100 else 0 end) +
          (case when c.product_key is not null then 10 else 0 end) +
          (case when c.arch is not null then 1 else 0 end)) as axis_priority
         from public.lng_booking_type_config c
        where c.service_type = p_service_type
          and (c.repair_variant is null or c.repair_variant = p_repair_variant)
          and (c.product_key   is null or c.product_key   = p_product_key)
          and (c.arch          is null or c.arch          = p_arch)
     ) oc
     where oc.patient_facing_max_minutes is not null
     order by oc.specificity desc, oc.axis_priority desc
     limit 1)
    into pf_max;

  return query
    select
      p_service_type,
      p_repair_variant,
      p_product_key,
      p_arch,
      coalesce(resolved_working_hours, parent_row.working_hours),
      coalesce(resolved_dur_min,       parent_row.duration_min),
      coalesce(resolved_dur_max,       parent_row.duration_max),
      coalesce(resolved_dur_default,   parent_row.duration_default),
      coalesce(resolved_max_concurrent,parent_row.max_concurrent),
      pools,
      coalesce(resolved_notes,         parent_row.notes),
      source_label,
      resolved_phases,
      nullif(block_total, 0),
      pf_min,
      pf_max;
end;
$$;

revoke all on function public.lng_booking_type_resolve(text, text, text, text) from public;
grant execute on function public.lng_booking_type_resolve(text, text, text, text) to authenticated;

comment on function public.lng_booking_type_resolve(text, text, text, text) is
  'Returns the effective booking-type config. Implements ADR-007 chain semantics: builds candidate set (rows that match every pinned axis), sorts by (specificity DESC, axis-priority DESC), and walks for each scalar field (first non-null wins). Phase resolution is row-level per phase_index, sourcing the winning row from the chain. Backwards compatible with M12 single-axis rows (chain length 2 = identical output).';

-- ── Rollback ────────────────────────────────────────────────────
--
-- alter table public.lng_booking_type_config
--   add constraint at_most_one_child_key check (
--     (case when repair_variant is not null then 1 else 0 end +
--      case when product_key    is not null then 1 else 0 end +
--      case when arch           is not null then 1 else 0 end) <= 1
--   );
-- (and revert the resolver to the M12 implementation, see
--  20260503000012_lng_phase_full_override.sql).
