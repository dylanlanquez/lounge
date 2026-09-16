import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronUp, PhoneCall, PlayCircle } from 'lucide-react';
import { Button, Card, EmptyState, Skeleton } from '../components/index.ts';
import { theme } from '../theme/index.ts';
import { supabase } from '../lib/supabase.ts';
import { OutcomeBadge } from '../components/CallOutcomeSheet/OutcomeBadge.tsx';
import { LiveCallsPanel } from '../components/LiveCallsPanel/LiveCallsPanel.tsx';
import { fetchCallRecordingUrl } from '../lib/queries/callRecording.ts';
import { formatRelativeShort } from '../lib/queries/notifications.ts';
import type { VoiceCallOutcome } from '../lib/queries/voiceCallLog.ts';

// Admin -> Calls. Two things Dylan asked for in one place instead of
// scattered across individual appointment pages: what's live right
// now (reuses LiveCallsPanel, the same admin-only "Listen in" list
// Schedule's voice-calls-mode toolbar shows), and a browsable history
// of every past call with its recording and transcript, across every
// patient — not just the one you happen to be looking at.
export function AdminCallsTab() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[6] }}>
      <div>
        <h3
          style={{
            margin: `0 0 ${theme.space[3]}px`,
            fontSize: theme.type.size.md,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
          }}
        >
          Live now
        </h3>
        <LiveCallsPanel />
      </div>
      <PastCallsSection />
    </div>
  );
}

interface PastCallRow {
  id: string;
  appointmentId: string;
  outcome: VoiceCallOutcome;
  note: string | null;
  createdAt: string;
  patientName: string;
  agentName: string | null;
  sessionId: string | null;
  recordingStatus: string | null;
  transcriptStatus: string | null;
  transcriptText: string | null;
}

const PAGE_SIZE = 25;

function PastCallsSection() {
  const [rows, setRows] = useState<PastCallRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);

  const load = useCallback(async (offset: number) => {
    const { data: logRows, error: logErr } = await supabase
      .from('lng_voice_call_log')
      .select('id, appointment_id, patient_id, outcome, note, created_at, created_by, session_id')
      .order('created_at', { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);
    if (logErr) throw new Error(logErr.message);

    const logs = (logRows ?? []) as {
      id: string;
      appointment_id: string;
      patient_id: string;
      outcome: string;
      note: string | null;
      created_at: string;
      created_by: string | null;
      session_id: string | null;
    }[];
    if (logs.length === 0) return [];

    const patientIds = Array.from(new Set(logs.map((l) => l.patient_id)));
    const agentIds = Array.from(new Set(logs.map((l) => l.created_by).filter((id): id is string => !!id)));
    const sessionIds = Array.from(new Set(logs.map((l) => l.session_id).filter((id): id is string => !!id)));

    const [{ data: patients }, { data: agents }, { data: sessions }] = await Promise.all([
      supabase.from('patients').select('id, first_name, last_name').in('id', patientIds),
      agentIds.length > 0
        ? supabase.from('accounts').select('id, first_name, last_name, name').in('id', agentIds)
        : Promise.resolve({ data: [] as { id: string; first_name: string | null; last_name: string | null; name: string | null }[] }),
      sessionIds.length > 0
        ? supabase
            .from('lng_voice_call_sessions')
            .select('id, recording_status, transcript_status, transcript_text')
            .in('id', sessionIds)
        : Promise.resolve({
            data: [] as { id: string; recording_status: string; transcript_status: string; transcript_text: string | null }[],
          }),
    ]);

    const patientNames = new Map<string, string>();
    for (const p of (patients ?? []) as { id: string; first_name: string | null; last_name: string | null }[]) {
      patientNames.set(p.id, [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || 'Unknown patient');
    }
    const agentNames = new Map<string, string>();
    for (const a of (agents ?? []) as { id: string; first_name: string | null; last_name: string | null; name: string | null }[]) {
      agentNames.set(a.id, [a.first_name, a.last_name].filter(Boolean).join(' ').trim() || a.name || 'A team member');
    }
    const sessionInfo = new Map<string, { recording_status: string; transcript_status: string; transcript_text: string | null }>();
    for (const s of (sessions ?? []) as { id: string; recording_status: string; transcript_status: string; transcript_text: string | null }[]) {
      sessionInfo.set(s.id, s);
    }

    return logs.map((l) => {
      const session = l.session_id ? sessionInfo.get(l.session_id) : undefined;
      return {
        id: l.id,
        appointmentId: l.appointment_id,
        outcome: l.outcome as VoiceCallOutcome,
        note: l.note,
        createdAt: l.created_at,
        patientName: patientNames.get(l.patient_id) ?? 'Unknown patient',
        agentName: l.created_by ? (agentNames.get(l.created_by) ?? null) : null,
        sessionId: l.session_id,
        recordingStatus: session?.recording_status ?? null,
        transcriptStatus: session?.transcript_status ?? null,
        transcriptText: session?.transcript_text ?? null,
      } satisfies PastCallRow;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const first = await load(0);
        if (cancelled) return;
        setRows(first);
        setHasMore(first.length === PAGE_SIZE);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load calls');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const handleLoadMore = async () => {
    setLoadingMore(true);
    try {
      const next = await load(rows.length);
      setRows((prev) => [...prev, ...next]);
      setHasMore(next.length === PAGE_SIZE);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load more calls');
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div>
      <h3
        style={{
          margin: `0 0 ${theme.space[3]}px`,
          fontSize: theme.type.size.md,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.ink,
        }}
      >
        Past calls
      </h3>
      <Card padding="lg">
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
            <Skeleton height={56} radius={theme.radius.input} />
            <Skeleton height={56} radius={theme.radius.input} />
            <Skeleton height={56} radius={theme.radius.input} />
          </div>
        ) : error ? (
          <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.alert }}>
            Couldn't load past calls: {error}
          </p>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<PhoneCall size={24} />}
            title="No calls logged yet"
            description="Every logged voice call will show up here, across every patient."
          />
        ) : (
          <>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
              {rows.map((row) => (
                <PastCallEntry key={row.id} row={row} />
              ))}
            </ul>
            {hasMore ? (
              <div style={{ marginTop: theme.space[4], display: 'flex', justifyContent: 'center' }}>
                <Button variant="tertiary" onClick={handleLoadMore} loading={loadingMore} disabled={loadingMore}>
                  Load more
                </Button>
              </div>
            ) : null}
          </>
        )}
      </Card>
    </div>
  );
}

