-- ─────────────────────────────────────────────────────────────────────────────
-- Lounge — SMS templates + sent-message audit
--
-- Adds a thin SMS-template store alongside lng_email_templates so admins
-- can edit the body of every transactional text message Lounge sends, and
-- a sent-message audit table mirroring lng_email_messages so the
-- patient timeline can attribute who sent what.
--
-- Single template seeded today: `visit_ready` — the "your appliance /
-- repair is ready to collect" text the receptionist fires from the
-- Visit page after the patient's been marked arrived. Hardcoded body
-- in send-appointment-sms-reminders has its own future migration to
-- read from a `appointment_reminder` row here when we add a second
-- template shape, per the TODO in that function's header.
--
-- Schema notes:
--   • body — the editable, currently-active text
--   • default_body — the seed text, locked in code; "Reset to default"
--     in Admin restores this verbatim. Same pattern as lng_email_
--     templates.default_*.
--   • version — monotonically increasing on each save so the editor
--     can warn on stale-load conflicts.
--   • enabled — admin can pause the template without deleting it.
--   • description — short admin-facing blurb; not displayed to patients.
--
-- Rollback:
--   drop table public.lng_sms_messages;
--   drop table public.lng_sms_template_history;
--   drop table public.lng_sms_templates;
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Templates ────────────────────────────────────────────────────
create table if not exists public.lng_sms_templates (
  id            uuid primary key default gen_random_uuid(),
  key           text not null unique,
  body          text not null,
  default_body  text not null,
  description   text,
  version       integer not null default 1 check (version > 0),
  enabled       boolean not null default true,
  updated_at    timestamptz not null default now(),
  updated_by    uuid references public.accounts(id) on delete set null
);

create index if not exists lng_sms_templates_key_idx
  on public.lng_sms_templates (key);

alter table public.lng_sms_templates enable row level security;

-- Admin / super-admin can read + write everything.
create policy lng_sms_templates_admin_all on public.lng_sms_templates
  for all
  to authenticated
  using (
    exists (
      select 1 from public.accounts a
       where a.auth_user_id = auth.uid()
         and (
           a.account_type = 'admin'
           or 'admin' = any (a.account_types)
         )
    )
  )
  with check (
    exists (
      select 1 from public.accounts a
       where a.auth_user_id = auth.uid()
         and (
           a.account_type = 'admin'
           or 'admin' = any (a.account_types)
         )
    )
  );

-- Receptionists / clinicians need to READ the body to render the
-- in-app preview before sending. They don't need write access.
create policy lng_sms_templates_staff_select on public.lng_sms_templates
  for select
  to authenticated
  using (
    exists (
      select 1 from public.accounts a
       where a.auth_user_id = auth.uid()
    )
  );

-- ── Edit history (mirrors lng_email_template_history) ────────────
create table if not exists public.lng_sms_template_history (
  id            uuid primary key default gen_random_uuid(),
  template_key  text not null references public.lng_sms_templates(key) on delete cascade,
  version       integer not null,
  body          text not null,
  saved_by      uuid references public.accounts(id) on delete set null,
  saved_at      timestamptz not null default now()
);
create index if not exists lng_sms_template_history_key_idx
  on public.lng_sms_template_history (template_key, version desc);

alter table public.lng_sms_template_history enable row level security;
create policy lng_sms_template_history_admin_all on public.lng_sms_template_history
  for all
  to authenticated
  using (
    exists (
      select 1 from public.accounts a
       where a.auth_user_id = auth.uid()
         and (
           a.account_type = 'admin'
           or 'admin' = any (a.account_types)
         )
    )
  )
  with check (
    exists (
      select 1 from public.accounts a
       where a.auth_user_id = auth.uid()
         and (
           a.account_type = 'admin'
           or 'admin' = any (a.account_types)
         )
    )
  );

-- ── Sent-SMS audit (mirrors lng_email_messages) ──────────────────
create table if not exists public.lng_sms_messages (
  id                  uuid primary key default gen_random_uuid(),
  patient_id          uuid references public.patients(id) on delete set null,
  visit_id            uuid references public.lng_visits(id) on delete set null,
  appointment_id      uuid references public.lng_appointments(id) on delete set null,
  location_id         uuid references public.locations(id) on delete set null,
  template_key        text,
  to_phone            text not null,
  body                text not null,
  send_status         text not null check (send_status in ('sent', 'failed', 'pending')),
  send_error          text,
  twilio_message_sid  text,
  sent_by             uuid references public.accounts(id) on delete set null,
  sent_at             timestamptz not null default now()
);
create index if not exists lng_sms_messages_patient_idx
  on public.lng_sms_messages (patient_id, sent_at desc);
create index if not exists lng_sms_messages_visit_idx
  on public.lng_sms_messages (visit_id, sent_at desc);

alter table public.lng_sms_messages enable row level security;
create policy lng_sms_messages_admin_all on public.lng_sms_messages
  for all
  to authenticated
  using (
    exists (
      select 1 from public.accounts a
       where a.auth_user_id = auth.uid()
         and (
           a.account_type = 'admin'
           or 'admin' = any (a.account_types)
         )
    )
  )
  with check (
    exists (
      select 1 from public.accounts a
       where a.auth_user_id = auth.uid()
         and (
           a.account_type = 'admin'
           or 'admin' = any (a.account_types)
         )
    )
  );
-- Staff need SELECT for the appointment / visit timeline to show
-- "SMS sent to <last4>" rows. INSERT happens server-side via the
-- send-visit-ready-sms function (service-role bypasses RLS).
create policy lng_sms_messages_staff_select on public.lng_sms_messages
  for select
  to authenticated
  using (
    exists (
      select 1 from public.accounts a
       where a.auth_user_id = auth.uid()
    )
  );

-- ── Seed the visit_ready template ────────────────────────────────
-- {{itemLabel}}  → the appliance / repair label resolved server-
--                  side from the visit's appointment service / product
-- {{lwoRef}}     → patients.lwo_ref (Lounge Workshop Order ref)
-- {{patientFirstName}} → patients.first_name
-- {{locationName}} → locations.name
insert into public.lng_sms_templates (key, body, default_body, description)
values (
  'visit_ready',
  'Hi {{patientFirstName}}, your {{itemLabel}} is ready to collect at {{locationName}}. Call us if you can''t make it. Reference {{lwoRef}}.',
  'Hi {{patientFirstName}}, your {{itemLabel}} is ready to collect at {{locationName}}. Call us if you can''t make it. Reference {{lwoRef}}.',
  '"Your appliance/repair is ready" — fired from the Visit page after the patient is marked arrived, when the receptionist confirms the work is ready to hand back.'
)
on conflict (key) do nothing;
