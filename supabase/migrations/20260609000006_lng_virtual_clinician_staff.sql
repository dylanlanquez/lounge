-- 20260609000006_lng_virtual_clinician_staff.sql
--
-- Re-homes "virtual impression clinician" from the Meet host onto the
-- STAFF member, per the agreed model:
--   * A clinician is a lng_staff_members row with
--     is_virtual_impression_clinician = true. That flag is the single
--     capability: it grants the in-call controls AND makes them a
--     bookable clinician.
--   * Their weekly hours, date overrides, and public/staff-only setting
--     live on the staff member (not the Meet host).
--   * The Meet host (Google account) drops back to being the room owner,
--     resolved at booking time (the clinician's own connected account or
--     a default). Availability + the no-double-book guard key on the
--     CLINICIAN, which is also more correct than keying on the Google
--     account — a "recognised" clinician's room can be a shared account.
--
-- Supersedes 20260609000001/000002/000003's meet-host-keyed hours. The
-- meet-host hours tables held only throwaway test rows, so they are
-- dropped and re-created keyed on staff_member_id (no data migration).
--
-- Ships COORDINATED with the matching frontend + edge functions, so it
-- is free to drop the now-obsolete meet-host availability objects.
--
-- Apply order: shadow first (verify), then Meridian (with the frontend).

-- ─────────────────────────────────────────────────────────────────
-- 1. Staff capability + public/staff-only flag
-- ─────────────────────────────────────────────────────────────────
alter table public.lng_staff_members
  add column if not exists is_virtual_impression_clinician boolean not null default false,
  add column if not exists clinician_self_serve            boolean not null default true;

comment on column public.lng_staff_members.is_virtual_impression_clinician is
  'When true this staff member is a virtual impression clinician: they can run the video-call controls (Join/Rejoin/Mark complete) and are a bookable clinician whose hours drive virtual availability.';
comment on column public.lng_staff_members.clinician_self_serve is
  'For a virtual impression clinician: when true they appear in self-serve availability (public widget + self-serve reschedule); when false they are staff-placement only. Ignored unless is_virtual_impression_clinician.';

-- lng_staff_members uses column-level grants for authenticated (matching
-- lng_meet_hosts). New columns must be granted explicitly or the client
-- read/update fails with "permission denied for table".
grant select (is_virtual_impression_clinician, clinician_self_serve)
  on public.lng_staff_members to authenticated;
grant update (is_virtual_impression_clinician, clinician_self_serve)
  on public.lng_staff_members to authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 2. Appointment -> clinician link (the availability/overlap key)
-- ─────────────────────────────────────────────────────────────────
alter table public.lng_appointments
  add column if not exists clinician_staff_member_id uuid
    references public.lng_staff_members(id) on delete set null;

comment on column public.lng_appointments.clinician_staff_member_id is
  'The virtual impression clinician (staff member) running this appointment. The availability free-check and the no-double-book guard key on this, not meet_host_id (the Meet room owner, which may be a shared account for recognised clinicians).';

grant select (clinician_staff_member_id) on public.lng_appointments to anon, authenticated;

create index if not exists lng_appointments_clinician_idx
  on public.lng_appointments (clinician_staff_member_id, start_at, end_at)
  where clinician_staff_member_id is not null;

-- ─────────────────────────────────────────────────────────────────
-- 3. Clinician hours + overrides (keyed on staff)
-- ─────────────────────────────────────────────────────────────────
-- The old meet-host hours tables (lng_meet_host_hours / _overrides) are
-- intentionally LEFT IN PLACE here so the currently-live frontend keeps
-- working through the deploy. They are dropped by the cleanup migration
-- after the new frontend is live.
create table public.lng_clinician_hours (
  id              uuid primary key default gen_random_uuid(),
  staff_member_id uuid not null references public.lng_staff_members(id) on delete cascade,
  day_of_week     smallint not null check (day_of_week between 0 and 6),  -- 0=Mon..6=Sun
  start_local     time not null,
  end_local       time not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (end_local > start_local)
);
create index lng_clinician_hours_staff_idx on public.lng_clinician_hours (staff_member_id, day_of_week);
comment on table public.lng_clinician_hours is
  'Weekly recurring working windows per virtual impression clinician (staff member). day_of_week 0=Mon..6=Sun, Europe/London times. Multiple rows per day = split shifts. No rows for a weekday = not working it.';

