-- 20260517000009_lng_slot_cart_aware.sql
--
-- Denture-repair carts can pile up multiple repair variants in one
-- appointment (Cracked + Relining + Add a tooth + …). Until this
-- migration the slot RPC + conflict check only knew about the FIRST
-- cart line's repair_variant — so a cart that included Relining
-- alongside any other variant would resolve to the first line's
-- phase shape, missing Relining's impression-clinician +
-- consult-room pool claims. The slot grid then showed times the
-- impression clinician was already busy.
--
-- Two pieces here:
--
--   1. lng_denture_repair_effective_variant(variants text[]) text
--      Picks the variant in the cart whose resolved phase shape
--      claims the most resource pools. Relining's Impression +
--      Try In phases claim {consult-room, impression-clinician} +
--      {consult-room, miscellaneous} (4 pool slots) while a
--      Cracked-only flow inherits only the parent's Try In phase
--      (2 slots). Relining wins — and that's the variant the slot
--      search resolves against.
--
--   2. lng_widget_available_slots gains a trailing optional
--      p_repair_variants text[] parameter. When supplied for a
--      denture_repair booking, the function feeds the array
--      through the helper above and uses the returned effective
--      variant for phase resolution + conflict checks. Legacy
--      callers (single-variant flows) keep working — when the
--      array is null/empty the function falls back to the
--      existing p_repair_variant param.
--
-- All other slot RPC behaviour (settings-driven opening hours,
-- breaks, past-time guard, exclude-appointment for reschedules,
-- phase-duration-fallback for virtual impressions) is preserved
-- byte-for-byte from M15-15006. Only the variant resolution at
-- the top of the function changes.
--
-- The same effective-variant computation is applied server-side
-- in widget-create-appointment so the persisted repair_variant
-- column matches what the slot RPC used; that keeps the conflict
-- check, materialise trigger, and future-availability search in
-- lockstep.
-- ─────────────────────────────────────────────────────────────────

create or replace function public.lng_denture_repair_effective_variant(
  p_variants text[]
)
returns text
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  best_variant text := null;
  best_score   int := -1;
  cur_variant  text;
  cur_score    int;
begin
  if p_variants is null or array_length(p_variants, 1) is null then
    return null;
  end if;

  foreach cur_variant in array p_variants
  loop
    if cur_variant is null or trim(cur_variant) = '' then
      continue;
    end if;

    select coalesce(
             sum(jsonb_array_length(coalesce(elt->'pool_ids', '[]'::jsonb))),
             0
           )::int
      into cur_score
      from jsonb_array_elements(
             (select phases
                from public.lng_booking_type_resolve(
                  'denture_repair', cur_variant, null, null
                ))
           ) elt;

    if cur_score > best_score then
      best_score   := cur_score;
      best_variant := cur_variant;
    end if;
  end loop;

  return best_variant;
end;
$$;

grant execute on function public.lng_denture_repair_effective_variant(text[])
  to anon, authenticated, service_role;

comment on function public.lng_denture_repair_effective_variant(text[]) is
  'Given an array of denture_repair repair_variants present in one cart, returns the variant whose resolved phase shape claims the most resource pools (the most restrictive). Used by the slot picker and appointment write path so multi-variant carts honour every variant''s pool requirements (notably Relining''s impression-clinician + consult-room).';

-- ── 2. cart-aware slot RPC ────────────────────────────────────────
-- Drop the variants that coexist in the DB right now: the 6-arg
-- legacy form and the 7-arg form with p_exclude_appointment_id.
-- Replace with a single canonical 8-arg form. supabase-js dispatches
-- by named-argument set so existing callers (with or without
-- p_exclude_appointment_id, with or without p_repair_variants)
-- continue to resolve to the new signature.

drop function if exists public.lng_widget_available_slots(uuid, text, date, text, text, text);
drop function if exists public.lng_widget_available_slots(uuid, text, date, text, text, text, uuid);
drop function if exists public.lng_widget_available_slots(uuid, text, date, text, text, text, text[]);

create or replace function public.lng_widget_available_slots(
  p_location_id            uuid,
  p_service_type           text,
  p_date                   date,
  p_repair_variant         text  default null,
  p_product_key            text  default null,
  p_arch                   text  default null,
  p_exclude_appointment_id uuid  default null,
  p_repair_variants        text[] default null
)
returns table(start_at timestamp with time zone)
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_resolved          record;
  v_duration          int;
  v_extent            int;
  v_dow               int;
  v_step_minutes      int := 15;
  v_cand_start        timestamptz;
  v_cand_end          timestamptz;
  v_close_at          timestamptz;
  v_break_start       timestamptz;
  v_break_end         timestamptz;
  v_has_conflict      boolean;
  v_location_id       uuid;
  v_hours_arr         jsonb;
  v_day               jsonb;
  v_open_text         text;
  v_close_text        text;
  v_break             jsonb;
  v_break_open        text;
  v_break_close       text;
  v_open_minutes      int;
  v_close_minutes     int;
  v_minute_of_day     int;
  v_now               timestamptz := current_timestamp;
  v_effective_variant text;
