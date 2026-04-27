-- 20260428_12_lng_event_log_system_failures.sql
-- Two append-only logs:
--   lng_event_log         operational events (sign-in, terminal connect, idle lock, ...)
--   lng_system_failures   structured failure sink (one row per unexpected condition)
--
-- Patient-axis events go to public.patient_events instead — reuse, do not duplicate.
--
-- Per brief §1, §8.6, and `01-architecture-decision.md`.
--
-- Rollback: DROP TABLE lng_system_failures, lng_event_log;

create table public.lng_event_log (
  id           uuid primary key default gen_random_uuid(),
  occurred_at  timestamptz not null default now(),
  source       text not null,
  event_type   text not null,
  payload      jsonb,
  account_id   uuid references public.accounts(id) on delete set null,
  location_id  uuid references public.locations(id) on delete set null,
  device_id    text
);

create index lng_event_log_source_event_idx on public.lng_event_log (source, event_type);
create index lng_event_log_occurred_idx     on public.lng_event_log (occurred_at desc);
create index lng_event_log_location_idx     on public.lng_event_log (location_id);

create table public.lng_system_failures (
  id                uuid primary key default gen_random_uuid(),
  occurred_at       timestamptz not null default now(),
  source            text not null,
  severity          text not null check (severity in ('info', 'warning', 'error', 'critical')),
  message           text not null,
  context           jsonb default '{}'::jsonb,
  user_id           uuid references public.accounts(id) on delete set null,
  location_id       uuid references public.locations(id) on delete set null,
  resolved_at       timestamptz,
  resolved_by       uuid references public.accounts(id) on delete set null,
  resolution_notes  text
);

create index lng_system_failures_severity_idx
  on public.lng_system_failures (severity, occurred_at desc);
create index lng_system_failures_unresolved_idx
  on public.lng_system_failures (occurred_at desc)
  where resolved_at is null;

comment on table public.lng_event_log is
  'Operational event log. Lounge-internal only. Patient-axis events go to public.patient_events.';
comment on table public.lng_system_failures is
  'Structured failure sink. Every catch-that-doesn''t-rethrow writes here. /admin/failures surfaces unresolved rows.';
