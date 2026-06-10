-- 20260610000004_lng_closures.sql
--
-- Clinic closures / blocked dates per booking type. Lets an admin block
-- out whole days (holidays, clinic closed) so NO surface can take a
-- booking on them: public widgets, Lounge new-booking, reschedule,
-- self-serve manage, and Checkpoint (which books through the same
-- widget-create edge function).
--
-- Model (agreed with Dylan, 10 Jun 2026):
--   • Whole-day only.
--   • A closure with service_type = NULL is a WHOLE-CLINIC closure: it
--     blocks every IN-PERSON booking type. It deliberately does NOT
--     touch virtual_impression_appointment — those run off a separate
--     (Cairo) clinician team on their own calendar, managed via the
--     clinician day-off overrides. Customers must never learn the
--     virtual location, so closure reasons are admin-only.
--   • A closure with a specific service_type blocks just that type
--     (including an explicit 'virtual_impression_appointment' closure
--     when the Cairo team is off too).
--
-- Enforcement is layered so a closed date is unbookable everywhere:
--   1. lng_booking_check_conflict emits a 'closed' row → every in-person
--      slot scanner (which calls it per candidate) returns no slots, the
--      date pickers (which delegate to those scanners) drop the day, and
--      every create/reschedule path (which calls it pre-insert) refuses.
--   2. lng_virtual_available_slots early-returns on an explicit virtual
--      closure → virtual slot + date pickers drop the day.
--   3. The lng_appointments overlap guard IGNORES 'closed' so closing a
--      date never breaks managing a booking already on it, and never
--      double-enforces what the create paths already block.
--   4. Calendly (its availability lives in Calendly, no pre-check here)
--      is handled in the webhook: it logs a system failure if a booking
--      lands on a closed date.
--
-- Apply order: shadow first (verify), then Meridian.
-- Rollback: drop the trigger-fn revert at the foot; re-apply
--   20260609000004 (check_conflict) + 20260609000006 (virtual slots) +
--   20260526000001 (overlap guard); drop lng_closures + its RPCs +
--   lng_is_closed.

-- ─────────────────────────────────────────────────────────────────
-- 1. Table
-- ─────────────────────────────────────────────────────────────────
create table if not exists public.lng_closures (
  id            uuid primary key default gen_random_uuid(),
  closed_date   date not null,
  -- NULL = whole clinic (all in-person types, NOT virtual). Otherwise
  -- one specific booking type.
  service_type  text,
  reason        text,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint lng_closures_service_type_chk check (
    service_type is null or service_type in (
      'denture_repair', 'click_in_veneers', 'same_day_appliance',
      'impression_appointment', 'virtual_impression_appointment', 'other'
    )
  )
);

comment on table public.lng_closures is
  'Whole-day clinic closures / blocked dates per booking type. service_type NULL = whole clinic (all in-person types, excludes virtual_impression_appointment which is a separate team); a value blocks just that type. reason is admin-only and must never be shown to customers. Enforced via lng_is_closed in lng_booking_check_conflict + lng_virtual_available_slots.';

-- One closure per (date, type); nulls not distinct so two whole-clinic
-- closures on the same date collapse to one (upsert target).
create unique index if not exists lng_closures_date_type_uniq
  on public.lng_closures (closed_date, service_type) nulls not distinct;
create index if not exists lng_closures_date_idx
  on public.lng_closures (closed_date);

alter table public.lng_closures enable row level security;
drop policy if exists lng_closures_select on public.lng_closures;
create policy lng_closures_select on public.lng_closures
  for select to authenticated using (true);
grant select on public.lng_closures to authenticated;
-- Writes go through the admin-gated RPCs below, not direct DML.

-- ─────────────────────────────────────────────────────────────────
-- 2. lng_is_closed — the single rule, reused by every enforcement point
-- ─────────────────────────────────────────────────────────────────
-- SECURITY DEFINER so the anon widget path (which reaches the checker
-- through SECURITY DEFINER scanners) can evaluate it without a table
-- grant. p_date is the clinic-local (Europe/London) calendar date.
create or replace function public.lng_is_closed(
  p_service_type text,
  p_date         date
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.lng_closures c
     where c.closed_date = p_date
       and (
         c.service_type = p_service_type
         -- Whole-clinic closure: every in-person type, but NOT virtual.
         or (c.service_type is null
             and p_service_type is distinct from 'virtual_impression_appointment')
       )
  );
