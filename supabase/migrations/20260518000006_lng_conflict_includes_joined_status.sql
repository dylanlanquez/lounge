-- 20260518000006_lng_conflict_includes_joined_status.sql
--
-- 'joined' is the virtual-flow analogue of 'arrived' (added in
-- 20260506000017). Once staff (or the patient) opens the Meet link,
-- markVirtualMeetingJoined() flips the appointment status from
-- 'booked' to 'joined'. From that moment forward the appointment
-- still consumes its pools, still occupies its slot — it's
-- conceptually "in progress, virtual edition".
--
-- But the conflict-prevention machinery was written before 'joined'
-- existed. Every "active appointment" filter still reads
--
--   status in ('booked', 'arrived', 'in_progress')
--
-- — 'joined' falls outside, so a joined virtual appointment is
-- invisible to:
--   * lng_booking_check_conflict          → another booking can
--     be scheduled on top of it without raising a conflict.
--   * lng_appointments_overlap_guard      → the DB-level guard
--     won't catch the resulting overlap either.
--   * lng_appointments_overlap_idx        → the partial index
--     skips joined rows, so queries that read it from a non-RPC
--     path miss them.
--
-- This is exactly the bug Dylan hit on /schedule: open the New
-- Booking sheet, pick the same time as a joined virtual booking,
-- pass conflict check, save successfully. The staff-side picker
-- has been silently disagreeing with every other surface that
-- still treats joined appointments as active.
--
-- The fix is structural: everywhere the codebase asks "which
-- appointments are active?", include 'joined'. 'in_progress' was
-- retired in 20260505000004 so it's safe to drop from these
-- filters in the same pass (no row can ever have that value
-- anymore — the column's CHECK constraint forbids it). Keeping it
-- would be misleading dead code.
--
-- Ripple effects fixed in one migration:
--   1. lng_booking_check_conflict — both phase-level pool count
--      AND whole-appointment max_concurrent count include joined.
--   2. lng_appointments_overlap_guard_trg — the trigger that
--      enforces overlap prevention at the DB level now treats
--      joined as active.
--   3. lng_materialise_appointment_phases — when the appointment
--      flips to 'joined' the phase rows should read as in_progress
--      (the meeting IS happening), so the materialiser's
--      initial_status mapping picks up 'joined'.
--   4. lng_appointments_materialise_phases_trg — re-materialise on
--      terminal → joined transitions for the reverse-no-show /
--      reverse-cancel path on virtual rows.
--   5. lng_appointments_overlap_idx — partial-where rebuilt to
--      include 'joined' so any future query that reads the index
--      sees joined rows.
--
-- Idempotent: every CREATE is OR REPLACE, every CREATE INDEX uses
-- IF NOT EXISTS after an explicit DROP. Safe to re-run.

-- ── 1. lng_booking_check_conflict ─────────────────────────────────
drop function if exists public.lng_booking_check_conflict(uuid, text, timestamptz, timestamptz, uuid, text, text, text);

create or replace function public.lng_booking_check_conflict(
  p_location_id            uuid,
  p_service_type           text,
  p_start_at               timestamptz,
  p_end_at                 timestamptz,
  p_exclude_appointment_id uuid default null,
  p_repair_variant         text default null,
  p_product_key            text default null,
  p_arch                   text default null
)
returns table (
  conflict_kind     text,
  pool_id           text,
  pool_capacity     int,
  current_count     int,
  phase_index       int,
  phase_label       text,
  conflict_start_at timestamptz,
  conflict_end_at   timestamptz
)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  resolved              record;
  phase                 jsonb;
  cursor_at             timestamptz;
  next_at               timestamptz;
  phase_dur             int;
  max_phase_idx         int;
  pool_text             text;
  pool_cap              int;
  cnt                   int;
  max_concurrent_for_s  int;
begin
  select phases, block_duration_minutes
    into resolved
    from public.lng_booking_type_resolve(
      p_service_type, p_repair_variant, p_product_key, p_arch
    );

  if resolved.phases is null
     or jsonb_array_length(resolved.phases) = 0 then
    return;
  end if;

  select max((elt->>'phase_index')::int)
    into max_phase_idx
    from jsonb_array_elements(resolved.phases) elt;

  cursor_at := p_start_at;

  for phase in select elt
                 from jsonb_array_elements(resolved.phases) elt
                order by (elt->>'phase_index')::int
  loop
    phase_dur := coalesce((phase->>'duration_default')::int, 0);

    if (phase->>'phase_index')::int = max_phase_idx then
      next_at := p_end_at;
    else
      next_at := cursor_at + (phase_dur * interval '1 minute');
      if next_at > p_end_at then
        next_at := p_end_at;
      end if;
    end if;

    if next_at <= cursor_at then
      exit;
    end if;

    for pool_text in
      select value
        from jsonb_array_elements_text(phase->'pool_ids')
    loop
      select capacity into pool_cap
        from public.lng_booking_resource_pools
       where id = pool_text;

      if pool_cap is null then
        continue;
      end if;

      -- ↳ active set now includes 'joined' (virtual analogue of
      --   'arrived'). Without this, a joined virtual booking is
      --   invisible to the conflict checker and another booking can
      --   be scheduled on top of it.
      select count(*) into cnt
        from public.lng_appointment_phases ap
        join public.lng_appointments a on a.id = ap.appointment_id
       where a.location_id = p_location_id
         and a.status in ('booked', 'arrived', 'joined')
         and ap.status in ('pending', 'in_progress')
         and (p_exclude_appointment_id is null or a.id <> p_exclude_appointment_id)
         and ap.start_at < next_at
         and ap.end_at   > cursor_at
         and pool_text   = any(ap.pool_ids);

      if cnt + 1 > pool_cap then
        conflict_kind     := 'pool_at_capacity';
        pool_id           := pool_text;
        pool_capacity     := pool_cap;
        current_count     := cnt;
        phase_index       := (phase->>'phase_index')::int;
        phase_label       := phase->>'label';
        conflict_start_at := cursor_at;
        conflict_end_at   := next_at;
        return next;
      end if;
    end loop;

    cursor_at := next_at;
    exit when cursor_at >= p_end_at;
  end loop;

  -- Whole-appointment max_concurrent — same status-set fix.
  select c.max_concurrent into max_concurrent_for_s
    from public.lng_booking_type_config c
   where c.service_type    = p_service_type
     and c.repair_variant is null
     and c.product_key    is null
     and c.arch           is null
   limit 1;

  if max_concurrent_for_s is not null then
    select count(*) into cnt
      from public.lng_appointments a
     where a.location_id  = p_location_id
       and a.start_at    <  p_end_at
       and a.end_at      >  p_start_at
       and a.status in ('booked', 'arrived', 'joined')
       and a.service_type = p_service_type
       and (p_exclude_appointment_id is null or a.id <> p_exclude_appointment_id);
    if cnt + 1 > max_concurrent_for_s then
      conflict_kind     := 'max_concurrent';
      pool_id           := null;
      pool_capacity     := max_concurrent_for_s;
      current_count     := cnt;
      phase_index       := null;
      phase_label       := null;
      conflict_start_at := p_start_at;
      conflict_end_at   := p_end_at;
      return next;
    end if;
  end if;

  return;
end;
$$;

revoke all on function public.lng_booking_check_conflict(uuid, text, timestamptz, timestamptz, uuid, text, text, text) from public;
grant execute on function public.lng_booking_check_conflict(uuid, text, timestamptz, timestamptz, uuid, text, text, text) to authenticated;

comment on function public.lng_booking_check_conflict(uuid, text, timestamptz, timestamptz, uuid, text, text, text) is
  'Phase-aware booking conflict checker. Active appointments = status in (booked, arrived, joined). joined was added in 20260518000006 — before that the virtual analogue of arrived was invisible to overlap detection. See ADR-006.';


-- ── 2. lng_appointments_overlap_guard_trg ─────────────────────────
create or replace function public.lng_appointments_overlap_guard_trg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  conflict_count int;
  conflicts_json jsonb;
  is_walkin      boolean;
  is_calendly    boolean;
begin
  -- joined is the virtual analogue of arrived — both consume pools.
  if new.status not in ('booked', 'arrived', 'joined') then
    return new;
  end if;

  if new.service_type is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext(new.location_id::text)::bigint);

  select count(*) filter (where conflict_kind is not null),
         coalesce(
           jsonb_agg(
             jsonb_build_object(
               'conflict_kind',     conflict_kind,
               'pool_id',           pool_id,
               'pool_capacity',     pool_capacity,
               'current_count',     current_count,
               'phase_index',       phase_index,
               'phase_label',       phase_label,
               'conflict_start_at', conflict_start_at,
               'conflict_end_at',   conflict_end_at
             )
           ) filter (where conflict_kind is not null),
           '[]'::jsonb
         )
    into conflict_count, conflicts_json
    from public.lng_booking_check_conflict(
      new.location_id,
      new.service_type,
      new.start_at,
      new.end_at,
      new.id,
      new.repair_variant,
      new.product_key,
      new.arch
    );

  if conflict_count = 0 then
    return new;
  end if;

  is_walkin   := new.walk_in_id is not null;
  is_calendly := new.source = 'calendly';

  if is_walkin or is_calendly then
    insert into public.lng_system_failures (severity, source, message, context)
    values (
      'warning',
      'lng_appointments_overlap_guard',
      case
        when is_walkin   then 'Walk-in saved despite overlap with an existing booking'
        when is_calendly then 'Calendly booking saved despite overlap with an existing booking'
      end,
      jsonb_build_object(
        'appointment_id', new.id,
        'patient_id',     new.patient_id,
        'service_type',   new.service_type,
        'start_at',       new.start_at,
        'end_at',         new.end_at,
        'source',         new.source,
        'walk_in_id',     new.walk_in_id,
        'conflicts',      conflicts_json
      )
    );
    return new;
  end if;

  raise exception 'OVERLAP: appointment % overlaps an existing booking. Conflicts: %', new.id, conflicts_json
    using errcode = '23P01';
