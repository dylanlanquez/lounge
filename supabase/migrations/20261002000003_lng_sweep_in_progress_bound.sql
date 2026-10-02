-- 20261002000003_lng_sweep_in_progress_bound.sql
--
-- Tightens the in-progress bound on lng_sweep_stale_voice_call_sessions
-- from 45 minutes to 20.
--
-- 45 was picked without checking what a voice call actually is here.
-- It is a single 15-minute phase (lng_booking_type_phases, seeded by
-- 20260915000001), so 45 minutes is three times the booked length and
-- leaves a phantom live call on the schedule for most of an hour.
--
-- 20 minutes keeps a third over the booked slot for a call that runs
-- long, which is as much overrun as a 15-minute slot can absorb before
-- it collides with the next one anyway. A call still genuinely talking
-- at 20 minutes drops off the Live now panel but is NOT hung up on:
-- this table is telemetry, not the call itself.
--
-- The unanswered bound stays at 10 minutes. Nothing rings that long.
--
-- Rollback: re-run 20261002000002, which defines the same function with
-- the 45-minute default.

create or replace function public.lng_sweep_stale_voice_call_sessions(
  p_unanswered_minutes integer default 10,
  p_in_progress_minutes integer default 20
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
  'Backstop that closes voice call sessions nothing else ever closed: a call that ended without an outcome being logged, or one that hung before Twilio assigned a CallSid. Unanswered states (initiated/queued/ringing) are closed after 10 minutes, answered ones (in-progress) after 20, against a booked voice call phase of 15. Closes as canceled. Scheduled every 5 minutes by lng-voice-call-session-sweep. Does not replace the outcome-driven closers, which still close a session the moment the agent logs the call.';