$$;
revoke all on function public.lng_is_closed(text, date) from public;
grant execute on function public.lng_is_closed(text, date) to anon, authenticated, service_role;
comment on function public.lng_is_closed(text, date) is
  'True when a booking of p_service_type on the clinic-local date p_date is blocked by lng_closures. Whole-clinic closures (service_type null) match every in-person type but never virtual_impression_appointment.';

-- ─────────────────────────────────────────────────────────────────
-- 3. Admin write RPCs (mirror lng_add/delete_clinician_override)
-- ─────────────────────────────────────────────────────────────────
create or replace function public.lng_add_closure(
  p_closed_date  date,
  p_service_type text default null,
  p_reason       text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Only admins can add closures' using errcode = '42501';
  end if;
  if p_service_type is not null and p_service_type not in (
       'denture_repair', 'click_in_veneers', 'same_day_appliance',
       'impression_appointment', 'virtual_impression_appointment', 'other'
     ) then
    raise exception 'Unknown service_type %', p_service_type using errcode = '22023';
  end if;

  insert into public.lng_closures (closed_date, service_type, reason, created_by)
  values (p_closed_date, p_service_type, nullif(btrim(coalesce(p_reason, '')), ''), auth.uid())
  on conflict (closed_date, service_type) do update
    set reason     = excluded.reason,
        updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;
revoke all on function public.lng_add_closure(date, text, text) from public;
grant execute on function public.lng_add_closure(date, text, text) to authenticated;

create or replace function public.lng_delete_closure(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can delete closures' using errcode = '42501';
  end if;
  delete from public.lng_closures where id = p_id;
end;
$$;
revoke all on function public.lng_delete_closure(uuid) from public;
grant execute on function public.lng_delete_closure(uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 4. lng_booking_check_conflict — add the closure gate
-- ─────────────────────────────────────────────────────────────────
-- Body reproduced verbatim from 20260609000004 with ONE addition: a
-- closure gate at the very top that emits conflict_kind = 'closed' and
-- returns. Signature unchanged.
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
  v_notice              int;
  v_earliest            timestamptz;
begin
  -- ── Closure gate (20260610000004) ──
  -- A whole-clinic closure (service_type null) blocks all in-person
  -- types but never virtual; an explicit per-type closure blocks just
  -- that type. Checked before anything else so a closed date is
  -- unbookable on every surface that calls this.
  if public.lng_is_closed(
       p_service_type,
       (timezone('Europe/London', p_start_at))::date
     ) then
    conflict_kind     := 'closed';
    pool_id           := null;
    pool_capacity     := null;
    current_count     := null;
    phase_index       := null;
    phase_label       := null;
    conflict_start_at := p_start_at;
    conflict_end_at   := p_end_at;
    return next;
    return;
  end if;

  select phases, block_duration_minutes, min_notice_minutes
    into resolved
    from public.lng_booking_type_resolve(
      p_service_type, p_repair_variant, p_product_key, p_arch
    );

  -- ── Notice gate (from 20260523000003) ──
  v_notice := coalesce(resolved.min_notice_minutes, 0);
  if v_notice > 0 then
    v_earliest := now() + make_interval(mins => v_notice);
    if p_start_at < v_earliest then
      conflict_kind     := 'min_notice';
      pool_id           := null;
      pool_capacity     := v_notice;
      current_count     := null;
      phase_index       := null;
      phase_label       := null;
      conflict_start_at := now();
      conflict_end_at   := v_earliest;
      return next;
      return;
    end if;
  end if;

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

      -- active set includes 'joined' (restored — see 20260609000004).
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

  -- Whole-appointment max_concurrent — same status set.
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
  'Phase-aware booking conflict checker. Emits closed (clinic closure / blocked date, checked first), min_notice, pool_at_capacity, max_concurrent. Active appointments = status in (booked, arrived, joined). closed gate added 20260610000004.';

-- ─────────────────────────────────────────────────────────────────
-- 5. lng_virtual_available_slots — early-return on explicit virtual closure
-- ─────────────────────────────────────────────────────────────────
-- Body reproduced verbatim from 20260609000006 with ONE addition: an
-- early return when an explicit virtual_impression_appointment closure
-- covers the date (whole-clinic closures never apply to virtual, so they
-- aren't checked here). Signature unchanged.
create or replace function public.lng_virtual_available_slots(
  p_date                   date,
  p_duration               int,
  p_step_minutes           int,
  p_earliest_start         timestamptz,
  p_exclude_appointment_id uuid    default null,
  p_self_serve_only        boolean default true,
  p_staff_member_id        uuid    default null
)
returns table (start_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_dow         int;
  v_min_start   time;
  v_max_end     time;
  v_open_total  int;
  v_close_total int;
  v_minute      int;
  v_cand_start  timestamptz;
  v_cand_end    timestamptz;
begin
  if p_duration is null or p_duration <= 0 then
    return;
  end if;

  -- Explicit virtual-impression closure blocks the whole day. Whole-clinic
  -- closures don't reach virtual (the Cairo team is a separate calendar).
  if exists (
    select 1 from public.lng_closures c
     where c.closed_date = p_date
       and c.service_type = 'virtual_impression_appointment'
  ) then
    return;
  end if;

  v_dow := ((extract(dow from p_date)::int + 6) % 7);

  -- Bounding window for the day across candidate clinicians' weekly
  -- windows and 'available' overrides.
  select min(s), max(e)
    into v_min_start, v_max_end
    from (
      select wh.start_local as s, wh.end_local as e
        from public.lng_clinician_hours wh
        join public.lng_staff_members sm on sm.id = wh.staff_member_id
       where sm.is_virtual_impression_clinician = true and sm.status = 'active'
         and (not p_self_serve_only or sm.clinician_self_serve)
         and (p_staff_member_id is null or sm.id = p_staff_member_id)
         and wh.day_of_week = v_dow
      union all
      select o.start_local, o.end_local
        from public.lng_clinician_overrides o
        join public.lng_staff_members sm on sm.id = o.staff_member_id
       where sm.is_virtual_impression_clinician = true and sm.status = 'active'
         and (not p_self_serve_only or sm.clinician_self_serve)
         and (p_staff_member_id is null or sm.id = p_staff_member_id)
         and o.override_date = p_date and o.kind = 'available'
    ) w;

  if v_min_start is null then
    return;
  end if;

  v_open_total  := extract(hour from v_min_start)::int * 60 + extract(minute from v_min_start)::int;
  v_close_total := extract(hour from v_max_end)::int * 60 + extract(minute from v_max_end)::int;

  v_minute := v_open_total;
  while v_minute + p_duration <= v_close_total loop
    v_cand_start := timezone('Europe/London', (p_date + make_time(v_minute / 60, v_minute % 60, 0))::timestamp);
    v_cand_end := v_cand_start + make_interval(mins => p_duration);
    if v_cand_start >= p_earliest_start
       and exists (
         select 1 from public.lng_clinicians_available(
           v_cand_start, v_cand_end, p_self_serve_only, p_exclude_appointment_id, p_staff_member_id
         )
       )
    then
      start_at := v_cand_start;
      return next;
    end if;
    v_minute := v_minute + p_step_minutes;
  end loop;
  return;
end;
$$;
revoke all on function public.lng_virtual_available_slots(date, int, int, timestamptz, uuid, boolean, uuid) from public;
grant execute on function public.lng_virtual_available_slots(date, int, int, timestamptz, uuid, boolean, uuid) to anon, authenticated, service_role;
comment on function public.lng_virtual_available_slots(date, int, int, timestamptz, uuid, boolean, uuid) is
  'Clinician-aware slot generator for virtual_impression_appointment. Returns nothing on a date with an explicit virtual closure (20260610000004). Emits each step where >=1 clinician is on shift and free.';

-- ─────────────────────────────────────────────────────────────────
-- 6. Overlap guard — ignore the 'closed' kind
-- ─────────────────────────────────────────────────────────────────
-- Reproduced from 20260526000001 with one change: the conflict count /
-- aggregation now filter out conflict_kind = 'closed'. Closing a date
-- must never block managing a booking already on it (e.g. marking it
-- arrived), and new bookings are already refused by the create paths'
-- own check_conflict call; this trigger stays a pure overlap backstop.
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
  if new.status not in ('booked', 'arrived', 'joined') then
    return new;
  end if;

  if new.service_type is null then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and old.status in ('no_show', 'cancelled', 'rescheduled') then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext(new.location_id::text)::bigint);

  select count(*) filter (where conflict_kind is not null and conflict_kind <> 'closed'),
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
           ) filter (where conflict_kind is not null and conflict_kind <> 'closed'),
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
  'AFTER INSERT/UPDATE constraint trigger on lng_appointments. Re-runs lng_booking_check_conflict (excluding the closed kind, which closures enforce at the create paths instead). Walk-in / Calendly bypasses log; everything else raises 23P01. closed exclusion added 20260610000004.';

NOTIFY pgrst, 'reload schema';
