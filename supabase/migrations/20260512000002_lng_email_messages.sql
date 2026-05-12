-- lng_email_messages: persisted record of every transactional email Lounge
-- sends to a patient. The Timeline's "View email" button reads this row and
-- renders `html` in a sandboxed iframe so staff see exactly what the
-- recipient received — booking confirmations, reschedules, reminders,
-- cancellations, receipts, dispatch confirmations.
--
-- The row also acts as a deliverability audit: provider_message_id ties
-- each send to the corresponding Resend dashboard event, and send_status /
-- send_error capture failed dispatches so a failure shows up alongside a
-- success in the same surface.
--
-- Scoping columns (patient_id, appointment_id, visit_id, location_id) are
-- nullable because not every email is patient-scoped: a staff invite or
-- self-test send leaves patient_id null. The timelines filter on
-- appointment_id / visit_id; admin views can still query everything via
-- location_id + RLS.

create table public.lng_email_messages (
  id                    uuid primary key default gen_random_uuid(),
  created_at            timestamptz not null default now(),
  sent_at               timestamptz,
  patient_id            uuid references public.patients(id)         on delete cascade,
  appointment_id        uuid references public.lng_appointments(id) on delete cascade,
  visit_id              uuid references public.lng_visits(id)       on delete cascade,
  location_id           uuid references public.locations(id)        on delete set null,
  template_key          text,
  -- Free-text categorisation. Examples: 'appointment_confirmation',
  -- 'appointment_reshedule', 'appointment_cancellation',
  -- 'appointment_reminder', 'receipt', 'dispatch_confirmation',
  -- 'template_test', 'magic_link', 'password_reset', 'staff_invite'.
  -- Used by the timeline + admin filters; the actual event_type on
  -- patient_events still drives Title/Tone.
  kind                  text,
  subject               text not null,
  html                  text not null,
  body_text             text,
  to_email              text not null,
  from_email            text,
  reply_to              text,
  provider              text not null default 'resend',
  provider_message_id   text,
  send_status           text not null default 'sent'
                        check (send_status in ('sent', 'failed')),
  send_error            text,
  sent_by_account_id    uuid references public.accounts(id) on delete set null
);

create index lng_email_messages_patient_idx     on public.lng_email_messages (patient_id, created_at desc);
create index lng_email_messages_appointment_idx on public.lng_email_messages (appointment_id, created_at desc);
create index lng_email_messages_visit_idx       on public.lng_email_messages (visit_id, created_at desc);
create index lng_email_messages_location_idx    on public.lng_email_messages (location_id, created_at desc);
create unique index lng_email_messages_provider_id_idx
  on public.lng_email_messages (provider, provider_message_id)
  where provider_message_id is not null;

comment on table public.lng_email_messages is
  'Persisted record of every transactional email sent from Lounge. Powers the Timeline "View email" preview.';

-- ── Row-level security ─────────────────────────────────────────────────────
-- Mirrors patients.patients_select: admins see all, staff see rows scoped
-- to the same location. Service role bypasses RLS so every edge function
-- can insert regardless of which patient / appointment the email is for.

alter table public.lng_email_messages enable row level security;

drop policy if exists lng_email_messages_select on public.lng_email_messages;
create policy lng_email_messages_select on public.lng_email_messages
  for select to authenticated
  using (
    public.is_admin()
    or location_id = public.auth_location_id()
  );

-- No insert / update / delete policies for authenticated — writes only
-- happen via service_role inside edge functions. Trying to insert from
-- the client would no-op silently, which is the desired posture (the
-- table is a server-side audit log).

NOTIFY pgrst, 'reload schema';
