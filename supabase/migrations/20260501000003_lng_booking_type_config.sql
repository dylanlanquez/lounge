-- 20260501000003_lng_booking_type_config.sql
--
-- Per-booking-type scheduling config for the native Lounge booking
-- system. Drives:
--
--   • The reschedule sheet's slot picker (working hours per day of
--     week, duration min/max/default).
--   • The conflict checker (paired with lng_booking_concurrency_rules
--     in a follow-up migration).
--   • Future "book a new appointment" flow.
--
-- ── Data model ─────────────────────────────────────────────────────
--
-- Two tiers in one table:
--
--   PARENT ROW   service_type set, all child columns null. Holds the
--                fallback config for everything within that service.
--                One per service type:
--                  ('denture_repair', null, null, null)
--                  ('click_in_veneers', null, null, null)
--                  ('same_day_appliance', null, null, null)
--                  ('impression_appointment', null, null, null)
--                  ('other', null, null, null)
--
--   CHILD ROW    service_type set, plus exactly one child key:
--                  • repair_variant for denture_repair       ('denture_repair', 'Cracked denture', null, null)
--                  • product_key   for same_day_appliance    ('same_day_appliance', null, 'night_guard', null)
--                  • arch          for click_in_veneers      ('click_in_veneers', null, null, 'lower')
--                  • arch          for impression_appointment
--                Each individual nullable field on a child falls back
--                to the parent's value at resolve time, so a child
--                can override only `duration_max` while still using
--                the parent's working_hours, etc.
--
-- The table itself is intentionally permissive — the at-most-one
-- child key is enforced by a check constraint, not by separate
-- columns per service. This keeps the row shape stable as service
-- types evolve, and any new child dimension lands as a column add
-- rather than a table redesign.
--
-- ── Working hours shape ────────────────────────────────────────────
--
-- working_hours is a JSONB object keyed by day of week (mon..sun).
-- Each day's value is either:
--   • { "open": "HH:MM", "close": "HH:MM" }  for an open day
--   • null                                    for a closed day
-- A null at the top level means "inherit from parent" (children only).
--
-- Examples:
--   parent:  { mon: {open:"09:00", close:"18:00"}, sun: null, ... }
--   child:   null                                    -- inherit all
--   child:   { sat: {open:"10:00", close:"14:00"} }  -- partial; if
--            we ever want partial-day overrides we'd merge keys, but
--            for v1 the rule is simpler: working_hours is
--            all-or-nothing — child either inherits the whole
--            schedule or replaces it entirely.
--
-- See docs/runbooks/migration-workflow.md for the apply procedure.

create table if not exists public.lng_booking_type_config (
  id              uuid primary key default gen_random_uuid(),

  -- Parent service identifier — always set. Mirrors the values used
  -- elsewhere on lwo_catalogue.service_type and lng_visits.service_type.
  service_type    text not null
                    check (service_type in (
                      'denture_repair',
                      'click_in_veneers',
                      'same_day_appliance',
                      'impression_appointment',
                      'other'
                    )),

  -- Child key columns. At most one is non-null per row (enforced
  -- below). For a parent row, all three are null.
  repair_variant  text,
  product_key     text,
  arch            text check (arch is null or arch in ('upper', 'lower', 'both')),

  -- Working hours per day of week — see header for shape. Null on
  -- a child row means inherit from parent.
  working_hours   jsonb,

  -- Booking duration in minutes. Each is null-fallback: a child
  -- can override only the ones it wants to change.
  duration_min      int check (duration_min is null or duration_min > 0),
  duration_max      int check (duration_max is null or duration_max > 0),
  duration_default  int check (duration_default is null or duration_default > 0),

  -- Free-text admin note shown in the booking-type config UI.
  notes           text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- Range sanity: max ≥ min, default within [min, max] when all set.
  -- Each clause is permissive when its inputs are null so partial
  -- child rows that don't touch durations still validate.
  constraint dur_max_gte_min check (
    duration_min is null or duration_max is null or duration_max >= duration_min
  ),
  constraint dur_default_in_range check (
    duration_default is null
    or (
      (duration_min is null or duration_default >= duration_min)
      and (duration_max is null or duration_default <= duration_max)
    )
  ),

  -- At most one child key set per row. A parent row has all three
  -- null. A child row has exactly one non-null.
  constraint at_most_one_child_key check (
    (case when repair_variant is not null then 1 else 0 end)
    + (case when product_key   is not null then 1 else 0 end)
    + (case when arch          is not null then 1 else 0 end)
    <= 1
  )
);