begin
  if p_location_id is null then
    select id into v_location_id
    from public.locations
    where type = 'lab' and is_venneir = true
    order by name asc
    limit 1;
    if v_location_id is null then
      return;
    end if;
  else
    v_location_id := p_location_id;
  end if;

  -- Cart-aware variant pick for denture_repair: when the caller
  -- supplied an array of variants in the cart, find the heaviest
  -- one (most pool claims) and use it for phase resolution. Legacy
  -- single-variant callers (or any non-denture_repair service)
  -- skip this branch and use p_repair_variant as before.
  if p_service_type = 'denture_repair'
     and p_repair_variants is not null
     and array_length(p_repair_variants, 1) is not null
  then
    v_effective_variant :=
      public.lng_denture_repair_effective_variant(p_repair_variants);
    if v_effective_variant is null then
      v_effective_variant := p_repair_variant;
    end if;
  else
    v_effective_variant := p_repair_variant;
  end if;

  select duration_default, block_duration_minutes
    into v_resolved
    from public.lng_booking_type_resolve(
      p_service_type,
      v_effective_variant,
      p_product_key,
      p_arch
    );
  -- Coalesce to phase-derived block when the parent's duration_default
  -- isn't set. Virtual-impression appointments and any other
  -- phase-driven service get their slot scan unblocked by this
  -- without changing per-row admin config.
  v_duration := coalesce(v_resolved.duration_default, v_resolved.block_duration_minutes);
  if v_resolved is null or v_duration is null then
    return;
  end if;
  v_extent := greatest(
    v_duration,
    coalesce(v_resolved.block_duration_minutes, v_duration)
  );

  select value into v_hours_arr
  from public.lng_settings
  where key = 'clinic.opening_hours' and location_id is null;

  if v_hours_arr is null or jsonb_typeof(v_hours_arr) <> 'array' or jsonb_array_length(v_hours_arr) <> 7 then
    v_hours_arr := jsonb_build_array(
      jsonb_build_object('open', '09:00', 'close', '18:00', 'break', jsonb_build_array('13:00', '14:00')),
      jsonb_build_object('open', '09:00', 'close', '18:00', 'break', jsonb_build_array('13:00', '14:00')),
      jsonb_build_object('open', '09:00', 'close', '18:00', 'break', jsonb_build_array('13:00', '14:00')),
      jsonb_build_object('open', '09:00', 'close', '18:00', 'break', jsonb_build_array('13:00', '14:00')),
      jsonb_build_object('open', '09:00', 'close', '18:00', 'break', jsonb_build_array('13:00', '14:00')),
      jsonb_build_object('open', '10:00', 'close', '16:00'),
      jsonb_build_object('closed', true)
    );
  end if;

  v_dow := extract(dow from p_date)::int;
  v_day := v_hours_arr -> ((v_dow + 6) % 7);

  if v_day is null or (v_day ? 'closed' and (v_day ->> 'closed')::boolean = true) then
    return;
  end if;

  v_open_text  := v_day ->> 'open';
  v_close_text := v_day ->> 'close';
  if v_open_text is null or v_close_text is null then
    return;
  end if;

  v_break := v_day -> 'break';
  if v_break is not null and jsonb_typeof(v_break) = 'array' and jsonb_array_length(v_break) = 2 then
    v_break_open  := v_break ->> 0;
    v_break_close := v_break ->> 1;
  else
    v_break_open  := null;
    v_break_close := null;
  end if;

  v_close_at := timezone('Europe/London', (p_date + v_close_text::time)::timestamp);
  if v_break_open is not null then
    v_break_start := timezone('Europe/London', (p_date + v_break_open::time)::timestamp);
    v_break_end   := timezone('Europe/London', (p_date + v_break_close::time)::timestamp);
  end if;

  v_open_minutes  := extract(hour from v_open_text::time)::int * 60
                   + extract(minute from v_open_text::time)::int;
  v_close_minutes := extract(hour from v_close_text::time)::int * 60
                   + extract(minute from v_close_text::time)::int;

  v_minute_of_day := v_open_minutes;
  while v_minute_of_day < v_close_minutes loop
    v_cand_start := timezone(
      'Europe/London',
      (p_date + make_interval(mins => v_minute_of_day))::timestamp
    );
    v_cand_end := v_cand_start + make_interval(mins => v_duration);

    -- Past-time guard: skip candidates whose start is already in
    -- the past. On future dates every slot is naturally after v_now
    -- and this is a no-op.
    if v_cand_start > v_now
       and v_cand_start + make_interval(mins => v_extent) <= v_close_at
       and (v_break_start is null or v_cand_start < v_break_start or v_cand_start >= v_break_end)
    then
      select exists (
        select 1
        from public.lng_booking_check_conflict(
          v_location_id,
          p_service_type,
          v_cand_start,
          v_cand_end,
          p_exclude_appointment_id,
          v_effective_variant,
          p_product_key,
          p_arch
        )
      ) into v_has_conflict;

      if not v_has_conflict then
        start_at := v_cand_start;
        return next;
      end if;
    end if;

    v_minute_of_day := v_minute_of_day + v_step_minutes;
  end loop;
  return;
end;
$function$;

revoke all on function public.lng_widget_available_slots(uuid, text, date, text, text, text, uuid, text[]) from public;
grant execute on function public.lng_widget_available_slots(uuid, text, date, text, text, text, uuid, text[]) to anon, authenticated, service_role;

comment on function public.lng_widget_available_slots(uuid, text, date, text, text, text, uuid, text[]) is
  'Customer widget slot resolver. Cart-aware: pass p_repair_variants for a denture_repair booking and the function uses lng_denture_repair_effective_variant() to resolve the most restrictive variant before phase / conflict resolution. Legacy single-variant callers and non-denture services keep working unchanged.';
