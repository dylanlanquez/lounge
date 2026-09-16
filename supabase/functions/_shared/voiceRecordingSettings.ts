// _shared/voiceRecordingSettings.ts
//
// Reads the two admin-editable lng_settings keys that gate call
// recording/transcription (see migration
// 20260916000006_lng_voice_call_recording_settings.sql), mirroring
// _shared/emailSender.ts's readAdminSenderRow shape exactly. Used by
// twilio-voice-conference-join to decide whether to record + what to
// say, and read independently there as defense in depth rather than
// trusted from any caller.
//
// Duck-typed rather than the concrete SupabaseClient — see
// emailSender.ts's AdminLike for why (nominal-type mismatch between
// callers built on different Supabase client module specifiers).
type AdminLike = {
  from: (table: string) => {
    select: (cols: string) => {
      in: (
        col: string,
        values: string[],
      ) => {
        is: (col: string, value: null) => PromiseLike<{ data: unknown; error: unknown }>;
      };
    };
  };
};

export interface VoiceRecordingSettings {
  enabled: boolean;
  noticeText: string;
}

const DEFAULT_NOTICE = 'This call may be recorded and transcribed for quality and training purposes.';

export async function readVoiceRecordingSettings(admin: AdminLike): Promise<VoiceRecordingSettings> {
  const { data } = await admin
    .from('lng_settings')
    .select('key, value')
    .in('key', ['voice_call.recording_enabled', 'voice_call.recording_notice'])
    .is('location_id', null);
  const rows = (data ?? []) as Array<{ key: string; value: unknown }>;
  const map = new Map<string, unknown>();
  for (const r of rows) map.set(r.key, r.value);

  const enabledValue = map.get('voice_call.recording_enabled');
  const enabled = enabledValue === true;

  const noticeValue = map.get('voice_call.recording_notice');
  const noticeText = (typeof noticeValue === 'string' ? noticeValue.trim() : '') || DEFAULT_NOTICE;

  return { enabled, noticeText };
}
