-- 20260916000005_lng_voice_call_recording.sql
--
-- Recording + transcript state for the softphone, plus an exact link
-- from a logged outcome back to the call it belongs to.
--
-- lng_voice_call_log.session_id: until now a logged outcome had no
-- direct link to the lng_voice_call_sessions row it came from — the
-- Call record card would have had to guess by nearest timestamp
-- within the appointment. This makes the link exact wherever a call
-- was actually placed through the softphone. Nullable and set-null
-- on delete: the append-only log outlives any one session row's
-- lifecycle concerns, and outcomes logged manually with no in-app
-- call in flight (or predating this column) simply have no session
-- to link.
--
-- lng_voice_call_sessions gains recording/transcript columns. These
-- are populated entirely by service-role Twilio webhooks (a
-- recording-status callback, then a transcription callback) and by a
-- scheduled retention sweep — never by the authenticated browser
-- insert, matching this table's existing machine-written-after-
-- insert convention. Recording playback proxies through Twilio at
-- read time (see get-call-recording); only the Twilio recording SID
-- is stored here, never a raw playable URL.
--
-- Both recording and transcription are OFF by default at the
-- application layer (see the lng_settings seed in the next
-- migration) — these columns simply sit unused (recording_status /
-- transcript_status stay 'none') until that setting is turned on.

begin;

alter table public.lng_voice_call_log
  add column session_id uuid references public.lng_voice_call_sessions(id) on delete set null;

create index lng_voice_call_log_session_idx
  on public.lng_voice_call_log (session_id) where session_id is not null;

comment on column public.lng_voice_call_log.session_id is
  'Exact link to the lng_voice_call_sessions row this outcome was logged against, when logged via the softphone. Null for outcomes logged manually with no in-app call in flight, or for rows predating this column.';

alter table public.lng_voice_call_sessions
  add column recording_sid text,
  add column recording_status text not null default 'none'
    check (recording_status in ('none', 'pending', 'available', 'failed', 'deleted')),
  add column recording_duration_seconds integer,
  add column transcript_text text,
  add column transcript_status text not null default 'none'
    check (transcript_status in ('none', 'pending', 'available', 'failed', 'purged'));

create unique index lng_voice_call_sessions_recording_sid_idx
  on public.lng_voice_call_sessions (recording_sid) where recording_sid is not null;

comment on column public.lng_voice_call_sessions.recording_status is
  'none (recording off, or not yet started) | pending (recording in progress) | available (ready to play via get-call-recording) | failed | deleted (removed by the retention sweep — recording_sid kept as a historical fact but no longer resolvable at Twilio).';
comment on column public.lng_voice_call_sessions.transcript_status is
  'none | pending (requested from Twilio, callback not yet received) | available (transcript_text populated) | failed | purged (retention sweep cleared transcript_text alongside the recording).';

commit;

notify pgrst, 'reload schema';

-- ── Rollback ──────────────────────────────────────────────────────
-- alter table public.lng_voice_call_log drop column session_id;
-- alter table public.lng_voice_call_sessions
--   drop column recording_sid, drop column recording_status,
--   drop column recording_duration_seconds, drop column transcript_text,
--   drop column transcript_status;
