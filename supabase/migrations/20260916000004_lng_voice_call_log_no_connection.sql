-- 20260916000004_lng_voice_call_log_no_connection.sql
--
-- A seventh outcome: the call never actually connected at all. Not
-- "no answer" (it rang, nobody picked up) and not "busy" (a real
-- busy signal) — a number that fails outright (disconnected,
-- invalid, carrier rejected) or one that connects and drops before
-- anything meaningful happens. Dylan, 16 Sep 2026: "there needs to
-- be an option for [a number] unable to accept calls."
--
-- No change needed to logVoiceCallOutcome's status mapping in
-- voiceCallLog.ts: "answered" moves the appointment to complete,
-- every other outcome (including this new one) already falls to
-- no_show — that branch is generic over the outcome value, not a
-- fixed list.

begin;

alter table public.lng_voice_call_log
  drop constraint lng_voice_call_log_outcome_check;

alter table public.lng_voice_call_log
  add constraint lng_voice_call_log_outcome_check
  check (outcome in (
    'answered', 'no_answer', 'voicemail',
    'wrong_number', 'busy', 'call_back_requested',
    'no_connection'
  ));

comment on column public.lng_voice_call_log.outcome is
  'answered | no_answer | voicemail | wrong_number | busy | call_back_requested | no_connection. "answered" moves the appointment to complete; every other value (including no_connection) moves it to no_show.';

commit;

notify pgrst, 'reload schema';

-- ── Rollback ──────────────────────────────────────────────────────
-- alter table public.lng_voice_call_log drop constraint lng_voice_call_log_outcome_check;
-- alter table public.lng_voice_call_log add constraint lng_voice_call_log_outcome_check
--   check (outcome in ('answered','no_answer','voicemail','wrong_number','busy','call_back_requested'));
-- (only valid if no row has been logged with 'no_connection' yet)
