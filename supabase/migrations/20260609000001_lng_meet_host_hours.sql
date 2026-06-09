-- 20260609000001_lng_meet_host_hours.sql
--
-- Per-clinician working hours for Virtual Impression video calls.
--
-- Until now virtual_impression_appointment availability was clinic-wide:
-- a single working_hours block on lng_booking_type_config (Mon-Fri
-- 09-18 / Sat 10-16), the same window the public widget and staff
-- sheets walked. lng_meet_hosts held only OAuth credentials, no notion
-- of *when* a host actually works, and the booking edge functions just
-- picked "the first active host". With two (or more) clinicians working
-- different hours — and a casual clinician who only picks up the odd
-- shift — that model can't express the real schedule.
--
-- This migration adds the data so availability can be driven by who is
-- actually on shift:
--
--   1. lng_meet_hosts.self_serve  — a host the public can self-book vs.
--      a special/temp clinician only staff place a customer with.
--   2. lng_meet_host_hours        — weekly recurring windows per host.
--   3. lng_meet_host_overrides    — date-specific exceptions: 'off' for
--      a holiday/sick day, 'available' for a one-off picked-up shift.
--   4. lng_meet_hosts_available() — the single source of truth for
--      "which hosts are on shift AND free for this exact interval",
--      used by the slot scanners (20260609000002) and the host-overlap
--      guard (20260609000003), and called directly by the booking edge
--      functions to choose a host.
--   5. Admin write RPCs (is_admin-gated) so the Admin -> Services hours
--      editor can mutate hours/overrides/self_serve without a direct
--      table grant (mirrors lng_set_staff_pool_assignments).
--
-- Day-of-week convention: 0 = Monday .. 6 = Sunday (Mon-first), matching
-- the existing 7-element opening-hours array indexed by ((dow+6)%7).
-- All times are clinic-local (Europe/London), same as every other hours
-- source in this codebase.
--
-- Apply order: shadow first (verify), then Meridian.

-- ─────────────────────────────────────────────────────────────────
-- 0. lng_meet_hosts: self_serve flag (+ defensive sort_order)
-- ─────────────────────────────────────────────────────────────────
-- self_serve = false marks a special/temp clinician: hidden from ALL
-- self-serve surfaces (public widget bookings AND self-serve
-- reschedule). Staff can still place a customer with them by choosing
-- them explicitly. Default true so every existing host stays
-- self-bookable; an admin flips the special ones off.
alter table public.lng_meet_hosts
  add column if not exists self_serve boolean not null default true;

comment on column public.lng_meet_hosts.self_serve is
  'When true the host appears in self-serve availability (public widget + self-serve reschedule). When false the host is staff-placement only — a special/temp clinician used in specific situations; their hours still exist and still block double-booking, they are just invisible to self-serve.';

-- sort_order is read by meetHosts.ts (host priority / default selection)
-- but no migration in this repo ever created the column — it was added
-- out-of-band in production. Add it defensively so the repo schema is
-- self-consistent and a fresh shadow rebuild matches production. No-op
-- where it already exists.
alter table public.lng_meet_hosts
  add column if not exists sort_order integer not null default 0;

comment on column public.lng_meet_hosts.sort_order is
  'Admin-set host priority. Lower sorts first; the top host is the default selection for new virtual bookings. Read by meetHosts.ts and the availability helper.';

-- ─────────────────────────────────────────────────────────────────
-- 1. lng_meet_host_hours — weekly recurring windows
-- ─────────────────────────────────────────────────────────────────
-- One row per working window. Multiple rows per (host, day_of_week)
-- are allowed so split shifts (e.g. 09:00-12:00 and 14:00-17:00) are
-- expressible. A host with NO rows for a weekday is not working that
-- weekday (the "off until hours are set" rule) — availability treats
-- the absence of windows as unavailable, never as all-day open.
create table public.lng_meet_host_hours (
  id           uuid primary key default gen_random_uuid(),
  host_id      uuid not null references public.lng_meet_hosts(id) on delete cascade,
  day_of_week  smallint not null check (day_of_week between 0 and 6),
  start_local  time not null,
  end_local    time not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (end_local > start_local)
);

