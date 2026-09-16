import { useState } from 'react';
import { ChevronDown, ChevronUp, PhoneCall, PlayCircle } from 'lucide-react';
import { Card, Skeleton } from '../index.ts';
import { theme } from '../../theme/index.ts';
import { useVoiceCallLog, type VoiceCallLogRow } from '../../lib/queries/voiceCallLog.ts';
import { fetchCallRecordingUrl } from '../../lib/queries/callRecording.ts';
import { OutcomeBadge } from '../CallOutcomeSheet/OutcomeBadge.tsx';
import { formatRelativeShort } from '../../lib/queries/notifications.ts';

// The call record — the bottom-of-page log Dylan asked for, built to
// read like a call centre's disposition history: every attempt this
// booking has had, outcome first, note underneath, who and when.
// Usually one row (a call is logged once), but supports more — a
// reversed and re-logged call keeps its earlier attempt on the
// record rather than erasing it.
export function CallRecordCard({
  appointmentId,
  refreshKey,
}: {
  appointmentId: string;
  // Bumped by the parent right after logging a new outcome, so the
  // freshly-written row shows up without a page reload — this card's
  // own useVoiceCallLog instance has no other way to know a write
  // happened elsewhere.
  refreshKey?: number;
}) {
  const { data, loading, error } = useVoiceCallLog(appointmentId, refreshKey);

  return (
    <Card padding="lg">
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[3], marginBottom: theme.space[4] }}>
        <span
          aria-hidden
          style={{
            width: 30,
            height: 30,
            borderRadius: theme.radius.pill,
            background: `${theme.category.voiceCall}1F`,
            color: theme.category.voiceCall,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <PhoneCall size={15} aria-hidden />
        </span>
        <h3
          style={{
            margin: 0,
            fontSize: theme.type.size.md,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          Call record
        </h3>
      </div>

      {loading ? (
        <Skeleton height={18} radius={theme.radius.input} />
      ) : error ? (
        <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.alert }}>
          Couldn't load the call record: {error}
        </p>
      ) : data.length === 0 ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: theme.space[3],
            padding: `${theme.space[3]}px ${theme.space[4]}px`,
            borderRadius: theme.radius.input,
            border: `1px dashed ${theme.color.border}`,
            color: theme.color.inkMuted,
            fontSize: theme.type.size.sm,
          }}
        >
          <PhoneCall size={16} color={theme.color.inkSubtle} aria-hidden />
          No call logged yet. Once you log this call, the outcome and any note land here.
        </div>
      ) : (
        <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
          {data.map((entry, i) => (
            <CallRecordEntry key={entry.id} entry={entry} isLatest={i === 0} />
          ))}
        </ol>
      )}
    </Card>
  );
}

function CallRecordEntry({ entry, isLatest }: { entry: VoiceCallLogRow; isLatest: boolean }) {
  const [recordingState, setRecordingState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [transcriptOpen, setTranscriptOpen] = useState(false);

  const handlePlay = async () => {
    if (!entry.session_id || recordingState === 'loading') return;
    setRecordingState('loading');
    setRecordingError(null);
    const result = await fetchCallRecordingUrl(entry.session_id);
    if (result.ok && result.objectUrl) {
      setObjectUrl(result.objectUrl);
      setRecordingState('ready');
    } else {
      setRecordingError(result.error ?? 'Could not load the recording');
      setRecordingState('error');
    }
  };

  return (
    <li
      style={{
        position: 'relative',
        paddingLeft: theme.space[5],
        borderLeft: isLatest ? `2px solid ${theme.category.voiceCall}` : `2px solid ${theme.color.border}`,
      }}
    >
      <span
        aria-hidden
        style={{
          position: 'absolute',
          left: -5,
          top: 4,
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: isLatest ? theme.category.voiceCall : theme.color.border,
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], flexWrap: 'wrap' }}>
        <OutcomeBadge outcome={entry.outcome} />
        <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>
          {formatRelativeShort(entry.created_at)}
          {entry.author_name ? ` · ${entry.author_name}` : ''}
        </span>
      </div>
      {entry.note ? (
        <p
          style={{
            margin: `${theme.space[2]}px 0 0`,
            fontSize: theme.type.size.sm,
            color: theme.color.ink,
            lineHeight: theme.type.leading.relaxed,
            whiteSpace: 'pre-wrap',
          }}
        >
          {entry.note}
        </p>
      ) : null}

      {entry.recording_status === 'available' ? (
        <div style={{ marginTop: theme.space[3] }}>
          {recordingState === 'ready' && objectUrl ? (
            <audio controls src={objectUrl} style={{ width: '100%', height: 32 }} />
          ) : (
            <button
              type="button"
              onClick={handlePlay}
              disabled={recordingState === 'loading'}
              style={{
                appearance: 'none',
                display: 'inline-flex',
                alignItems: 'center',
                gap: theme.space[2],
                height: 32,
                padding: `0 ${theme.space[3]}px`,
                borderRadius: theme.radius.pill,
                border: `1px solid ${theme.color.border}`,
                background: theme.color.surface,
                color: theme.category.voiceCall,
                fontFamily: 'inherit',
                fontSize: theme.type.size.xs,
                fontWeight: theme.type.weight.semibold,
                cursor: recordingState === 'loading' ? 'default' : 'pointer',
                opacity: recordingState === 'loading' ? 0.7 : 1,
              }}
            >
              <PlayCircle size={14} aria-hidden />
              {recordingState === 'loading' ? 'Loading…' : 'Play recording'}
            </button>
          )}
          {recordingState === 'error' && recordingError ? (
            <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.alert }}>
              {recordingError}
            </p>
          ) : null}
        </div>
      ) : entry.recording_status === 'deleted' ? (
        <p style={{ margin: `${theme.space[2]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.inkSubtle, fontStyle: 'italic' }}>
          Recording and transcript removed after the retention period.
        </p>
      ) : null}

      {entry.transcript_status === 'pending' ? (
        <p style={{ margin: `${theme.space[2]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
          Transcribing…
        </p>
      ) : entry.transcript_status === 'available' && entry.transcript_text ? (
        <div style={{ marginTop: theme.space[2] }}>
          <button
            type="button"
            onClick={() => setTranscriptOpen((v) => !v)}
            style={{
              appearance: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: theme.space[1],
              border: 'none',
              background: 'none',
              padding: 0,
              color: theme.color.inkMuted,
              fontFamily: 'inherit',
              fontSize: theme.type.size.xs,
              fontWeight: theme.type.weight.medium,
              cursor: 'pointer',
            }}
          >
            {transcriptOpen ? <ChevronUp size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
            {transcriptOpen ? 'Hide transcript' : 'Show transcript'}
          </button>
          {transcriptOpen ? (
            <p
              style={{
                margin: `${theme.space[2]}px 0 0`,
                padding: theme.space[3],
                borderRadius: theme.radius.input,
                background: theme.color.bg,
                fontSize: theme.type.size.sm,
                color: theme.color.ink,
                lineHeight: theme.type.leading.relaxed,
                whiteSpace: 'pre-wrap',
              }}
            >
              {entry.transcript_text}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