alter table public.lng_clinician_hours enable row level security;
drop policy if exists lng_clinician_hours_select on public.lng_clinician_hours;
create policy lng_clinician_hours_select on public.lng_clinician_hours
  for select to authenticated using (true);
grant select on public.lng_clinician_hours to authenticated;

create table public.lng_clinician_overrides (
  id              uuid primary key default gen_random_uuid(),
  staff_member_id uuid not null references public.lng_staff_members(id) on delete cascade,
  override_date   date not null,
  kind            text not null check (kind in ('available', 'off')),
  start_local     time,
  end_local       time,
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (
    (kind = 'available' and start_local is not null and end_local is not null and end_local > start_local)
    or (kind = 'off' and (
         (start_local is null and end_local is null)
         or (start_local is not null and end_local is not null and end_local > start_local)
       ))
  )
);
create index lng_clinician_overrides_staff_date_idx on public.lng_clinician_overrides (staff_member_id, override_date);
comment on table public.lng_clinician_overrides is
  'Date-specific exceptions to a clinician''s weekly hours. kind=off (holiday/sick; NULL window = whole day) or kind=available (one-off picked-up shift; window required). Effective windows = weekly + available - off.';

alter table public.lng_clinician_overrides enable row level security;
drop policy if exists lng_clinician_overrides_select on public.lng_clinician_overrides;
create policy lng_clinician_overrides_select on public.lng_clinician_overrides
  for select to authenticated using (true);
grant select on public.lng_clinician_overrides to authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 4. lng_clinicians_available — on-shift AND free clinicians
-- ─────────────────────────────────────────────────────────────────
-- Replaces lng_meet_hosts_available. A clinician qualifies when:
--   * is_virtual_impression_clinician, status active, and (when
--     p_self_serve_only) clinician_self_serve; (p_staff_member_id pins
--     to one clinician for the staff picker);
--   * on shift: a weekly window OR an 'available' override covers the
--     local [start,end], AND no 'off' override applies;
--   * free: no overlapping active virtual appointment for THIS clinician
--     (clinician_staff_member_id), status booked/arrived/joined.
-- lng_meet_hosts_available is LEFT IN PLACE (live edge functions call it)
-- and dropped by the cleanup migration after the new edge fns deploy.

