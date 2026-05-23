-- 20260523000001_lng_booking_type_min_notice.sql
--
-- Per-booking-type "minimum notice" — the earliest a new appointment
-- can sit relative to "now". Virtual impression appointments need it
-- so the patient can't book the 1:15pm video call at 1:00pm and find
-- nobody on the other end of the meet link.
--
-- Data model: a nullable int column on lng_booking_type_config that
-- behaves like the other inherited fields (working_hours, durations,
-- max_concurrent, patient_facing_*):
--
--   • NULL on a parent row → no notice required (today's behaviour).
--   • Positive int on a parent row → patients can only book ≥ N min
--     from now.
--   • NULL on a child override → inherit the parent's value.
--   • Positive int on a child override → use this instead of parent.
--
-- The slot scanners (lng_widget_available_slots, lng_booking_available
-- _slots) read this through the resolver and skip candidates that fall
-- inside the notice window. The conflict checker enforces the same
-- rule at submit time so a direct RPC caller can't bypass the picker.
-- This migration adds the column + threads it through the resolver
-- only — the scanner changes ship in 20260523000002, the conflict
-- check in 20260523000003.
--
-- Apply order: shadow first (vkgghplhykavklevfhkz), then Meridian
-- (npuvhxakffxqoszytkxw). See docs/runbooks/migration-workflow.md.
--
-- Rollback:
--   alter table public.lng_booking_type_config drop column if exists min_notice_minutes;
--   then re-apply 20260517000007_lng_resolver_child_extra_phases.sql
--   to restore the prior resolver signature.

-- ── 1. Column ─────────────────────────────────────────────────────
alter table public.lng_booking_type_config
  add column if not exists min_notice_minutes int
    check (min_notice_minutes is null or min_notice_minutes >= 0);

comment on column public.lng_booking_type_config.min_notice_minutes is
  'Optional minimum notice in minutes between "now" and the earliest bookable slot for this booking type. NULL on parent = no notice required. NULL on child = inherit parent. The slot scanners and conflict checker both enforce it so every booking surface (widget, staff sheets, Checkpoint, self-serve) gates on the same value.';

-- ── 2. Resolver ───────────────────────────────────────────────────
-- Re-create lng_booking_type_resolve so the resolved row carries the
-- effective min_notice_minutes. Function body is otherwise identical
-- to 20260517000007 — only the RETURNS TABLE shape grows by one
-- column (appended at the end so positional readers like the
-- materialiser stay aligned) and the final select COALESCEs child
-- over parent for the new field.

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
  patient_facing_max_minutes      int,
  min_notice_minutes              int
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
  notice                int;
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

  -- Resolved phase array. Two sources combined, identical to M17:
  --
  --   1. Every parent phase, with the matching child phase row
  --      replacing all fields wholesale when present (M12 row-level
  --      override).
  --   2. Every child phase whose phase_index is NOT present on the
  --      parent — variant-only steps the parent doesn't have. All
  --      fields come from the child row directly.
  select coalesce(jsonb_agg(elt order by (elt->>'phase_index')::int), '[]'::jsonb)
    into resolved_phases
    from (
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
  -- pools only. Same as M12 / M17.
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

  -- Notice: child wins when set, else parent. Stays NULL when
  -- neither side sets it — the slot scanners coalesce(NULL, 0) so a
  -- missing value means "no gate", matching today's behaviour.
  notice := coalesce(
    child_row.min_notice_minutes,
    parent_row.min_notice_minutes
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
      pf_max                                                            as patient_facing_max_minutes,
      notice                                                            as min_notice_minutes;
end;
$$;

comment on function public.lng_booking_type_resolve(text, text, text, text) is
  'Phase + duration + pool resolver for a (service_type, repair_variant?, product_key?, arch?) axis pin. Returns the effective phase shape after applying child row-level overrides (M12) and any child-only phases (M17), plus the resolved min_notice_minutes (child over parent; null = no notice). Slot scanners and the conflict checker read the notice value from here.';
