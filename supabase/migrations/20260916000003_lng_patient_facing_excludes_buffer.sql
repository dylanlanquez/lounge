-- 20260916000003_lng_patient_facing_excludes_buffer.sql
--
-- Fixes a gap left by 20260915000002_lng_phase_buffer.sql. That
-- migration's own header said a buffer "holds resources... patients
-- never see it," and made sure the appointment-timeline email block
-- drops buffer phases from the rendered list. It never touched the
-- resolver's PATIENT-FACING DURATION NUMBER, though: when a config
-- row has no explicit patient_facing_min/max override, the resolver
-- fell back to block_total, the sum of every phase INCLUDING the
-- buffer. Dylan, 16 Sep 2026: voice calls are 10-minute slots with a
-- 5-minute buffer after, but the New voice call sheet said "15-minute
-- slot" and the confirmation email said "about 15 min" — both read
-- straight off that fallback.
--
-- Fix: sum only non-buffer phases into a second total
-- (patient_total) and fall back to THAT for patient_facing_min/max,
-- while block_total (drives the calendar slot width, still needs the
-- buffer) is untouched. Same production function body
-- (pg_get_functiondef, 16 Sep 2026) with that one change; nothing
-- else in it moves.
--
-- Affects every phase-driven booking type with a buffer phase and no
-- explicit patient_facing override, not just voice_call — currently
-- that is only voice_call, but the fix is general, matching the
-- feature's own intent.

begin;

CREATE OR REPLACE FUNCTION public.lng_booking_type_resolve(p_service_type text, p_repair_variant text DEFAULT NULL::text, p_product_key text DEFAULT NULL::text, p_arch text DEFAULT NULL::text)
 RETURNS TABLE(service_type text, repair_variant text, product_key text, arch text, working_hours jsonb, duration_min integer, duration_max integer, duration_default integer, max_concurrent integer, pool_ids text[], notes text, source text, phases jsonb, block_duration_minutes integer, patient_facing_min_minutes integer, patient_facing_max_minutes integer, min_notice_minutes integer)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  child_row             public.lng_booking_type_config;
  parent_row            public.lng_booking_type_config;
  pools                 text[];
  resolved_phases       jsonb;
  block_total           int;
  patient_total         int;
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
               'is_buffer',        pp.is_buffer,
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
               'is_buffer',        cp.is_buffer,
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

  -- Same sum, minus any phase flagged is_buffer — a buffer holds
  -- resources (block_total needs it for calendar slot width) but a
  -- patient never sees it, so it must not inflate what we tell them
  -- the appointment takes.
  select coalesce(sum((elt->>'duration_default')::int), 0)
    into patient_total
    from jsonb_array_elements(resolved_phases) elt
   where (elt->>'is_buffer')::boolean is not true;

  pf_min := coalesce(
    child_row.patient_facing_min_minutes,
    parent_row.patient_facing_min_minutes,
    nullif(patient_total, 0)
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
$function$;

commit;

-- ── Rollback ──────────────────────────────────────────────────────
-- Restore the pre-fix body (block_total-inclusive fallback) by
-- re-running 20260915000002_lng_phase_buffer.sql's function
-- definition for lng_booking_type_resolve.
