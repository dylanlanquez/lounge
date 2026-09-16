-- 20260916000001_lng_voice_call_log.sql
--
-- The call record. Dylan, 16 Sep 2026: "for the voice calls... i want
-- a record of notes at the bottom, imagine a call center... It would
-- be beneficial for the agent to see previous calls."
--
-- One row per logged attempt at a voice call: the outcome (answered,
-- no answer, left voicemail, wrong number, busy, call back requested)
-- and an optional note, stamped with who logged it and when. This is
-- the single source for two surfaces:
--   * the "Call record" card on the appointment page — every attempt
--     logged against THIS booking, in order;
--   * the "Previous calls" list for a patient — every past voice call
--     appointment, its outcome, and its note, across the patient's
--     whole history.
--
-- Append-only, like lng_appointment_staff_notes: no UPDATE/DELETE
-- policy. A mis-logged call is corrected with "Reverse" on the
-- appointment (resets it to booked so it can be logged again), not by
-- editing history — the log stays a true record of what was tried.
--
-- The appointment's own status is the derived, current-state field
-- (complete when answered, no_show otherwise) — same status values
-- the rest of the app already reads everywhere (Schedule, Ledger,
-- reports). This table is the detail behind that state, not a
-- replacement for it.

begin;

create table public.lng_voice_call_log (
  id              uuid primary key default gen_random_uuid(),
  appointment_id  uuid not null references public.lng_appointments(id) on delete cascade,
  patient_id      uuid not null references public.patients(id) on delete cascade,
  outcome         text not null check (outcome in (
                    'answered', 'no_answer', 'voicemail',
                    'wrong_number', 'busy', 'call_back_requested'
                  )),
  note            text,
  created_by      uuid references public.accounts(id) on delete set null,
  created_at      timestamptz not null default now()
);

comment on table public.lng_voice_call_log is
  'One row per logged voice call attempt: outcome + optional note. Append-only — a mis-logged call is corrected by reversing the appointment back to booked and logging again, not by editing this table. Drives the Call record card (per appointment) and the Previous calls history (per patient).';
comment on column public.lng_voice_call_log.outcome is
  'answered | no_answer | voicemail | wrong_number | busy | call_back_requested. "answered" moves the appointment to complete; every other value moves it to no_show (same status the rest of the app already uses for a missed slot).';

create index lng_voice_call_log_appointment_idx
  on public.lng_voice_call_log (appointment_id, created_at desc);
create index lng_voice_call_log_patient_idx
  on public.lng_voice_call_log (patient_id, created_at desc);

alter table public.lng_voice_call_log enable row level security;

create policy lng_voice_call_log_select
  on public.lng_voice_call_log
  for select to authenticated using (true);

create policy lng_voice_call_log_insert
  on public.lng_voice_call_log
  for insert to authenticated with check (true);

-- No update/delete policy on purpose (see header) — matches
-- lng_appointment_staff_notes' soft-delete-only convention, taken one
-- step further here since there is nothing to soft-delete: the log
-- entry is simply a historical fact.

grant select, insert on public.lng_voice_call_log to authenticated;

commit;

notify pgrst, 'reload schema';

-- ── Rollback ──────────────────────────────────────────────────────
-- drop table if exists public.lng_voice_call_log;