function PastCallEntry({ row }: { row: PastCallRow }) {
  const navigate = useNavigate();
  const [recordingState, setRecordingState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [transcriptOpen, setTranscriptOpen] = useState(false);

  const handlePlay = async () => {
    if (!row.sessionId || recordingState === 'loading') return;
    setRecordingState('loading');
    setRecordingError(null);
    const result = await fetchCallRecordingUrl(row.sessionId);
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
        padding: theme.space[3],
        borderRadius: theme.radius.input,
        border: `1px solid ${theme.color.border}`,
      }}
    >
      <button
        type="button"
        onClick={() => navigate(`/appointment/${row.appointmentId}`)}
        style={{
          appearance: 'none',
          border: 'none',
          background: 'none',
          padding: 0,
          width: '100%',
          textAlign: 'left',
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[2],
          flexWrap: 'wrap',
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        <span style={{ fontSize: theme.type.size.sm, fontWeight: theme.type.weight.semibold, color: theme.color.ink }}>
          {row.patientName}
        </span>
        <OutcomeBadge outcome={row.outcome} />
        <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>
          {formatRelativeShort(row.createdAt)}
          {row.agentName ? ` · ${row.agentName}` : ''}
        </span>
      </button>
      {row.note ? (
        <p
          style={{
            margin: `${theme.space[2]}px 0 0`,
            fontSize: theme.type.size.sm,
            color: theme.color.ink,
            lineHeight: theme.type.leading.relaxed,
            whiteSpace: 'pre-wrap',
          }}
        >
          {row.note}
        </p>
      ) : null}

      {row.recordingStatus === 'available' ? (
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
      ) : row.recordingStatus === 'deleted' ? (
        <p style={{ margin: `${theme.space[2]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.inkSubtle, fontStyle: 'italic' }}>
          Recording and transcript removed after the retention period.
        </p>
      ) : null}

      {row.transcriptStatus === 'pending' ? (
        <p style={{ margin: `${theme.space[2]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
          Transcribing…
        </p>
      ) : row.transcriptStatus === 'available' && row.transcriptText ? (
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
              {row.transcriptText}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
