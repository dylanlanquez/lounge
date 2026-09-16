-- 20260916000006_lng_voice_call_recording_settings.sql
--
-- Two admin-editable settings gating the recording/transcript
-- feature, following the same lng_settings pattern already used for
-- email branding and clinic details (20260504000005).
--
-- recording_enabled defaults to false on purpose. Recording and
-- transcribing patient phone calls is a genuinely bigger step than
-- anything else this table gates: it makes Twilio a processor of
-- actual conversation content, not just delivery metadata, which
-- docs/02-data-protection.md does not yet account for (no processor
-- entry, no DPIA risk entry, no documented retention period for
-- audio). The feature ships built and dormant; turning it on for
-- real patient calls is Dylan's call once that review is done, not
-- a default this migration should set.
--
-- recording_notice is the spoken consent announcement played to the
-- PATIENT (never the agent — see twilio-voice-conference-join) before
-- their leg joins the call, when recording is enabled. The default
-- text below is functional placeholder copy, not legally reviewed
-- wording for UK call-recording notice requirements.

begin;

insert into public.lng_settings (location_id, key, value, description)
values
  (
    null,
    'voice_call.recording_enabled',
    to_jsonb(false),
    'Whether outbound softphone calls are recorded and transcribed via Twilio. Off until the Twilio processor/DPIA update to docs/02-data-protection.md is signed off. [legal review required]'
  ),
  (
    null,
    'voice_call.recording_notice',
    to_jsonb('This call may be recorded and transcribed for quality and training purposes.'::text),
    'Spoken to the patient, not the agent, before their leg joins the call, when recording is enabled. Placeholder wording. [legal review required]'
  )
on conflict (key) where location_id is null do nothing;

commit;

notify pgrst, 'reload schema';

-- ── Rollback ──────────────────────────────────────────────────────
-- delete from public.lng_settings
--   where location_id is null
--     and key in ('voice_call.recording_enabled', 'voice_call.recording_notice');
