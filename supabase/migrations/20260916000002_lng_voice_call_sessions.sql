-- 20260916000002_lng_voice_call_sessions.sql
--
-- Live call-session telemetry for the in-browser Twilio softphone.
-- This is NOT the human-curated outcome record (lng_voice_call_log
-- stays exactly as it is) — this table is machine-written state for
-- exactly one Twilio Call leg: the bridged call from the agent's
-- browser to the patient's real phone number. One row per call
-- attempt placed from the "Call patient" button.
--
-- Written by two different actors at two different points:
--   * INSERT — the staff browser, the instant it commits to placing a
--     call (status='initiated'), before Device.connect() fires. This
--     guarantees a row exists for the TwiML webhook to find by id.
--   * UPDATE (twilio_call_sid/status/started_at/ended_at/
--     duration_seconds) — service role only, from the
--     twilio-voice-twiml and twilio-voice-status edge functions as
--     Twilio reports call progress. Never exposed to `authenticated`
--     as an UPDATE grant: only Twilio's own signed webhooks may move
--     a session forward.
--
-- Direction is always 'outbound' for v1 (browser agent calls a real
-- number) — a fixed check constraint rather than a lookup table,
-- since there is exactly one value today and inbound-to-browser is
-- out of scope.

begin;

create table public.lng_voice_call_sessions (
  id                 uuid primary key default gen_random_uuid(),
  appointment_id     uuid not null references public.lng_appointments(id) on delete cascade,
  patient_id         uuid not null references public.patients(id) on delete cascade,
  created_by         uuid references public.accounts(id) on delete set null,
  direction          text not null default 'outbound' check (direction in ('outbound')),
  -- Twilio's real Call resource CallStatus values, plus our own
  -- 'initiated' for the pre-dial row written before Twilio has
  -- assigned a CallSid at all.
  status             text not null default 'initiated' check (status in (
                        'initiated', 'queued', 'ringing', 'in-progress',
                        'completed', 'busy', 'failed', 'no-answer', 'canceled'
                      )),
  twilio_call_sid    text,
  to_phone           text not null,
  started_at         timestamptz,
  ended_at           timestamptz,
  duration_seconds   integer,
  created_at         timestamptz not null default now()
);

comment on table public.lng_voice_call_sessions is
  'Live Twilio Voice call-session telemetry for the browser softphone (one row per placed call). Machine-written; NOT the human outcome record (see lng_voice_call_log). status is advanced only by the service-role Twilio webhooks after the initial browser-side insert.';
comment on column public.lng_voice_call_sessions.status is
  'initiated (browser committed, pre-dial) | queued | ringing | in-progress | completed | busy | failed | no-answer | canceled (Twilio CallStatus values, plus initiated).';
comment on column public.lng_voice_call_sessions.twilio_call_sid is
  'Set once Twilio assigns the bridged leg''s CallSid (from the TwiML webhook''s CallSid POST param). Null until then. Correlation key for the status-callback webhook.';

create index lng_voice_call_sessions_appointment_idx
  on public.lng_voice_call_sessions (appointment_id, created_at desc);
create index lng_voice_call_sessions_patient_idx
  on public.lng_voice_call_sessions (patient_id, created_at desc);
-- Unique, not just indexed: twilio_call_sid is the sole correlation
-- key the status webhook has to find the right row, and a duplicate
-- would make an update-by-sid ambiguous. Partial since most rows sit
-- at status='initiated' with no SID assigned yet.
create unique index lng_voice_call_sessions_call_sid_idx
  on public.lng_voice_call_sessions (twilio_call_sid)
  where twilio_call_sid is not null;

alter table public.lng_voice_call_sessions enable row level security;

-- Staff can see every session — operational telemetry, not sensitive
-- PHI beyond what's already visible on the appointment page. Matches
-- lng_voice_call_log's permissive select convention.
create policy lng_voice_call_sessions_select
  on public.lng_voice_call_sessions
  for select to authenticated using (true);

-- The staff browser inserts the pre-dial row itself, through its own
-- authenticated session, right before calling Device.connect().
create policy lng_voice_call_sessions_insert
  on public.lng_voice_call_sessions
  for insert to authenticated with check (true);

-- No update/delete policy for `authenticated` at all. Every status
-- transition after the initial insert comes from a service-role edge
-- function (twilio-voice-twiml, twilio-voice-status), which bypasses
-- RLS entirely.

grant select, insert on public.lng_voice_call_sessions to authenticated;

commit;

notify pgrst, 'reload schema';

-- ── Rollback ──────────────────────────────────────────────────────
-- drop table if exists public.lng_voice_call_sessions;
