-- 20260519000004_lng_sms_templates_per_service.sql
--
-- Per-booking-type SMS templates + four new manually-sent template
-- keys. Mirrors the email-side shape in
-- 20260517000011_lng_email_templates_per_service.sql so admins manage
-- SMS the same way they already manage emails — General default plus
-- optional service-typed overrides.
--
-- Background:
--   • Until this migration there was a single visit_ready SMS row,
--     fired by the receptionist from the Visit page. Practical use
--     has surfaced other one-tap SMS the front desk wants (please
--     pop back to clinic, please call us, clinician running late,
--     day-of reminder), each of which should also customise per
--     booking type so a click-in-veneers reminder reads differently
--     to a denture-repair reminder.
--   • Virtual impression and in-person impression don't merit SMS
--     (those flows are scheduled / remote) so the per-service
--     surface is intentionally a shorter list than emails: General,
--     Click-in veneers, Same-day appliance, Denture repair.
--
-- New shape:
--   lng_sms_templates.service_type text NULL
--     null  → the General / default row for this template key.
--     '<*>' → click_in_veneers | same_day_appliance | denture_repair
--             (set, optionally, when an admin saves an override).
--
-- Lookup precedence: edge function calls lng_resolve_sms_template
-- and gets the service-specific row when present, falls back to
-- the General row otherwise.
--
-- Rollback:
--   alter table public.lng_sms_template_history drop column if exists service_type;
--   alter table public.lng_sms_templates drop column if exists service_type;
--   drop function if exists public.lng_resolve_sms_template(text, text);

-- ── 1. Drop the history FK first ─────────────────────────────────
-- The history FK currently references lng_sms_templates(key) via
-- the legacy UNIQUE(key) constraint. Drop the FK before touching
-- the templates table so the parent's unique constraint shape can
-- change without dependency errors.
alter table public.lng_sms_template_history
  drop constraint if exists lng_sms_template_history_template_key_fkey;

-- ── 2. lng_sms_templates ─────────────────────────────────────────

alter table public.lng_sms_templates
  add column if not exists service_type text null;

-- Replace the legacy UNIQUE(key) with UNIQUE NULLS NOT DISTINCT
-- (key, service_type). The original PK on id stays as-is.
alter table public.lng_sms_templates
  drop constraint if exists lng_sms_templates_key_key;

alter table public.lng_sms_templates
  drop constraint if exists lng_sms_templates_key_service_type_unique;

alter table public.lng_sms_templates
  add constraint lng_sms_templates_key_service_type_unique
  unique nulls not distinct (key, service_type);

-- ── 3. lng_sms_template_history ──────────────────────────────────

alter table public.lng_sms_template_history
  add column if not exists service_type text null;

-- Per-(key, service_type) version timeline so overrides keep their
-- own version history independent from the General row's.
drop index if exists lng_sms_template_history_key_service_version_unique;
create unique index lng_sms_template_history_key_service_version_unique
  on public.lng_sms_template_history (template_key, service_type, version)
  nulls not distinct;

alter table public.lng_sms_template_history
  add constraint lng_sms_template_history_template_key_fkey
  foreign key (template_key, service_type)
  references public.lng_sms_templates (key, service_type)
  on delete cascade;

create index if not exists lng_sms_template_history_key_service_saved_at_idx
  on public.lng_sms_template_history (template_key, service_type, saved_at desc);

-- ── 4. Lookup helper ─────────────────────────────────────────────

create or replace function public.lng_resolve_sms_template(
  p_key          text,
  p_service_type text
)
returns table (
  key          text,
  service_type text,
  body         text,
  enabled      boolean
)
language sql
stable
security invoker
set search_path = public
as $$
  select t.key, t.service_type, t.body, t.enabled
    from public.lng_sms_templates t
   where t.key = p_key
     and (t.service_type = p_service_type or t.service_type is null)
   order by t.service_type nulls last
   limit 1;
$$;

grant execute on function public.lng_resolve_sms_template(text, text)
  to authenticated, service_role;

