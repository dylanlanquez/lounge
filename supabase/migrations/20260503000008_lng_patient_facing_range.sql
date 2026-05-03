-- 20260503000008_lng_patient_facing_range.sql
--
-- Adds range support to the patient-facing duration. Today's single
-- column becomes the "min" (lower bound or fixed value); a new
-- optional max column lets the admin tell the patient "30 to 45
-- minutes" instead of pretending a variable booking is fixed.
--
-- ── Why ──────────────────────────────────────────────────────────
-- Click-in Veneers' lab fabrication varies 3 to 6 hours depending on
-- complexity. Telling the patient "your booking is 4 hours" is
-- either too short (under-promise broken) or too long (anchored
-- expectation). A real range is honest and operationally accurate.
-- Same shape applies to denture repairs that may take 15 to 30 min
-- to bench depending on damage.
--
-- ── Schema change ────────────────────────────────────────────────
-- Rename: patient_facing_duration_minutes → patient_facing_min_minutes.
-- The old single column was shipped in M3 (20260503000003) so the
-- rename has minimal blast radius — only the resolver function and
-- TS layer reference the old name and they're updated alongside.
--
-- Add: patient_facing_max_minutes int null. When null the value is
-- "fixed" — patient sees a single number. When set the patient sees
-- a range. Constraint enforces max ≥ min when both are set.
--
-- ── Resolver ─────────────────────────────────────────────────────
-- lng_booking_type_resolve returns both min and max as separate
-- fields with the standard child→parent fallback per field. The
-- legacy patient_facing_duration_minutes return field is dropped;
-- callers read patient_facing_min_minutes (and optionally max).
--
-- ── Idempotency ──────────────────────────────────────────────────
-- The rename uses IF EXISTS guards via a DO block so re-runs are
-- safe. ADD COLUMN IF NOT EXISTS for the max field. CREATE OR
-- REPLACE for the resolver. ALTER TABLE ADD CONSTRAINT IF NOT
-- EXISTS for the range constraint.

-- ── 1. Rename old column to be the min ───────────────────────────
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'lng_booking_type_config'
       and column_name = 'patient_facing_duration_minutes'
  ) then
    alter table public.lng_booking_type_config
      rename column patient_facing_duration_minutes to patient_facing_min_minutes;
  end if;
end$$;

-- ── 2. Add the max column ────────────────────────────────────────
alter table public.lng_booking_type_config
  add column if not exists patient_facing_max_minutes int
    check (patient_facing_max_minutes is null or patient_facing_max_minutes > 0);

-- ── 3. Range constraint: max >= min when both set ────────────────
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.lng_booking_type_config'::regclass
       and conname = 'patient_facing_range_order'
  ) then
    alter table public.lng_booking_type_config
      add constraint patient_facing_range_order
      check (
        patient_facing_min_minutes is null
        or patient_facing_max_minutes is null
        or patient_facing_max_minutes >= patient_facing_min_minutes
      );
  end if;
end$$;

comment on column public.lng_booking_type_config.patient_facing_min_minutes is
  'Lower bound (or fixed value when max is null) for what we tell the patient. Null on a child = inherit parent. Null on a parent = resolves to the derived block duration. Patient-comms only — never read by the conflict checker.';

comment on column public.lng_booking_type_config.patient_facing_max_minutes is
  'Optional upper bound. When set, the patient sees a range like "30 to 45 min" or "1 to 2 hours" instead of a single value. Null = fixed.';

-- ── 4. Update resolver: returns both min and max ─────────────────
-- Same parent-fallback logic as before, applied per field. The old
-- single-field name is removed from the return tuple.

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

  -- ── Legacy aggregated pool_ids field ──
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

  -- ── Patient-facing min: child wins, then parent, then derived
  --     block. Same fallback chain as before.
  pf_min := coalesce(
    child_row.patient_facing_min_minutes,
    parent_row.patient_facing_min_minutes,
    nullif(block_total, 0)
  );

  -- ── Patient-facing max: child wins, then parent. NO fallback to
  --     block — null max means "fixed value", not "no upper bound
  --     known". A range is an explicit admin choice.
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
  'Returns the effective booking-type config for (service, repair_variant?, product_key?, arch?). Phases array, block_duration_minutes, and the patient-facing min/max range with parent fallback per field. patient_facing_min_minutes falls back to block_duration when neither child nor parent set it; patient_facing_max_minutes is null unless explicitly set (a range is an opt-in admin choice). See ADR-006.';

-- ── Rollback ─────────────────────────────────────────────────────
-- Re-apply 20260503000004_lng_resolve_with_phases.sql to restore the
-- pre-range resolver. Then:
-- alter table public.lng_booking_type_config
--   drop constraint if exists patient_facing_range_order,
--   drop column if exists patient_facing_max_minutes;
-- Followed by renaming patient_facing_min_minutes back to
-- patient_facing_duration_minutes.