-- Uniqueness on the four-tuple identifies a config row deterministically.
-- nulls not distinct treats nulls as equal so two parent rows with
-- ('denture_repair', null, null, null) collide. Postgres 15+.
create unique index if not exists lng_booking_type_config_key_uniq
  on public.lng_booking_type_config (service_type, repair_variant, product_key, arch)
  nulls not distinct;

-- Lookup index for the reschedule slot picker: given a booking type,
-- find its config quickly.
create index if not exists lng_booking_type_config_service_idx
  on public.lng_booking_type_config (service_type);

create trigger lng_booking_type_config_set_updated_at
  before update on public.lng_booking_type_config
  for each row execute function public.touch_updated_at();

alter table public.lng_booking_type_config enable row level security;

-- All staff can read the config — the receptionist's reschedule
-- sheet needs working hours and durations to render the slot picker.
create policy lng_booking_type_config_read
  on public.lng_booking_type_config
  for select to authenticated using (true);

-- Writes are admin-only. Mirrors the lng_settings pattern.
create policy lng_booking_type_config_admin_write
  on public.lng_booking_type_config
  for all to authenticated
  using (public.auth_is_lng_admin() or public.auth_is_super_admin())
  with check (public.auth_is_lng_admin() or public.auth_is_super_admin());

comment on table public.lng_booking_type_config is
  'Per-booking-type scheduling config (working hours, duration min/max/default). Two tiers in one table: parent rows (service_type only) and child rows (service_type + one of repair_variant / product_key / arch). Children inherit any null field from their parent at resolve time. Read-open to staff; admin-only writes.';

comment on column public.lng_booking_type_config.working_hours is
  'JSONB per day of week. { mon: {open:"HH:MM", close:"HH:MM"} | null, ..., sun: ... }. Top-level null = inherit from parent. Per-day null = closed.';

-- ── Resolve helper ──────────────────────────────────────────────────
--
-- Given a (service_type, repair_variant, product_key, arch) tuple,
-- returns the effective config with parent fallback applied. Used by
-- the reschedule slot picker and the conflict checker.
--
-- Each nullable field falls back independently — a child that only
-- overrides duration_max keeps the parent's working_hours and
-- duration_min/default.
--
-- Returns one row even when no child config exists (the parent's
-- values stand in). Returns no row only when no parent exists for
-- the service either (data setup error).

create or replace function public.lng_booking_type_resolve(
  p_service_type   text,
  p_repair_variant text default null,
  p_product_key    text default null,
  p_arch           text default null
)
returns table (
  service_type     text,
  repair_variant   text,
  product_key      text,
  arch             text,
  working_hours    jsonb,
  duration_min     int,
  duration_max     int,
  duration_default int,
  notes            text,
  source           text -- 'child' | 'parent' — which row supplied each value originally
)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  child_row   public.lng_booking_type_config;
  parent_row  public.lng_booking_type_config;
begin
  -- Fetch the parent row first — it's the floor for everything.
  select * into parent_row
    from public.lng_booking_type_config c
   where c.service_type = p_service_type
     and c.repair_variant is null
     and c.product_key is null
     and c.arch is null
   limit 1;

  -- Fetch the matching child row, if a child key was provided.
  if p_repair_variant is not null then
    select * into child_row
      from public.lng_booking_type_config c
     where c.service_type = p_service_type
       and c.repair_variant = p_repair_variant
       and c.product_key is null
       and c.arch is null
     limit 1;
  elsif p_product_key is not null then
    select * into child_row
      from public.lng_booking_type_config c
     where c.service_type = p_service_type
       and c.repair_variant is null
       and c.product_key = p_product_key
       and c.arch is null
     limit 1;
  elsif p_arch is not null then
    select * into child_row
      from public.lng_booking_type_config c
     where c.service_type = p_service_type
       and c.repair_variant is null
       and c.product_key is null
       and c.arch = p_arch
     limit 1;
  end if;

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
      coalesce(child_row.notes,            parent_row.notes),
      case when child_row.id is not null then 'child' else 'parent' end;
end;
$$;

revoke all on function public.lng_booking_type_resolve(text, text, text, text) from public;
grant execute on function public.lng_booking_type_resolve(text, text, text, text) to authenticated;

