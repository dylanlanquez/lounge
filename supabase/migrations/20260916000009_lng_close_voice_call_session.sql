-- A session stays 'ringing'/'in-progress' forever if Twilio's own
-- status callback never lands (a call that fails to connect cleanly,
-- e.g. an invalid international number, or the webhook itself never
-- fires). Nothing else closes it out, so it kept showing up in
-- Admin -> Calls' "Live now" panel with a climbing timer, and its
-- "Listen in" button joined a Twilio conference that no longer had
-- anyone in it, minutes or hours after the agent had already logged
-- the call's outcome and moved on.
--
-- The client can't just UPDATE lng_voice_call_sessions directly: it
-- only has an insert + select RLS policy, by design (the row's
-- authoritative writer is Twilio's own webhooks via the service
-- role). This gives logVoiceCallOutcome() a narrow, safe way to close
-- a session the moment a human confirms its outcome, without opening
-- the table up to arbitrary client writes.
create or replace function public.lng_close_voice_call_session(p_session_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if p_status not in ('completed', 'busy', 'failed', 'no-answer', 'canceled') then
    raise exception 'invalid terminal status: %', p_status;
  end if;

  -- Only ever moves a session forward out of an open state. If
  -- Twilio's own webhook already closed it (correctly or otherwise),
  -- this is a no-op rather than a clobber.
  update public.lng_voice_call_sessions
  set status = p_status,
      ended_at = coalesce(ended_at, now())
  where id = p_session_id
    and status in ('initiated', 'queued', 'ringing', 'in-progress');
end;
$$;

grant execute on function public.lng_close_voice_call_session(uuid, text) to authenticated;
