-- 20260916000007_lng_voice_call_listeners.sql
--
-- One row per admin who joins a live call to listen in. This is both
-- the mechanism twilio-voice-conference-status uses to stamp when a
-- listener leaves, and the audit trail of who listened to which
-- call and when — a DPIA review will want this regardless of how
-- the "should the agent be told" consent question is resolved.
--
-- Deliberately its own table rather than columns on
-- lng_voice_call_sessions: more than one admin could in principle
-- listen to the same call, and this keeps a clean per-listener
-- history rather than an array column.
--
-- Joining a call is never a call-status transition, so this table
-- has no relationship to lng_voice_call_sessions.status at all —
-- twilio-voice-twiml's listener branch never touches that column.

begin;

create table public.lng_voice_call_listeners (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid not null references public.lng_voice_call_sessions(id) on delete cascade,
  account_id        uuid references public.accounts(id) on delete set null,
  listener_call_sid text,
  joined_at         timestamptz not null default now(),
  left_at           timestamptz
);

comment on table public.lng_voice_call_listeners is
  'One row per admin who joined a live call to listen in (muted, Twilio Conference participant). Audit trail of who listened to which call and when; left_at is stamped by twilio-voice-conference-status on the Conference leave event, not by any application teardown logic — the call ending naturally ends the listener''s leg too (endConferenceOnExit on the real participants'' legs).';

create index lng_voice_call_listeners_session_idx
  on public.lng_voice_call_listeners (session_id, joined_at desc);

alter table public.lng_voice_call_listeners enable row level security;

-- Staff can see who has listened to what — same permissive
-- convention as lng_voice_call_sessions/lng_voice_call_log.
create policy lng_voice_call_listeners_select
  on public.lng_voice_call_listeners
  for select to authenticated using (true);

-- No insert/update/delete grant to `authenticated` at all. Only the
-- service-role twilio-voice-listen-in (insert) and
-- twilio-voice-conference-status (update left_at) functions write
-- here.

grant select on public.lng_voice_call_listeners to authenticated;

commit;

notify pgrst, 'reload schema';

-- ── Rollback ──────────────────────────────────────────────────────
-- drop table if exists public.lng_voice_call_listeners;