comment on function public.lng_resolve_sms_template(text, text) is
  'Picks the right lng_sms_templates row for a given key + booking service_type. Prefers a service-specific override when present, falls back to the General (service_type=null) row.';

-- ── 5. Seed new General-row templates ────────────────────────────
--
-- All four bodies use the variable vocabulary the edge function
-- resolves at send time. Kept under 160 GSM-7 characters where
-- possible so they don't split into two paid segments by default;
-- placeholder length is forecast generously to make sure the seeded
-- copy still fits.
--
-- {{patientFirstName}} → patients.first_name (proper-cased)
-- {{clinicName}}       → locations.name (the Branding > Clinic info "Clinic name" field)
-- {{clinicPhone}}      → locations.phone (the Branding > Clinic info "Phone" field)
-- {{apptDate}}         → lng_appointments.start_at, formatted "Mon 25 May"
-- {{apptTime}}         → lng_appointments.start_at, formatted "14:30"
-- {{appointmentRef}}   → LAP-xxxxx, the booking reference patients already saw

insert into public.lng_sms_templates (key, service_type, body, default_body, description)
values
  (
    'please_return',
    null,
    'Hi {{patientFirstName}}, could you pop back into {{clinicName}} when you have a moment? Give us a ring on {{clinicPhone}} to arrange a time. Reference {{appointmentRef}}.',
    'Hi {{patientFirstName}}, could you pop back into {{clinicName}} when you have a moment? Give us a ring on {{clinicPhone}} to arrange a time. Reference {{appointmentRef}}.',
    '"Please pop back into clinic" — generic return-to-clinic SMS for follow-ups, refits or anything the receptionist wants to ask the patient to come back for that is not the visit-ready text.'
  ),
  (
    'please_call',
    null,
    'Hi {{patientFirstName}}, please give {{clinicName}} a quick call on {{clinicPhone}} when you can. Reference {{appointmentRef}}.',
    'Hi {{patientFirstName}}, please give {{clinicName}} a quick call on {{clinicPhone}} when you can. Reference {{appointmentRef}}.',
    '"Please call us back" — asks the patient to ring the clinic. Used when something needs a conversation rather than a hand-back.'
  ),
  (
    'running_late',
    null,
    'Hi {{patientFirstName}}, your clinician at {{clinicName}} is running a little behind today. We will be with you for your {{apptTime}} appointment as soon as we can. Sorry for the wait.',
    'Hi {{patientFirstName}}, your clinician at {{clinicName}} is running a little behind today. We will be with you for your {{apptTime}} appointment as soon as we can. Sorry for the wait.',
    '"Clinician running late" — sent before the patient arrives when the clinician is running behind on the day. Heads off a walk-in to a waiting room.'
  ),
  (
    'reminder_to_attend',
    null,
    'Hi {{patientFirstName}}, a quick reminder of your appointment at {{clinicName}} on {{apptDate}} at {{apptTime}}. Call {{clinicPhone}} if you cannot make it. Reference {{appointmentRef}}.',
    'Hi {{patientFirstName}}, a quick reminder of your appointment at {{clinicName}} on {{apptDate}} at {{apptTime}}. Call {{clinicPhone}} if you cannot make it. Reference {{appointmentRef}}.',
    '"Reminder to attend" — day-of nudge for an upcoming appointment. Manually sent (the automated reminders flow lives in the email-templates table).'
  )
on conflict (key, service_type) do nothing;

-- Refresh the visit_ready default to use {{clinicName}} alongside
-- {{locationName}}. Both names resolve to the same field today
-- (locations.name, edited via Branding > Clinic info), but the
-- editor variable list lists clinicName as the canonical token
-- alongside the other clinic-* placeholders. Leave the body alone
-- if an admin has already edited it; only nudge default_body so
-- "Reset to default" picks up the new wording.
update public.lng_sms_templates
   set default_body = 'Hi {{patientFirstName}}, your {{itemLabel}} is ready to collect at {{clinicName}}. Call {{clinicPhone}} if you cannot make it. Reference {{appointmentRef}}.'
 where key = 'visit_ready'
   and service_type is null;
