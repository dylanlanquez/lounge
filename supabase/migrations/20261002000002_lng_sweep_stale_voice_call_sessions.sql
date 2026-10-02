-- 20261002000002_lng_sweep_stale_voice_call_sessions.sql
--
-- A call that ENDS without an outcome being logged left its session
-- row open, showing on the schedule as a live call with a working
-- Listen in button for up to two hours.
--
-- Observed on 2 October 2026: LAP-01235 (Marc Manklow) was dialled a
-- second time at ~13:20, after its "Left voicemail" outcome had
-- already been logged at 12:41. The call ran and ended (its recording
-- callback landed at 13:22). Nothing closed the session, because
-- every existing closer needs a human action:
--   * lng_close_voice_call_session      — only on logging an outcome
--                                         that names the session;
--   * lng_close_stale_voice_call_sessions — only on a redial, or on
--                                         logging any outcome;
--   * twilio-voice-status 'completed'   — only when Twilio's callback
--                                         actually arrives AND the row
--                                         already carries the CallSid
--                                         it matches on. A row that
--                                         hung before the SID was ever
--                                         written can never be closed
--                                         by it.
-- The agent had no reason to log a second outcome, so the row sat at a
-- live status until LiveCallsPanel's two-hour display cutoff hid it.
-- Hiding is not closing: the row stayed open in the data.
--
-- This adds the missing backstop. Two separate bounds, because the two
-- states mean different things:
--
--   initiated / queued / ringing — never answered. Twilio's own ring
--     timeout is 60 seconds and the dial is given 30 (twilio-voice-twiml).
--     Ten minutes is already an order of magnitude past anything real,
--     so a row still here is debris, every time.
--
--   in-progress — answered, genuinely a call. Closing one of these
--     early would blank a live call off the panel mid-conversation, so
--     the bound is deliberately generous at 45 minutes. Voice calls
--     here are booked in short slots; 45 minutes of continuous talk is
--     already far beyond any of them.
--
-- ponytail: fixed thresholds, not settings rows. Move them into
-- lng_settings the day someone needs to tune them without a migration.
--
-- Closed as 'canceled', the same status lng_close_stale_voice_call_sessions
-- uses for a superseded attempt: this is an abandoned record, not a
-- call that failed. ended_at is preserved if something already set it.
--
-- Rollback:
--   select cron.unschedule('lng-voice-call-session-sweep');
--   drop function public.lng_sweep_stale_voice_call_sessions(integer, integer);

create extension if not exists pg_cron;

create or replace function public.lng_sweep_stale_voice_call_sessions(
  p_unanswered_minutes integer default 10,
  p_in_progress_minutes integer default 45
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_closed integer;
begin
  update public.lng_voice_call_sessions
  set status = 'canceled',
      ended_at = coalesce(ended_at, now())
  where (
          (status in ('initiated', 'queued', 'ringing')
            and created_at < now() - make_interval(mins => p_unanswered_minutes))
          or
          (status = 'in-progress'
            and created_at < now() - make_interval(mins => p_in_progress_minutes))
        );
  get diagnostics v_closed = row_count;
  return v_closed;
end;
$$;

revoke all on function public.lng_sweep_stale_voice_call_sessions(integer, integer) from public;

comment on function public.lng_sweep_stale_voice_call_sessions(integer, integer) is
  'Backstop that closes voice call sessions nothing else ever closed: a call that ended without an outcome being logged, or one that hung before Twilio assigned a CallSid. Unanswered states (initiated/queued/ringing) are closed after 10 minutes, answered ones (in-progress) after 45. Closes as canceled. Scheduled every 5 minutes by lng-voice-call-session-sweep. Does not replace the outcome-driven closers, which still close a session the moment the agent logs the call.';

-- Every five minutes. The cost is a single indexed-by-status update
-- over a table that holds a handful of open rows at a time, and it
-- bounds how long a phantom live call can be shown to roughly the
-- sweep interval past its threshold.
select cron.unschedule('lng-voice-call-session-sweep')
where exists (
  select 1 from cron.job where jobname = 'lng-voice-call-session-sweep'
);

select cron.schedule(
  'lng-voice-call-session-sweep',
  '*/5 * * * *',
  $$ select public.lng_sweep_stale_voice_call_sessions() $$
);

-- One-off catch-up for the debris already in the table at the time
-- this migration runs, including the LAP-01235 row above. A tighter
-- in-progress bound than the scheduled default is safe here and only
-- here: this is a deliberate, supervised run, not the unattended
-- cadence, and 15 minutes is still past the length of the calls this
-- clinic books.
select public.lng_sweep_stale_voice_call_sessions(10, 15);
