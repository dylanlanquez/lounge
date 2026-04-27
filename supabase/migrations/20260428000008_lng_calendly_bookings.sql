-- 20260428_08_lng_calendly_bookings.sql
-- Raw payload sink for Calendly webhooks. delivery_id is the idempotency key.
-- Each delivery is verified (HMAC-SHA256) before insertion; processed_at is set
-- once identity-resolution + lng_appointments insertion is complete.
--
-- Per `03-calendly-audit.md §9` and brief §4.3.
--
-- Rollback: DROP TABLE public.lng_calendly_bookings;

create table public.lng_calendly_bookings (
  id                       uuid primary key default gen_random_uuid(),
  delivery_id              text not null unique,
  event                    text not null
                              check (event in ('invitee.created', 'invitee.canceled',
                                               'routing_form_submission.created')),
  payload                  jsonb not null,
  signature_verified_at    timestamptz not null default now(),
  processed_at             timestamptz,
  appointment_id           uuid references public.lng_appointments(id) on delete set null,
  failure_reason           text,
  created_at               timestamptz not null default now()
);

create index lng_calendly_bookings_event_created_idx
  on public.lng_calendly_bookings (event, created_at desc);
create index lng_calendly_bookings_unprocessed_idx
  on public.lng_calendly_bookings (created_at)
  where processed_at is null;

comment on table public.lng_calendly_bookings is
  'Raw Calendly webhook payload sink. delivery_id is the idempotency key (Calendly''s webhook delivery UUID). Duplicate deliveries return 200 with no side effects.';
