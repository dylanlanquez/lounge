-- 20260521000004_lng_appointment_staff_notes.sql
--
-- Replaces the single-text lng_appointments.notes field with a proper
-- multi-note table backed by an audit trail.
--
-- Why now: the previous model was a single textarea that staff
-- routinely prefixed with "From X:" so anyone reading the card knew
-- who wrote it. The byline lived in the body, edits silently
-- clobbered each other, and deletions left no trace. New model:
--
--   * one row per note
--   * author captured at insert from auth_account_id()
--   * soft delete with a required reason
--   * every add / amend / delete writes a patient_events row for
--     the timeline + audit
--
-- The lng_appointments.notes column stays in place (dead data) and
-- gets dropped in a follow-up migration once every read site has
-- been moved off it. The notes-only patch path in editAppointment
-- still works against it without crashing if anything reaches that
-- code path, but the StaffNotesCard never touches it.

-- ── 1. Table ────────────────────────────────────────────────────
create table public.lng_appointment_staff_notes (
  id                       uuid primary key default gen_random_uuid(),
  appointment_id           uuid not null references public.lng_appointments(id) on delete cascade,
  -- Resolved from auth_account_id() at insert time. Nullable for
  -- backfill rows whose original author can't be traced through the
  -- audit trail; the UI renders "Unknown" for those.
  author_account_id        uuid references public.accounts(id) on delete set null,
  body                     text not null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  -- Soft delete. The note row stays so the audit trail and timeline
  -- can still resolve note_id → author + content, but it disappears
  -- from the active card.
  deleted_at               timestamptz,
  deleted_by_account_id    uuid references public.accounts(id) on delete set null,
  delete_reason            text,

  -- Body must be non-blank. Empty notes have no business existing.
  constraint lng_appointment_staff_notes_body_nonblank
    check (length(btrim(body)) > 0),

  -- Soft-delete shape is all-or-nothing: deleted_at, deleted_by, and
  -- a non-blank reason move together. Half-deleted rows would let a
  -- "ghost" note linger in the audit without any record of why.
  constraint lng_appointment_staff_notes_delete_shape
    check (
      (deleted_at is null and deleted_by_account_id is null and delete_reason is null)
      or
      (deleted_at is not null
        and deleted_by_account_id is not null
        and delete_reason is not null
        and length(btrim(delete_reason)) > 0)
    )
);

-- Hot read: every appointment detail card pulls the latest non-
-- deleted note then the rest of the stack on demand. Sort newest
-- first so the renderer doesn't have to.
create index lng_appointment_staff_notes_apt_created_idx
  on public.lng_appointment_staff_notes (appointment_id, created_at desc);

-- Active-note count lookups (the "View N older notes" disclosure
-- count, plus any badges showing "this appointment has notes").
-- Partial index because deleted rows shouldn't widen the index.
create index lng_appointment_staff_notes_apt_active_idx
  on public.lng_appointment_staff_notes (appointment_id)
  where deleted_at is null;

-- updated_at trigger so amend writes carry a fresh timestamp without
-- the caller having to remember.
create trigger lng_appointment_staff_notes_set_updated_at
  before update on public.lng_appointment_staff_notes
  for each row execute function public.touch_updated_at();

-- ── 2. RLS ───────────────────────────────────────────────────────
alter table public.lng_appointment_staff_notes enable row level security;

-- Same access shape as the canonical lng_appointments policy in
-- 20260513000008_lng_staff_universal_access.sql: any lng staff or
-- super admin can read/write/soft-delete. Location isolation lives
-- on the parent appointment; if the appointment is readable, its
-- notes are.
create policy lng_appointment_staff_notes_staff_select
  on public.lng_appointment_staff_notes for select
  to authenticated
  using (public.auth_is_lng_staff() or public.auth_is_super_admin());

create policy lng_appointment_staff_notes_staff_insert
  on public.lng_appointment_staff_notes for insert
  to authenticated
  with check (public.auth_is_lng_staff() or public.auth_is_super_admin());

create policy lng_appointment_staff_notes_staff_update
  on public.lng_appointment_staff_notes for update
  to authenticated
  using (public.auth_is_lng_staff() or public.auth_is_super_admin())
  with check (public.auth_is_lng_staff() or public.auth_is_super_admin());

-- No DELETE policy on purpose. The product is soft-delete-only:
-- deletes go through an UPDATE that sets deleted_at + delete_reason
-- via the check constraint above. A hard DELETE would erase the
-- row that note_id-keyed patient_events rows point to, breaking the
-- audit trail rendering.

-- ── 3. Backfill from lng_appointments.notes ──────────────────────
--
-- Every appointment whose notes column carries something worth
-- preserving becomes one note row. "Worth preserving" = not null,
-- non-blank, and not the legacy "None" literal that older rows hold
-- (see isMeaningfulNotes in EditBookingSheet for the existing
-- escape hatch).
--
-- Author resolution: walk patient_events for the most recent
-- appointment_edited row whose payload mentions a notes change,
-- and lift its actor_account_id. Falls back to NULL when no such
-- row exists (legacy data with no audit trail).
--
-- created_at: use the latest notes-touching event timestamp when we
-- have one, else fall back to the appointment's own created_at.

with notes_meta as (
  select
    a.id as appointment_id,
    btrim(a.notes) as body,
    a.created_at as appointment_created_at,
    (
      select pe.actor_account_id
        from public.patient_events pe
       where pe.event_type = 'appointment_edited'
         and pe.payload->>'appointment_id' = a.id::text
         and pe.payload->'changes'->'notes' is not null
       order by pe.created_at desc
       limit 1
    ) as author_account_id,
    (
      select pe.created_at
        from public.patient_events pe
       where pe.event_type = 'appointment_edited'
         and pe.payload->>'appointment_id' = a.id::text
         and pe.payload->'changes'->'notes' is not null
       order by pe.created_at desc
       limit 1
    ) as note_created_at
  from public.lng_appointments a
  where a.notes is not null
    and length(btrim(a.notes)) > 0
    and lower(btrim(a.notes)) <> 'none'
)
insert into public.lng_appointment_staff_notes
  (appointment_id, author_account_id, body, created_at, updated_at)
select
  appointment_id,
  author_account_id,
  body,
  coalesce(note_created_at, appointment_created_at, now()),
  coalesce(note_created_at, appointment_created_at, now())
from notes_meta;
