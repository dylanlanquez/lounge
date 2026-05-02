-- 20260502000002_lng_email_templates.sql
--
-- Email template system for transactional emails the admin can edit
-- without a redeploy. Modelled after the Checkpoint admin "snippets"
-- surface (TipTap editor, markdown-like storage syntax, version
-- history, reset-to-default).
--
-- Phase 1 covers a single template: the 24h-before appointment
-- reminder. The schema is built so future templates (booking
-- confirmation, cancellation, reschedule, deposit reminder, etc) can
-- migrate onto it without further DDL — just seed a new row.
--
-- ── Storage format ────────────────────────────────────────────────
--
-- body_syntax is a markdown-like string with these extensions:
--
--   ## H2                 heading level 2
--   ### H3                heading level 3
--   **bold**              bold
--   *italic*              italic
--   ---                   horizontal rule
--   - item                bullet list (one per line)
--   {color:#hex}…{/color} inline coloured text
--   [label](url)          plain link
--   ![alt](url)           image
--   [button:label|bg|tc|radius|mt|mb](url)
--                         styled button: label, bg colour, text
--                         colour, border-radius (px), margin-top (px),
--                         margin-bottom (px), and the click URL
--
-- Variables are interpolated at send time via {{var_name}}.
--
-- The renderer (src/lib/emailRenderer.ts + the parallel Deno copy in
-- the edge function) is the only place this syntax becomes HTML.
-- Single source of truth, ports verbatim from Checkpoint where the
-- pattern is proven.
--
-- ── Why a dedicated table, not lng_settings ───────────────────────
--
-- Email templates have multiple fields per row (subject + body +
-- defaults + version), need foreign-key references for the version
-- history append-log, and have stricter RLS (admin write, all-
-- authenticated read). Stuffing them into lng_settings's jsonb
-- value would lose all of that and make the admin UI fight the
-- schema. Dedicated table is the correct call.
--
-- Rollback:
--   DROP TABLE public.lng_email_template_history;
--   DROP TABLE public.lng_email_templates;
--   ALTER TABLE public.lng_appointments DROP COLUMN reminder_sent_at;

-- ── 1. lng_email_templates ────────────────────────────────────────

create table if not exists public.lng_email_templates (
  -- Stable string key. Identifies the template across code paths.
  -- e.g. 'appointment_reminder', 'booking_confirmation'.
  key                  text primary key,
  -- Current subject. Variables welcome ({{serviceLabel}} etc).
  subject              text not null,
  -- Current body in the markdown-like syntax described above.
  body_syntax          text not null,
  -- The seeded original copy. Powers the "reset to default" button
  -- in the admin so the admin can always get back to a known-good
  -- baseline if they break their custom version.
  default_subject      text not null,
  default_body_syntax  text not null,
  -- Increments on every save. Pairs with lng_email_template_history
  -- so a row's version always equals the number of saves.
  version              int not null default 1 check (version > 0),
  -- Optional human-readable description for the admin UI list. Not
  -- shown to recipients.
  description          text,
  -- Whether the cron / sender path actually fires. Defaults true.
  -- Set false if an admin wants to pause a template without losing
  -- the copy.
  enabled              boolean not null default true,
  updated_at           timestamptz not null default now(),
  updated_by           uuid references public.accounts(id) on delete set null
);

create trigger lng_email_templates_set_updated_at
  before update on public.lng_email_templates
  for each row execute function public.touch_updated_at();

alter table public.lng_email_templates enable row level security;

-- Read: any signed-in user (so the edge function can read with
-- the user JWT in test mode, and the admin tab can render the
-- list). Recipients of the eventual email never query this table.
create policy lng_email_templates_read
  on public.lng_email_templates
  for select to authenticated using (true);

-- Write: lng admins + super admins only. This is configuration
-- surface, same access control as booking types and resource pools.
create policy lng_email_templates_admin_write
  on public.lng_email_templates
  for all to authenticated
  using (public.auth_is_lng_admin() or public.auth_is_super_admin())
  with check (public.auth_is_lng_admin() or public.auth_is_super_admin());

comment on table public.lng_email_templates is
  'Editable email templates. body_syntax is the markdown-like format with custom button / colour / image extensions; rendered to HTML at send time by src/lib/emailRenderer. default_* lets the admin reset to the seeded baseline. enabled=false pauses sending without losing copy.';

-- ── 2. lng_email_template_history ─────────────────────────────────
--
-- Append-only log of every save. Lets the admin scroll through
-- previous versions and restore one click. version on the parent
-- row equals the highest version in the history. Saving snapshots
-- the old row before applying the new one, so the history is
-- complete from version 1 onwards.

create table if not exists public.lng_email_template_history (
  id            uuid primary key default gen_random_uuid(),
  template_key  text not null references public.lng_email_templates(key) on delete cascade,
  version       int not null check (version > 0),
  subject       text not null,
  body_syntax   text not null,
  saved_at      timestamptz not null default now(),
  saved_by      uuid references public.accounts(id) on delete set null
);

create unique index lng_email_template_history_key_version_unique
  on public.lng_email_template_history (template_key, version);
create index lng_email_template_history_key_saved_at_idx
  on public.lng_email_template_history (template_key, saved_at desc);

alter table public.lng_email_template_history enable row level security;

create policy lng_email_template_history_read
  on public.lng_email_template_history
  for select to authenticated using (true);

create policy lng_email_template_history_admin_insert
  on public.lng_email_template_history
  for insert to authenticated
  with check (public.auth_is_lng_admin() or public.auth_is_super_admin());

-- No update or delete on history rows — append-only audit log.

comment on table public.lng_email_template_history is
  'Append-only history of every save to lng_email_templates. (template_key, version) is unique. The admin UI reads this for the "earlier versions" dropdown and the restore action.';

-- ── 3. reminder_sent_at on lng_appointments ───────────────────────
--
-- The sweep that sends reminders needs to know which appointments
-- have already been notified. Query: WHERE status='booked' AND
-- start_at BETWEEN now+23h AND now+25h AND reminder_sent_at IS NULL.
-- Stamping reminder_sent_at on send is what makes the sweep
-- idempotent against the hourly cron firing.

alter table public.lng_appointments
  add column if not exists reminder_sent_at timestamptz;

-- Filtered index for the sweep. Excludes Calendly-source rows
-- because Calendly sends its own reminders (we'd duplicate); also
-- excludes terminal statuses because they're not eligible.
create index if not exists lng_appointments_reminder_sweep_idx
  on public.lng_appointments (start_at)
  where status = 'booked'
    and reminder_sent_at is null
    and source <> 'calendly';

comment on column public.lng_appointments.reminder_sent_at is
  '24h-before reminder send timestamp. NULL = not yet sent. Stamped by send-appointment-reminders edge function on successful Resend dispatch. Index lng_appointments_reminder_sweep_idx is the cron sweep target.';

-- ── 4. Seed: appointment_reminder template ────────────────────────
--
-- Production-ready default. Lands on every clinic out of the box;
-- admins can edit copy via the admin UI but emails work cleanly
-- before any edit happens.

insert into public.lng_email_templates (
  key, subject, body_syntax, default_subject, default_body_syntax,
  description, enabled
) values (
  'appointment_reminder',
  'Reminder · {{serviceLabel}} tomorrow at {{appointmentTime}}',
$DEFAULT$Hi {{patientFirstName}},

A friendly reminder that you have an appointment with us tomorrow.

## {{appointmentDateTime}}

**{{serviceLabel}}**
{{locationName}}

If something has changed and you can no longer make it, just reply to this email and we will find another slot that works.

See you soon,
The Venneir Lounge team$DEFAULT$,
  'Reminder · {{serviceLabel}} tomorrow at {{appointmentTime}}',
$DEFAULT$Hi {{patientFirstName}},

A friendly reminder that you have an appointment with us tomorrow.

## {{appointmentDateTime}}

**{{serviceLabel}}**
{{locationName}}

If something has changed and you can no longer make it, just reply to this email and we will find another slot that works.

See you soon,
The Venneir Lounge team$DEFAULT$,
  'Sent automatically 24 hours before each native booking. Patient gets a friendly nudge with the slot details.',
  true
)
on conflict (key) do nothing;

-- Seed the initial history row so version 1 is always present.
insert into public.lng_email_template_history (template_key, version, subject, body_syntax)
select key, version, subject, body_syntax
from public.lng_email_templates
where key = 'appointment_reminder'
on conflict (template_key, version) do nothing;
