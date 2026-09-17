-- Closing the ONE session tied to a logged outcome
-- (lng_close_voice_call_session, added 16 Sep) wasn't enough: when an
-- agent redials the same appointment more than once before finally
-- getting through (no answer, then ringing but abandoned, then
-- answered), every earlier attempt left its own
-- lng_voice_call_sessions row, and only the row for the FINAL
-- attempt ever got closed. The abandoned middle attempts (stuck at
-- 'initiated' or 'ringing' forever, since Twilio's own status
-- callback only ever fires for a call that actually got dialled
-- through to completion) kept showing in Admin -> Calls' "Live now"
-- panel as a genuinely ongoing call, with a "Listen in" button that
-- joined a conference nobody was in, long after the real call had
-- ended.
--
-- This closes every OTHER still-open session for the same
-- appointment as 'canceled' — a superseded attempt, not a failure —
-- called from two places: right before starting a new call (so a
-- redial doesn't leave the previous attempt looking live even for
-- the seconds before an outcome gets logged), and after logging an
-- outcome (belt and braces, in case a call was abandoned without
-- ever redialling).
create or replace function public.lng_close_stale_voice_call_sessions(p_appointment_id uuid, p_except_session_id uuid default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  update public.lng_voice_call_sessions
  set status = 'canceled',
      ended_at = coalesce(ended_at, now())
  where appointment_id = p_appointment_id
    and status in ('initiated', 'queued', 'ringing', 'in-progress')
    and (p_except_session_id is null or id <> p_except_session_id);
end;
$$;

grant execute on function public.lng_close_stale_voice_call_sessions(uuid, uuid) to authenticated;