create index lng_meet_host_hours_host_idx
  on public.lng_meet_host_hours (host_id, day_of_week);

comment on table public.lng_meet_host_hours is
  'Weekly recurring working windows per Meet host (clinician). day_of_week 0=Mon..6=Sun. Clinic-local (Europe/London) times. Multiple rows per day = split shifts. No rows for a weekday = not working that weekday.';

alter table public.lng_meet_host_hours enable row level security;

drop policy if exists lng_meet_host_hours_select on public.lng_meet_host_hours;
create policy lng_meet_host_hours_select on public.lng_meet_host_hours
  for select to authenticated
  using (true);

-- No insert/update/delete policy: writes go through the is_admin-gated
-- SECURITY DEFINER RPCs below, edge functions use service_role.

-- ─────────────────────────────────────────────────────────────────
-- 2. lng_meet_host_overrides — date-specific exceptions
-- ─────────────────────────────────────────────────────────────────
-- kind = 'off'       : not working (holiday / sick). NULL window = the
--                      whole day; a window = off for that slice only.
-- kind = 'available' : working this specific date even though the
--                      weekly pattern says otherwise — the casual
--                      clinician picking up a shift. Window required.
--
-- Effective windows for a date = weekly windows for that weekday, PLUS
-- any 'available' overrides, MINUS any 'off' overrides. A casual
-- clinician with no weekly rows is bookable only on dates carrying an
-- 'available' override — exactly "make available on a specific date".
create table public.lng_meet_host_overrides (
  id            uuid primary key default gen_random_uuid(),
  host_id       uuid not null references public.lng_meet_hosts(id) on delete cascade,
  override_date date not null,
  kind          text not null check (kind in ('available', 'off')),
  start_local   time,
  end_local     time,
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (
    (kind = 'available'
       and start_local is not null
       and end_local   is not null
       and end_local   > start_local)
    or
    (kind = 'off'
       and (
            (start_local is null and end_local is null)
            or (start_local is not null
                and end_local is not null
                and end_local > start_local)
           ))
  )
);

create index lng_meet_host_overrides_host_date_idx
  on public.lng_meet_host_overrides (host_id, override_date);

comment on table public.lng_meet_host_overrides is
  'Date-specific exceptions to a host''s weekly hours. kind=off (holiday/sick; NULL window = whole day) or kind=available (one-off picked-up shift; window required). Effective windows = weekly + available - off.';

alter table public.lng_meet_host_overrides enable row level security;

drop policy if exists lng_meet_host_overrides_select on public.lng_meet_host_overrides;
create policy lng_meet_host_overrides_select on public.lng_meet_host_overrides
  for select to authenticated
  using (true);

