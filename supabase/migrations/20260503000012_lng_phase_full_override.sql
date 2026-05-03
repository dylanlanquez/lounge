-- 20260503000012_lng_phase_full_override.sql
--
-- Loosens the override model so a child config row's phase override
-- can change ANY phase field (label, patient_required, durations,
-- pool consumption), not just durations + label. Per Dylan's
-- product call, real-world child variants sometimes need a different
-- staffing model (e.g. an arch override might skip a specific
-- resource a typical impression needs) and the original ADR-006
-- §6.3.3 lock-down was over-prescriptive.
--
-- ── New semantics ────────────────────────────────────────────────
-- The presence of a child phase row at (config_id_of_child,
-- phase_index) is the override signal. When a child phase row
-- exists, the resolver returns ALL of that row's fields verbatim —
-- including its own pool list looked up via lng_booking_type_phase_
-- pools keyed on the child's phase id. When no child row exists,
-- the parent's phase row is returned wholesale.
--
-- This replaces the previous field-by-field coalesce semantics:
--
--   OLD:   label = coalesce(child.label_override, parent.label)
--          patient_required = parent.patient_required (always)
--          durations = coalesce(child.duration_*, parent.duration_*)
--          pool_ids = parent's pool list (always)
--
--   NEW:   if child row exists:
--            label / patient_required / durations / pool_ids = child's
--          else:
--            all fields from parent's phase row
--
-- ── Migration path for label_override ───────────────────────────
-- The label_override column was added in M10. Any non-null values
-- get copied into the `label` column on the child row before the
-- column is dropped, so child renames keep working under the new
-- model.
--
-- ── Backwards compat ────────────────────────────────────────────
-- Existing child phase rows (created via the previous editor) had
-- their label/patient_required/pool_ids copied from the parent at
-- insert time so they satisfied NOT NULL. Under the new resolver,
-- those rows already render correctly: the resolver just reads what
-- they have (which equals the parent at the time of creation).
-- The admin can edit the override to diverge from the parent any
-- time.
--
-- ── Idempotency ─────────────────────────────────────────────────
-- The label_override migrate-then-drop block uses a DO guard so
-- re-running is safe.

-- ── 1. Migrate any label_override values into label ─────────────
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'lng_booking_type_phases'
       and column_name = 'label_override'
  ) then
    update public.lng_booking_type_phases
       set label = label_override
     where label_override is not null
       and length(trim(label_override)) > 0;
    alter table public.lng_booking_type_phases drop column label_override;
  end if;
end$$;

-- ── 2. Resolver — row-level override semantics ─────────────────
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

  -- Resolved phase array. For each parent phase, look for a child
  -- phase row at the same phase_index. If found, the child's row
  -- is the source of truth for everything (label, patient state,
  -- durations, pool consumption). If not found, the parent's row
  -- stands.
  --
  -- Pool consumption follows the same rule: when a child phase
  -- exists, its pool list (from lng_booking_type_phase_pools keyed
  -- on the CHILD phase id) is returned. When it doesn't, the
  -- parent's pool list.
  select coalesce(jsonb_agg(
           jsonb_build_object(
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

  -- Aggregated pool_ids (legacy field) — sourced from phase pools.
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
  'Returns the effective booking-type config. Phase overrides are row-level: when a child phase row exists at a given phase_index, ALL its fields (label, patient_required, durations, pool consumption) are returned in place of the parent''s phase row. When no child row exists for that phase_index, the parent''s row stands wholesale. See ADR-006 (updated semantics in M12).';

-- ── Rollback ────────────────────────────────────────────────────
-- alter table public.lng_booking_type_phases
--   add column if not exists label_override text
--     check (label_override is null or length(trim(label_override)) > 0);
-- Re-apply 20260503000011_lng_drop_service_pools.sql to restore the
-- previous field-by-field coalesce resolver.