comment on function public.lng_booking_type_resolve(text, text, text, text) is
  'Returns the effective booking-type config for (service, repair_variant?, product_key?, arch?), with each nullable field falling back to the parent service row independently. The reschedule slot picker calls this to get the effective working hours + duration for the booking type the patient is being moved to.';

-- ── Seed: parent rows for every recognised service ─────────────────
-- These are the fallback defaults when no child config exists. Admin
-- can change them via the Booking Types page (next PR).
--
-- Hours: Mon–Fri 09:00–18:00, Sat 10:00–16:00, Sun closed.
-- Durations per service mirror operational reality at Lounge today
-- and can be tuned by the admin.

insert into public.lng_booking_type_config (
  service_type, working_hours, duration_min, duration_max, duration_default
) values
  (
    'denture_repair',
    jsonb_build_object(
      'mon', jsonb_build_object('open', '09:00', 'close', '18:00'),
      'tue', jsonb_build_object('open', '09:00', 'close', '18:00'),
      'wed', jsonb_build_object('open', '09:00', 'close', '18:00'),
      'thu', jsonb_build_object('open', '09:00', 'close', '18:00'),
      'fri', jsonb_build_object('open', '09:00', 'close', '18:00'),
      'sat', jsonb_build_object('open', '10:00', 'close', '16:00'),
      'sun', null
    ),
    23, 90, 45
  ),
  (
    'click_in_veneers',
    jsonb_build_object(
      'mon', jsonb_build_object('open', '09:00', 'close', '18:00'),
      'tue', jsonb_build_object('open', '09:00', 'close', '18:00'),
      'wed', jsonb_build_object('open', '09:00', 'close', '18:00'),
      'thu', jsonb_build_object('open', '09:00', 'close', '18:00'),
      'fri', jsonb_build_object('open', '09:00', 'close', '18:00'),
      'sat', jsonb_build_object('open', '10:00', 'close', '16:00'),
      'sun', null
    ),
    30, 120, 60
  ),
  (
    'same_day_appliance',
    jsonb_build_object(
      'mon', jsonb_build_object('open', '09:00', 'close', '18:00'),
      'tue', jsonb_build_object('open', '09:00', 'close', '18:00'),
      'wed', jsonb_build_object('open', '09:00', 'close', '18:00'),
      'thu', jsonb_build_object('open', '09:00', 'close', '18:00'),
      'fri', jsonb_build_object('open', '09:00', 'close', '18:00'),
      'sat', jsonb_build_object('open', '10:00', 'close', '16:00'),
      'sun', null
    ),
    45, 180, 90
  ),
  (
    'impression_appointment',
    jsonb_build_object(
      'mon', jsonb_build_object('open', '09:00', 'close', '18:00'),
      'tue', jsonb_build_object('open', '09:00', 'close', '18:00'),
      'wed', jsonb_build_object('open', '09:00', 'close', '18:00'),
      'thu', jsonb_build_object('open', '09:00', 'close', '18:00'),
      'fri', jsonb_build_object('open', '09:00', 'close', '18:00'),
      'sat', jsonb_build_object('open', '10:00', 'close', '16:00'),
      'sun', null
    ),
    15, 60, 30
  ),
  (
    'other',
    jsonb_build_object(
      'mon', jsonb_build_object('open', '09:00', 'close', '18:00'),
      'tue', jsonb_build_object('open', '09:00', 'close', '18:00'),
      'wed', jsonb_build_object('open', '09:00', 'close', '18:00'),
      'thu', jsonb_build_object('open', '09:00', 'close', '18:00'),
      'fri', jsonb_build_object('open', '09:00', 'close', '18:00'),
      'sat', jsonb_build_object('open', '10:00', 'close', '16:00'),
      'sun', null
    ),
    15, 60, 30
  )
on conflict (service_type, repair_variant, product_key, arch) do nothing;

-- ── Rollback ───────────────────────────────────────────────────────
-- drop function if exists public.lng_booking_type_resolve(text, text, text, text);
-- drop policy if exists lng_booking_type_config_admin_write on public.lng_booking_type_config;
-- drop policy if exists lng_booking_type_config_read on public.lng_booking_type_config;
-- drop trigger if exists lng_booking_type_config_set_updated_at on public.lng_booking_type_config;
-- drop index if exists public.lng_booking_type_config_service_idx;
-- drop index if exists public.lng_booking_type_config_key_uniq;
-- drop table if exists public.lng_booking_type_config;
