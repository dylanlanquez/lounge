-- 20260517000011_lng_email_templates_per_service.sql
--
-- Per-booking-type email templates. Until this migration each
-- template key (booking_confirmation, appointment_reminder, …) had
-- exactly one row in lng_email_templates — every appointment booked
-- the same copy regardless of service. Operators want to write
-- distinct copy per booking type (denture-repair confirmation reads
-- differently than click-in-veneers confirmation) AND still have a
-- "General" fallback for service types they haven't customised.
--
-- New shape:
--
--   lng_email_templates.service_type text NULL
--     null  → the General / default row for this template key. Used
--             by the edge functions when no service-specific row
--             exists for the booking's service_type.
--     '*'   → a specific service ('click_in_veneers',
--             'denture_repair', 'same_day_appliance',
--             'impression_appointment',
--             'virtual_impression_appointment'). Overrides the
--             General row for bookings of that service.
--
-- Lookup precedence (edge functions): match on (key, service_type)
-- first, fall back to (key, NULL). Existing rows keep working as
-- the Generals because they all become service_type=NULL.
--
-- The history table gains a parallel service_type column + FK so
-- restoring an older version of a service-specific override doesn't
-- clobber the General default.
--
-- Schema move:
--   * Postgres PRIMARY KEYs can't contain NULLs, so the old PK on
--     `key` is swapped for a synthetic uuid `id` PK.
--   * A UNIQUE NULLS NOT DISTINCT constraint on (key, service_type)
--     enforces "one row per (key, service_type)", including at most
--     one General row per key.
--
-- Idempotent: guarded with IF NOT EXISTS / IF EXISTS. Re-runs are
-- safe.

-- ── 1. lng_email_templates ────────────────────────────────────────

alter table public.lng_email_templates
  add column if not exists service_type text null;

alter table public.lng_email_templates
  add column if not exists id uuid not null default gen_random_uuid();

-- Drop the history FK before touching the parent PK so we can
-- recreate it later against the new key shape.
alter table public.lng_email_template_history
  drop constraint if exists lng_email_template_history_template_key_fkey;

-- Drop the existing PK on `key` so it can be replaced with the
-- synthetic id PK.
alter table public.lng_email_templates
  drop constraint if exists lng_email_templates_pkey;

alter table public.lng_email_templates
  add constraint lng_email_templates_pkey primary key (id);

-- Enforce one row per (key, service_type) — NULLS NOT DISTINCT so
-- multiple NULL service_type entries for one key still collide.
alter table public.lng_email_templates
  drop constraint if exists lng_email_templates_key_service_type_unique;

alter table public.lng_email_templates
  add constraint lng_email_templates_key_service_type_unique
  unique nulls not distinct (key, service_type);

-- ── 2. lng_email_template_history ─────────────────────────────────

alter table public.lng_email_template_history
  add column if not exists service_type text null;

-- Drop the legacy (template_key, version) unique so a service-
-- specific override can keep its own version timeline alongside
-- the General row at the same version number.
alter table public.lng_email_template_history
  drop constraint if exists lng_email_template_history_key_version_unique;

create unique index if not exists lng_email_template_history_key_service_version_unique
  on public.lng_email_template_history (template_key, service_type, version)
  nulls not distinct;

-- Re-add the parent FK now that both sides know about service_type.
-- References the (key, service_type) unique constraint added above.
alter table public.lng_email_template_history
  add constraint lng_email_template_history_template_key_fkey
  foreign key (template_key, service_type)
  references public.lng_email_templates (key, service_type)
  on delete cascade;

-- Faster lookup for the history list pane in admin.
create index if not exists lng_email_template_history_key_service_saved_at_idx
  on public.lng_email_template_history (template_key, service_type, saved_at desc);

-- ── 3. Lookup helper ──────────────────────────────────────────────

create or replace function public.lng_resolve_email_template(
  p_key          text,
  p_service_type text
)
returns table (
  key          text,
  service_type text,
  subject      text,
  body_syntax  text,
  enabled      boolean
)
language sql
stable
security invoker
set search_path = public
as $$
  select t.key, t.service_type, t.subject, t.body_syntax, t.enabled
    from public.lng_email_templates t
   where t.key = p_key
     and (t.service_type = p_service_type or t.service_type is null)
   order by t.service_type nulls last
   limit 1;
$$;

grant execute on function public.lng_resolve_email_template(text, text)
  to authenticated, service_role;

comment on function public.lng_resolve_email_template(text, text) is
  'Picks the right lng_email_templates row for a given key + booking service_type. Prefers a service-specific override when present, falls back to the General (service_type=null) row.';