-- ─────────────────────────────────────────────────────────────────
-- 3. lng_meet_hosts_available — on-shift AND free hosts for [start,end]
-- ─────────────────────────────────────────────────────────────────
-- The single definition of "who can take this virtual slot". A host
-- qualifies when:
--   • is_active, and (when p_self_serve_only) self_serve = true, and
--     (when p_host_id given) it is that host;
--   • on shift: a weekly window OR an 'available' override fully covers
--     the local [start,end], AND no 'off' override (whole-day or an
--     overlapping slice) applies;
--   • free: no other active virtual appointment for the same host
--     overlaps [start,end] (status booked/arrived/joined — joined is
--     the virtual analogue of arrived).
--
-- SECURITY DEFINER so the public widget (anon) and staff (authenticated)
-- both get the same answer regardless of row-level visibility on
-- lng_appointments. Returns hosts ordered by sort_order so callers can
-- pick the preferred free host as hosts[0].
create or replace function public.lng_meet_hosts_available(
  p_start_at               timestamptz,
  p_end_at                 timestamptz,
  p_self_serve_only        boolean default true,
  p_exclude_appointment_id uuid    default null,
  p_host_id                uuid    default null
)
returns table (
  host_id      uuid,
  display_name text,
  self_serve   boolean,
  sort_order   int
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_date     date;
  v_end_date date;
  v_dow      int;
  v_s_time   time;
  v_e_time   time;
begin
  if p_start_at is null or p_end_at is null or p_end_at <= p_start_at then
    return;
  end if;

  v_date     := (timezone('Europe/London', p_start_at))::date;
  v_end_date := (timezone('Europe/London', p_end_at))::date;
  v_s_time   := (timezone('Europe/London', p_start_at))::time;
  v_e_time   := (timezone('Europe/London', p_end_at))::time;

  -- A virtual slot is a single 30-minute block inside one clinic day.
  -- A candidate that straddles midnight has no single weekday/window to
  -- match against, so treat it as unavailable rather than guess.
  if v_date <> v_end_date then
    return;
  end if;

  v_dow := ((extract(dow from v_date)::int + 6) % 7);  -- 0=Mon..6=Sun

  return query
    select h.id, h.display_name, h.self_serve, h.sort_order
      from public.lng_meet_hosts h
     where h.is_active
       and (not p_self_serve_only or h.self_serve)
       and (p_host_id is null or h.id = p_host_id)
       -- on shift: covered by a weekly window or an 'available' override
       and (
         exists (
           select 1 from public.lng_meet_host_hours wh
            where wh.host_id = h.id
              and wh.day_of_week = v_dow
              and wh.start_local <= v_s_time
              and wh.end_local   >= v_e_time
         )
         or exists (
           select 1 from public.lng_meet_host_overrides o
            where o.host_id = h.id
              and o.override_date = v_date
              and o.kind = 'available'
              and o.start_local <= v_s_time
              and o.end_local   >= v_e_time
         )
       )
       -- not cancelled by an 'off' override (whole-day or overlapping)
       and not exists (
         select 1 from public.lng_meet_host_overrides o2
          where o2.host_id = h.id
            and o2.override_date = v_date
            and o2.kind = 'off'
            and (
              o2.start_local is null
              or (o2.start_local < v_e_time and o2.end_local > v_s_time)
            )
       )
       -- free: no overlapping active virtual appointment for this host
       and not exists (
         select 1 from public.lng_appointments a
          where a.meet_host_id = h.id
            and a.service_type = 'virtual_impression_appointment'
            and a.status in ('booked', 'arrived', 'joined')
            and a.start_at < p_end_at
            and a.end_at   > p_start_at
            and (p_exclude_appointment_id is null or a.id <> p_exclude_appointment_id)
       )
     order by h.sort_order asc, h.display_name asc;
end;
$$;

revoke all on function public.lng_meet_hosts_available(timestamptz, timestamptz, boolean, uuid, uuid) from public;
grant execute on function public.lng_meet_hosts_available(timestamptz, timestamptz, boolean, uuid, uuid) to anon, authenticated, service_role;

comment on function public.lng_meet_hosts_available(timestamptz, timestamptz, boolean, uuid, uuid) is
  'Returns Meet hosts who are on shift AND free for the exact interval [p_start_at, p_end_at], ordered by sort_order. p_self_serve_only=true (default) drops staff-only hosts for public/widget callers; pass false from staff paths. p_host_id narrows to one clinician. p_exclude_appointment_id ignores a row (reschedule). Single source of truth for virtual availability + host selection.';

-- ─────────────────────────────────────────────────────────────────
-- 4. Admin write RPCs (is_admin-gated, SECURITY DEFINER)
-- ─────────────────────────────────────────────────────────────────
-- Mirrors lng_set_staff_pool_assignments: the Admin UI runs as the
-- authenticated admin, mutations go through these so the tables need no
-- write policy and every change is gated by is_admin().

-- 4a. self_serve toggle
create or replace function public.lng_set_meet_host_self_serve(
  p_host_id    uuid,
  p_self_serve boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can change host self-serve' using errcode = '42501';
  end if;
  update public.lng_meet_hosts
     set self_serve = p_self_serve
   where id = p_host_id;
  if not found then
    raise exception 'Meet host % not found', p_host_id using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.lng_set_meet_host_self_serve(uuid, boolean) from public;
grant execute on function public.lng_set_meet_host_self_serve(uuid, boolean) to authenticated;

-- 4b. replace a host's entire weekly hours set in one transaction.
-- p_windows: jsonb array of { "day_of_week": 0..6, "start": "HH:MM",
-- "end": "HH:MM" }. Replacing wholesale keeps the editor simple (read
-- all, edit, save all) and avoids partial-update drift.
create or replace function public.lng_set_meet_host_hours(
  p_host_id uuid,
  p_windows jsonb
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
    raise exception 'Only admins can set host hours' using errcode = '42501';
  end if;
  if not exists (select 1 from public.lng_meet_hosts where id = p_host_id) then
    raise exception 'Meet host % not found', p_host_id using errcode = 'P0002';
  end if;
  if p_windows is null or jsonb_typeof(p_windows) <> 'array' then
    raise exception 'p_windows must be a jsonb array' using errcode = '22023';
  end if;

  delete from public.lng_meet_host_hours where host_id = p_host_id;

  for w in select value from jsonb_array_elements(p_windows)
  loop
    insert into public.lng_meet_host_hours (host_id, day_of_week, start_local, end_local)
    values (
      p_host_id,
      (w->>'day_of_week')::smallint,
      (w->>'start')::time,
      (w->>'end')::time
    );
  end loop;
end;
$$;

revoke all on function public.lng_set_meet_host_hours(uuid, jsonb) from public;
grant execute on function public.lng_set_meet_host_hours(uuid, jsonb) to authenticated;

-- 4c. add a date override, returns its id
create or replace function public.lng_add_meet_host_override(
  p_host_id     uuid,
  p_date        date,
  p_kind        text,
  p_start_local time default null,
  p_end_local   time default null,
  p_note        text default null
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
    raise exception 'Only admins can add host overrides' using errcode = '42501';
  end if;
  insert into public.lng_meet_host_overrides
    (host_id, override_date, kind, start_local, end_local, note)
  values
    (p_host_id, p_date, p_kind, p_start_local, p_end_local, p_note)
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.lng_add_meet_host_override(uuid, date, text, time, time, text) from public;
grant execute on function public.lng_add_meet_host_override(uuid, date, text, time, time, text) to authenticated;

-- 4d. delete a date override
create or replace function public.lng_delete_meet_host_override(
  p_override_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can delete host overrides' using errcode = '42501';
  end if;
  delete from public.lng_meet_host_overrides where id = p_override_id;
end;
$$;

revoke all on function public.lng_delete_meet_host_override(uuid) from public;
grant execute on function public.lng_delete_meet_host_override(uuid) to authenticated;

NOTIFY pgrst, 'reload schema';

-- ── Rollback ──────────────────────────────────────────────────────
-- drop function if exists public.lng_delete_meet_host_override(uuid);
-- drop function if exists public.lng_add_meet_host_override(uuid, date, text, time, time, text);
-- drop function if exists public.lng_set_meet_host_hours(uuid, jsonb);
-- drop function if exists public.lng_set_meet_host_self_serve(uuid, boolean);
-- drop function if exists public.lng_meet_hosts_available(timestamptz, timestamptz, boolean, uuid, uuid);
-- drop table if exists public.lng_meet_host_overrides;
-- drop table if exists public.lng_meet_host_hours;
-- alter table public.lng_meet_hosts drop column if exists self_serve;
-- (leave sort_order — it predates this migration in production)