create or replace function public.lng_clinicians_available(
  p_start_at               timestamptz,
  p_end_at                 timestamptz,
  p_self_serve_only        boolean default true,
  p_exclude_appointment_id uuid    default null,
  p_staff_member_id        uuid    default null
)
returns table (
  staff_member_id      uuid,
  display_name         text,
  clinician_self_serve boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_date date; v_end_date date; v_dow int; v_s_time time; v_e_time time;
begin
  if p_start_at is null or p_end_at is null or p_end_at <= p_start_at then
    return;
  end if;
  v_date     := (timezone('Europe/London', p_start_at))::date;
  v_end_date := (timezone('Europe/London', p_end_at))::date;
  v_s_time   := (timezone('Europe/London', p_start_at))::time;
  v_e_time   := (timezone('Europe/London', p_end_at))::time;
  if v_date <> v_end_date then
    return;
  end if;
  v_dow := ((extract(dow from v_date)::int + 6) % 7);  -- 0=Mon..6=Sun

  return query
    select sm.id,
           coalesce(nullif(btrim(coalesce(a.first_name,'') || ' ' || coalesce(a.last_name,'')), ''), a.name, 'Clinician'),
           sm.clinician_self_serve
      from public.lng_staff_members sm
      join public.accounts a on a.id = sm.account_id
     where sm.is_virtual_impression_clinician = true
       and sm.status = 'active'
       and (not p_self_serve_only or sm.clinician_self_serve)
       and (p_staff_member_id is null or sm.id = p_staff_member_id)
       and (
         exists (
           select 1 from public.lng_clinician_hours wh
            where wh.staff_member_id = sm.id and wh.day_of_week = v_dow
              and wh.start_local <= v_s_time and wh.end_local >= v_e_time
         )
         or exists (
           select 1 from public.lng_clinician_overrides o
            where o.staff_member_id = sm.id and o.override_date = v_date
              and o.kind = 'available' and o.start_local <= v_s_time and o.end_local >= v_e_time
         )
       )
       and not exists (
         select 1 from public.lng_clinician_overrides o2
          where o2.staff_member_id = sm.id and o2.override_date = v_date and o2.kind = 'off'
            and (o2.start_local is null or (o2.start_local < v_e_time and o2.end_local > v_s_time))
       )
       and not exists (
         select 1 from public.lng_appointments ap
          where ap.clinician_staff_member_id = sm.id
            and ap.service_type = 'virtual_impression_appointment'
            and ap.status in ('booked', 'arrived', 'joined')
            and ap.start_at < p_end_at and ap.end_at > p_start_at
            and (p_exclude_appointment_id is null or ap.id <> p_exclude_appointment_id)
       )
     order by display_name asc;
end;
$$;

revoke all on function public.lng_clinicians_available(timestamptz, timestamptz, boolean, uuid, uuid) from public;
grant execute on function public.lng_clinicians_available(timestamptz, timestamptz, boolean, uuid, uuid) to anon, authenticated, service_role;
comment on function public.lng_clinicians_available(timestamptz, timestamptz, boolean, uuid, uuid) is
  'Virtual impression clinicians (staff with is_virtual_impression_clinician) who are on shift AND free for [p_start_at,p_end_at]. p_self_serve_only=true drops staff-only clinicians; p_staff_member_id pins to one. Free-check keys on lng_appointments.clinician_staff_member_id. Single source of truth for virtual availability + assignment.';

-- ─────────────────────────────────────────────────────────────────
-- 5. lng_virtual_available_slots — re-keyed to clinicians
-- ─────────────────────────────────────────────────────────────────
-- Same signature shape as before (last arg is the uuid filter, now a
-- staff_member_id), so lng_widget_available_slots' virtual branch keeps
-- compiling without change. Dropped first because the last parameter is
-- renamed (p_host_id -> p_staff_member_id); plpgsql callers late-bind so
-- the drop+recreate is safe.
drop function if exists public.lng_virtual_available_slots(date, int, int, timestamptz, uuid, boolean, uuid);

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
  'Host-aware (now clinician-aware) slot generator for virtual_impression_appointment. Emits each step where >=1 clinician is on shift and free (lng_clinicians_available). p_self_serve_only hides staff-only clinicians; p_staff_member_id pins to one clinician for the staff picker.';

-- ─────────────────────────────────────────────────────────────────
-- 6. lng_booking_available_slots — add p_staff_member_id (keep p_meet_host_id)
-- ─────────────────────────────────────────────────────────────────
-- p_meet_host_id is KEPT (the currently-live frontend's loadAvailableSlots
-- still passes it) but ignored by the virtual branch; p_staff_member_id is
-- the new clinician filter. Both old and new frontends therefore call this
-- function successfully. The cleanup migration removes p_meet_host_id once
-- the new frontend is live.
drop function if exists public.lng_booking_available_slots(uuid, text, date, uuid, text, text, text, int, uuid);

create or replace function public.lng_booking_available_slots(
  p_location_id            uuid,
  p_service_type           text,
  p_date                   date,
  p_exclude_appointment_id uuid default null,
  p_repair_variant         text default null,
  p_product_key            text default null,
  p_arch                   text default null,
  p_step_minutes           int  default 15,
  p_meet_host_id           uuid default null,
  p_staff_member_id        uuid default null
)
returns table (slot_local text)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_resolved      record;
  v_duration      int;
  v_extent        int;
  v_dow           int;
  v_hours_arr     jsonb;
  v_day           jsonb;
  v_open_text     text;
  v_close_text    text;
  v_break         jsonb;
  v_break_open    text;
  v_break_close   text;
  v_open_total    int;
  v_close_total   int;
  v_break_start   int;
  v_break_end     int;
  v_close_at      timestamptz;
  v_minute_total  int;
  v_hour          int;
  v_minute        int;
  v_cand_start    timestamptz;
  v_cand_end      timestamptz;
  v_has_conflict  boolean;
  v_now           timestamptz := current_timestamp;
  v_min_notice    int;
  v_earliest_start timestamptz;
begin
  select duration_default, block_duration_minutes, working_hours, min_notice_minutes
    into v_resolved
    from public.lng_booking_type_resolve(p_service_type, p_repair_variant, p_product_key, p_arch);

  if v_resolved is null then return; end if;
  v_duration := coalesce(v_resolved.duration_default, v_resolved.block_duration_minutes);
  if v_duration is null then return; end if;
  v_extent := greatest(v_duration, coalesce(v_resolved.block_duration_minutes, v_duration));
  v_min_notice     := coalesce(v_resolved.min_notice_minutes, 0);
  v_earliest_start := v_now + make_interval(mins => v_min_notice);

  -- Virtual: clinician-aware. Staff path includes staff-only clinicians
  -- (self_serve_only=false); p_staff_member_id pins to the picked one.
  if p_service_type = 'virtual_impression_appointment' then
    return query
      select to_char(timezone('Europe/London', s.start_at), 'HH24:MI')
        from public.lng_virtual_available_slots(
          p_date, v_duration, p_step_minutes, v_earliest_start,
          p_exclude_appointment_id, false, p_staff_member_id
        ) s;
    return;
  end if;

  v_hours_arr := v_resolved.working_hours;
  if v_hours_arr is null then
    select value into v_hours_arr from public.lng_settings
     where key = 'clinic.opening_hours' and location_id is null;
  end if;
  if v_hours_arr is null or jsonb_typeof(v_hours_arr) <> 'array' or jsonb_array_length(v_hours_arr) <> 7 then
    return;
  end if;

  v_dow := extract(dow from p_date)::int;
  v_day := v_hours_arr -> ((v_dow + 6) % 7);
  if v_day is null or (v_day ? 'closed' and (v_day ->> 'closed')::boolean = true) then return; end if;

  v_open_text  := v_day ->> 'open';
  v_close_text := v_day ->> 'close';
  if v_open_text is null or v_close_text is null then return; end if;

  v_open_total  := (split_part(v_open_text,  ':', 1)::int) * 60 + (split_part(v_open_text,  ':', 2)::int);
  v_close_total := (split_part(v_close_text, ':', 1)::int) * 60 + (split_part(v_close_text, ':', 2)::int);
  if v_close_total <= v_open_total then return; end if;

  v_close_at := timezone('Europe/London', (p_date + v_close_text::time)::timestamp);

  v_break := v_day -> 'break';
  v_break_start := null; v_break_end := null;
  if v_break is not null and jsonb_typeof(v_break) = 'array' and jsonb_array_length(v_break) = 2 then
    v_break_open  := v_break ->> 0;
    v_break_close := v_break ->> 1;
    v_break_start := (split_part(v_break_open,  ':', 1)::int) * 60 + (split_part(v_break_open,  ':', 2)::int);
    v_break_end   := (split_part(v_break_close, ':', 1)::int) * 60 + (split_part(v_break_close, ':', 2)::int);
    if v_break_end <= v_break_start then v_break_start := null; v_break_end := null; end if;
  end if;

  v_minute_total := v_open_total;
  while v_minute_total < v_close_total loop
    v_hour   := v_minute_total / 60;
    v_minute := v_minute_total % 60;
    if v_break_start is not null and v_minute_total >= v_break_start and v_minute_total < v_break_end then
      v_minute_total := v_minute_total + p_step_minutes;
      continue;
    end if;
    v_cand_start := timezone('Europe/London', (p_date + make_time(v_hour, v_minute, 0))::timestamp);
    v_cand_end := v_cand_start + make_interval(mins => v_duration);
    if v_cand_start >= v_earliest_start and v_cand_start + make_interval(mins => v_extent) <= v_close_at then
      select exists (
        select 1 from public.lng_booking_check_conflict(
          p_location_id, p_service_type, v_cand_start, v_cand_end,
          p_exclude_appointment_id, p_repair_variant, p_product_key, p_arch
        )
      ) into v_has_conflict;
      if not v_has_conflict then
        slot_local := lpad(v_hour::text, 2, '0') || ':' || lpad(v_minute::text, 2, '0');
        return next;
      end if;
    end if;
    v_minute_total := v_minute_total + p_step_minutes;
  end loop;
  return;
end;
$$;

revoke all on function public.lng_booking_available_slots(uuid, text, date, uuid, text, text, text, int, uuid, uuid) from public;
grant execute on function public.lng_booking_available_slots(uuid, text, date, uuid, text, text, text, int, uuid, uuid) to authenticated;
comment on function public.lng_booking_available_slots(uuid, text, date, uuid, text, text, text, int, uuid, uuid) is
  'Staff-side availability resolver. virtual_impression_appointment is clinician-aware via lng_virtual_available_slots (staff see staff-only clinicians; p_staff_member_id pins to one). Other types use booking-type/clinic hours + conflict checker + min_notice.';

-- ─────────────────────────────────────────────────────────────────
-- 7. No-double-book guard — re-keyed to the clinician
-- ─────────────────────────────────────────────────────────────────
drop trigger if exists zz_virtual_host_overlap_guard on public.lng_appointments;
drop function if exists public.lng_virtual_host_guard_trg();

create or replace function public.lng_virtual_clinician_guard_trg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_overlap int;
begin
  if new.service_type is distinct from 'virtual_impression_appointment' then return new; end if;
  if new.status not in ('booked', 'arrived', 'joined') then return new; end if;
  if new.clinician_staff_member_id is null then return new; end if;
  if tg_op = 'UPDATE' and old.status in ('no_show', 'cancelled', 'rescheduled') then return new; end if;

  perform pg_advisory_xact_lock(hashtext(new.clinician_staff_member_id::text)::bigint);

  select count(*) into v_overlap
    from public.lng_appointments a
   where a.clinician_staff_member_id = new.clinician_staff_member_id
     and a.id <> new.id
     and a.service_type = 'virtual_impression_appointment'
     and a.status in ('booked', 'arrived', 'joined')
     and a.start_at < new.end_at and a.end_at > new.start_at;

  if v_overlap > 0 then
    raise exception
      'OVERLAP: clinician % already has a virtual appointment overlapping % to %',
      new.clinician_staff_member_id, new.start_at, new.end_at
      using errcode = '23P01';
  end if;
  return new;
end;
$$;

revoke all on function public.lng_virtual_clinician_guard_trg() from public;
comment on function public.lng_virtual_clinician_guard_trg() is
  'AFTER INSERT/UPDATE constraint trigger. For virtual_impression_appointment rows with a clinician_staff_member_id, raises 23P01 if another active (booked/arrived/joined) virtual appointment for the same clinician overlaps. The DB-level guarantee a clinician is never double-booked.';

drop trigger if exists zz_virtual_clinician_overlap_guard on public.lng_appointments;
create constraint trigger zz_virtual_clinician_overlap_guard
  after insert or update of start_at, end_at, status, clinician_staff_member_id, service_type
  on public.lng_appointments
  initially immediate
  for each row
  execute function public.lng_virtual_clinician_guard_trg();

-- ─────────────────────────────────────────────────────────────────
-- 8. Admin write RPCs (clinician-keyed)
-- ─────────────────────────────────────────────────────────────────
-- The old meet-host write RPCs (lng_set_meet_host_hours / _override /
-- _self_serve) are LEFT IN PLACE for the live frontend's old editor;
-- the cleanup migration drops them after the new frontend is live.
create or replace function public.lng_set_clinician_hours(
  p_staff_member_id uuid,
  p_windows         jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  w jsonb;
begin
  if not public.is_admin() then
    raise exception 'Only admins can set clinician hours' using errcode = '42501';
  end if;
  if not exists (select 1 from public.lng_staff_members where id = p_staff_member_id) then
    raise exception 'Staff member % not found', p_staff_member_id using errcode = 'P0002';
  end if;
  if p_windows is null or jsonb_typeof(p_windows) <> 'array' then
    raise exception 'p_windows must be a jsonb array' using errcode = '22023';
  end if;
  delete from public.lng_clinician_hours where staff_member_id = p_staff_member_id;
  for w in select value from jsonb_array_elements(p_windows) loop
    insert into public.lng_clinician_hours (staff_member_id, day_of_week, start_local, end_local)
    values (p_staff_member_id, (w->>'day_of_week')::smallint, (w->>'start')::time, (w->>'end')::time);
  end loop;
end;
$$;
revoke all on function public.lng_set_clinician_hours(uuid, jsonb) from public;
grant execute on function public.lng_set_clinician_hours(uuid, jsonb) to authenticated;

create or replace function public.lng_add_clinician_override(
  p_staff_member_id uuid,
  p_date            date,
  p_kind            text,
  p_start_local     time default null,
  p_end_local       time default null,
  p_note            text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Only admins can add clinician overrides' using errcode = '42501';
  end if;
  insert into public.lng_clinician_overrides (staff_member_id, override_date, kind, start_local, end_local, note)
  values (p_staff_member_id, p_date, p_kind, p_start_local, p_end_local, p_note)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.lng_add_clinician_override(uuid, date, text, time, time, text) from public;
grant execute on function public.lng_add_clinician_override(uuid, date, text, time, time, text) to authenticated;

create or replace function public.lng_delete_clinician_override(p_override_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can delete clinician overrides' using errcode = '42501';
  end if;
  delete from public.lng_clinician_overrides where id = p_override_id;
end;
$$;
revoke all on function public.lng_delete_clinician_override(uuid) from public;
grant execute on function public.lng_delete_clinician_override(uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 9. Migrate the existing meet-host virtual setup -> clinician model
-- ─────────────────────────────────────────────────────────────────
-- Section 5 switched virtual availability to the clinician model. To keep
-- availability EQUIVALENT through that switch (no regression for the live
-- app), carry the current setup over: for every OAuth Meet host that maps
-- to a staff member (by email), flag that staff member as a virtual
-- impression clinician, link the host as their room owner, and copy any
-- existing meet-host hours into clinician hours. Generic + idempotent —
-- no hardcoded ids; a no-op where nothing matches (e.g. shadow).
do $$
declare r record;
begin
  for r in
    select mh.id as host_id, sm.id as staff_id
      from public.lng_meet_hosts mh
      join public.accounts a on lower(a.login_email) = lower(mh.google_email)
      join public.lng_staff_members sm on sm.account_id = a.id
     where mh.kind = 'oauth'
  loop
    update public.lng_staff_members
       set is_virtual_impression_clinician = true
     where id = r.staff_id and is_virtual_impression_clinician = false;

    update public.lng_meet_hosts
       set staff_member_id = r.staff_id
     where id = r.host_id and staff_member_id is null;

    -- Copy meet-host hours -> clinician hours, only when the clinician
    -- has no clinician hours yet (so re-running never duplicates).
    insert into public.lng_clinician_hours (staff_member_id, day_of_week, start_local, end_local)
    select r.staff_id, mhh.day_of_week, mhh.start_local, mhh.end_local
      from public.lng_meet_host_hours mhh
     where mhh.host_id = r.host_id
       and not exists (
         select 1 from public.lng_clinician_hours ch where ch.staff_member_id = r.staff_id
       );
  end loop;
end $$;

NOTIFY pgrst, 'reload schema';

-- ── Rollback ──────────────────────────────────────────────────────
-- This migration is additive (it keeps every old object). To revert:
--   re-apply 20260609000002 (restores lng_virtual_available_slots +
--   lng_booking_available_slots to the meet-host versions), then drop the
--   clinician tables/functions/guard, the staff columns, and the
--   appointment column added here.