end;
$$;

comment on function public.lng_appointments_overlap_guard_trg() is
  'AFTER INSERT/UPDATE constraint trigger on lng_appointments. Acquires a per-location pg_advisory_xact_lock, then re-runs lng_booking_check_conflict. Active set = booked / arrived / joined (joined added in 20260518000006). Walk-in / Calendly bypasses log to lng_system_failures with severity warning instead of raising; everything else raises with SQLSTATE 23P01.';


-- ── 3. lng_materialise_appointment_phases ─────────────────────────
-- Initial-status mapping picks up 'joined' so phase 1 reads as
-- in_progress when the appointment is mid-meeting (matches the
-- behaviour for arrived in-person rows).
create or replace function public.lng_materialise_appointment_phases(
  p_appointment_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  appt              public.lng_appointments;
  resolved          record;
  phase             jsonb;
  cursor_at         timestamptz;
  next_at           timestamptz;
  phase_dur         int;
  total_phase_min   int;
  appt_block_min    int;
  drift_min         int;
  max_phase_index   int;
  initial_status    text;
  any_inserted      boolean := false;
begin
  select * into appt
    from public.lng_appointments
   where id = p_appointment_id;

  if not found then
    return;
  end if;

  if appt.status in ('cancelled', 'no_show', 'complete', 'rescheduled') then
    return;
  end if;

  if appt.service_type is null then
    insert into public.lng_system_failures (severity, source, message, context)
    values (
      'warning',
      'lng_materialise_appointment_phases',
      'Appointment has no service_type, phase materialisation skipped',
      jsonb_build_object('appointment_id', appt.id, 'status', appt.status)
    );
    return;
  end if;

  select phases, block_duration_minutes
    into resolved
    from public.lng_booking_type_resolve(appt.service_type);

  if resolved.phases is null
     or jsonb_array_length(resolved.phases) = 0 then
    insert into public.lng_system_failures (severity, source, message, context)
    values (
      'error',
      'lng_materialise_appointment_phases',
      'Booking type has no phase rows, phase materialisation skipped',
      jsonb_build_object(
        'appointment_id', appt.id,
        'service_type',   appt.service_type
      )
    );
    return;
  end if;

  total_phase_min := coalesce(resolved.block_duration_minutes, 0);
  appt_block_min  := greatest(extract(epoch from (appt.end_at - appt.start_at)) / 60, 0)::int;
  drift_min       := total_phase_min - appt_block_min;

  if abs(drift_min) > 5 then
    insert into public.lng_system_failures (severity, source, message, context)
    values (
      'warning',
      'lng_materialise_appointment_phases',
      'Phase duration sum diverges from appointment block by more than 5 minutes',
      jsonb_build_object(
        'appointment_id',     appt.id,
        'service_type',       appt.service_type,
        'phase_total_minutes', total_phase_min,
        'appointment_block_minutes', appt_block_min,
        'drift_minutes',      drift_min
      )
    );
  end if;

  delete from public.lng_appointment_phases
   where appointment_id = appt.id;

  -- ↳ 'joined' added: the meeting IS happening, treat phase 1 as
  --   in_progress just like an arrived in-person row.
  initial_status := case
    when appt.status in ('arrived', 'joined') then 'in_progress'
    else 'pending'
  end;

  select max((elt->>'phase_index')::int)
    into max_phase_index
    from jsonb_array_elements(resolved.phases) elt;

  cursor_at := appt.start_at;

  for phase in select elt
                 from jsonb_array_elements(resolved.phases) elt
                order by (elt->>'phase_index')::int
  loop
    phase_dur := coalesce((phase->>'duration_default')::int, 0);

    if (phase->>'phase_index')::int = max_phase_index then
      next_at := appt.end_at;
      if next_at <= cursor_at then
        insert into public.lng_system_failures (severity, source, message, context)
        values (
          'error',
          'lng_materialise_appointment_phases',
          'Non-final phases consumed the entire appointment block, final phase has no time',
          jsonb_build_object(
            'appointment_id', appt.id,
            'phase',          phase,
            'cursor_at',      cursor_at,
            'appt_end_at',    appt.end_at
          )
        );
        continue;
      end if;
    else
      if phase_dur <= 0 then
        insert into public.lng_system_failures (severity, source, message, context)
        values (
          'warning',
          'lng_materialise_appointment_phases',
          'Phase has non-positive duration_default, skipped',
          jsonb_build_object(
            'appointment_id', appt.id,
            'phase',          phase
          )
        );
        continue;
      end if;
      next_at := cursor_at + (phase_dur * interval '1 minute');

      if next_at >= appt.end_at then
        next_at := appt.end_at;
        insert into public.lng_system_failures (severity, source, message, context)
        values (
          'warning',
          'lng_materialise_appointment_phases',
          'Phase config overruns appointment block, non-final phase trimmed to fit',
          jsonb_build_object(
            'appointment_id', appt.id,
            'phase',          phase,
            'appt_end_at',    appt.end_at
          )
        );
      end if;
    end if;

    insert into public.lng_appointment_phases (
      appointment_id, phase_index, label, patient_required,
      pool_ids, start_at, end_at, status
    ) values (
      appt.id,
      (phase->>'phase_index')::int,
      phase->>'label',
      (phase->>'patient_required')::boolean,
      coalesce(
        (select array_agg(value)
           from jsonb_array_elements_text(phase->'pool_ids')),
        array[]::text[]
      ),
      cursor_at,
      next_at,
      case when (phase->>'phase_index')::int = 1 then initial_status else 'pending' end
    );

    any_inserted := true;
    cursor_at := next_at;

    exit when cursor_at >= appt.end_at;
  end loop;

  if not any_inserted then
    insert into public.lng_system_failures (severity, source, message, context)
    values (
      'error',
      'lng_materialise_appointment_phases',
      'No phase rows inserted, every phase had non-positive duration',
      jsonb_build_object(
        'appointment_id', appt.id,
        'service_type',   appt.service_type
      )
    );
  end if;
end;
$$;


-- Trigger wrapper — include 'joined' in the terminal→active list so
-- a reverse-no-show on a virtual row materialises its phases back.
create or replace function public.lng_appointments_materialise_phases_trg()
returns trigger
language plpgsql
security invoker
as $$
begin
  if tg_op = 'INSERT' then
    perform public.lng_materialise_appointment_phases(new.id);
  elsif tg_op = 'UPDATE' then
    if   new.start_at     is distinct from old.start_at
      or new.service_type is distinct from old.service_type
      or (
        old.status in ('cancelled', 'no_show', 'complete', 'rescheduled')
        and new.status in ('booked', 'arrived', 'joined')
      )
    then
      perform public.lng_materialise_appointment_phases(new.id);
    end if;
  end if;
  return new;
end;
$$;


-- ── 4. lng_appointments_overlap_idx — include 'joined' ────────────
-- The partial index's WHERE clause must match the conflict-query
-- predicate to be useful. Replacing the index is the only way to
-- change the WHERE clause; drop-then-create inside one statement
-- so the optimiser never sees a window without it.
drop index if exists public.lng_appointments_overlap_idx;
create index lng_appointments_overlap_idx
  on public.lng_appointments (location_id, start_at, end_at)
  where status in ('booked', 'arrived', 'joined');

-- ── Rollback ──────────────────────────────────────────────────────
-- Re-apply 20260503000006 (conflict checker), 20260518000003
-- (overlap guard), 20260503000005 (materialiser + trigger), and
-- 20260501000005 (overlap index).
