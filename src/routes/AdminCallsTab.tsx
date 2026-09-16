import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, ChevronDown, ChevronUp, PhoneCall, PhoneOff, PlayCircle, Search } from 'lucide-react';
import { Avatar, Button, Card, DropdownSelect, EmptyState, Input, Skeleton } from '../components/index.ts';
import { theme } from '../theme/index.ts';
import { supabase } from '../lib/supabase.ts';
import { OutcomeBadge } from '../components/CallOutcomeSheet/OutcomeBadge.tsx';
import { LiveCallsPanel } from '../components/LiveCallsPanel/LiveCallsPanel.tsx';
import { fetchCallRecordingUrl } from '../lib/queries/callRecording.ts';
import { formatRelativeShort } from '../lib/queries/notifications.ts';
import { VOICE_CALL_OUTCOMES, type VoiceCallOutcome } from '../lib/queries/voiceCallLog.ts';

// Admin -> Calls. A single dashboard for voice calls across the whole
// clinic: what's live right now (reuses LiveCallsPanel, the same
// admin-only "Listen in" list Schedule's voice-calls-mode toolbar
// shows, but always visible here so this page reads as a live board
// rather than something that vanishes when quiet), a stats strip so
// the answer rate is visible at a glance, and a searchable,
// filterable history of every past call with its recording and
// transcript, across every patient.
export function AdminCallsTab() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[6] }}>
      <header>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.md,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          Calls
        </p>
        <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
          Every voice call, live and logged, with recordings and transcripts.
        </p>
      </header>

      <StatsStrip />

      <section>
        <SectionHeading>Live now</SectionHeading>
        <LiveCallsPanel
          emptyState={
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: theme.space[3],
                padding: theme.space[4],
                borderRadius: theme.radius.card,
                border: `1px dashed ${theme.color.border}`,
                background: theme.color.surface,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: theme.color.inkSubtle,
                  flexShrink: 0,
                }}
              />
              <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
                No calls in progress right now.
              </span>
            </div>
          }
        />
      </section>

      <PastCallsSection />
    </div>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h3
      style={{
        margin: `0 0 ${theme.space[3]}px`,
        fontSize: theme.type.size.sm,
        fontWeight: theme.type.weight.semibold,
        color: theme.color.inkMuted,
        textTransform: 'uppercase',
        letterSpacing: theme.type.tracking.wide,
      }}
    >
      {children}
    </h3>
  );
}

interface CallStats {
  total: number;
  answered: number;
  couldntConnect: number;
}

function useCallStats(refreshKey: number) {
  const [stats, setStats] = useState<CallStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [totalRes, answeredRes, failedRes] = await Promise.all([
        supabase.from('lng_voice_call_log').select('id', { count: 'exact', head: true }),
        supabase.from('lng_voice_call_log').select('id', { count: 'exact', head: true }).eq('outcome', 'answered'),
        supabase.from('lng_voice_call_log').select('id', { count: 'exact', head: true }).in('outcome', ['no_connection', 'wrong_number']),
      ]);
      if (cancelled) return;
      setStats({
        total: totalRes.count ?? 0,
        answered: answeredRes.count ?? 0,
        couldntConnect: failedRes.count ?? 0,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  return stats;
}

function StatsStrip() {
  const stats = useCallStats(0);
  const answerRate = stats && stats.total > 0 ? Math.round((stats.answered / stats.total) * 100) : null;

  const tiles: { label: string; value: string; color: string; icon: typeof PhoneCall }[] = [
    { label: 'Calls logged', value: stats ? String(stats.total) : '—', color: theme.color.ink, icon: PhoneCall },
    {
      label: 'Answered',
      value: stats ? (answerRate !== null ? `${stats.answered} (${answerRate}%)` : String(stats.answered)) : '—',
      color: theme.color.accent,
      icon: CheckCircle2,
    },
    {
      label: 'Couldn’t connect',
      value: stats ? String(stats.couldntConnect) : '—',
      color: theme.color.alert,
      icon: PhoneOff,
    },
  ];

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        gap: theme.space[3],
      }}
    >
      {tiles.map((tile) => (
        <Card key={tile.label} padding="md">
          <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[3] }}>
            <span
              aria-hidden
              style={{
                width: 36,
                height: 36,
                borderRadius: theme.radius.pill,
                background: `${tile.color}14`,
                color: tile.color,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <tile.icon size={17} aria-hidden />
            </span>
            <span style={{ minWidth: 0 }}>
              <span
                style={{
                  display: 'block',
                  fontSize: theme.type.size.lg,
                  fontWeight: theme.type.weight.bold,
                  color: theme.color.ink,
                  letterSpacing: theme.type.tracking.tight,
                  lineHeight: theme.type.leading.tight,
                }}
              >
                {tile.value}
              </span>
              <span style={{ display: 'block', fontSize: theme.type.size.xs, color: theme.color.inkSubtle, marginTop: 1 }}>
                {tile.label}
              </span>
            </span>
          </div>
        </Card>
      ))}
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
const OUTCOME_FILTER_OPTIONS = [
  { value: 'all', label: 'All outcomes' },
  ...VOICE_CALL_OUTCOMES.map((o) => ({ value: o.value, label: o.label })),
];

function PastCallsSection() {
  const [rows, setRows] = useState<PastCallRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [search, setSearch] = useState('');
  const [outcomeFilter, setOutcomeFilter] = useState('all');

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

  const filteredRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (outcomeFilter !== 'all' && row.outcome !== outcomeFilter) return false;
      if (term && !row.patientName.toLowerCase().includes(term) && !(row.agentName ?? '').toLowerCase().includes(term)) {
        return false;
      }
      return true;
    });
  }, [rows, search, outcomeFilter]);

  return (
    <section>
      <SectionHeading>Past calls</SectionHeading>

      <div
        style={{
          display: 'flex',
          gap: theme.space[3],
          marginBottom: theme.space[3],
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: '1 1 220px', minWidth: 180 }}>
          <Input
            placeholder="Search by patient or team member"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            leadingIcon={<Search size={15} aria-hidden />}
            aria-label="Search past calls"
          />
        </div>
        <div style={{ width: 200, flexShrink: 0 }}>
          <DropdownSelect
            ariaLabel="Filter by outcome"
            value={outcomeFilter}
            onChange={setOutcomeFilter}
            options={OUTCOME_FILTER_OPTIONS}
          />
        </div>
      </div>

      <Card padding="none">
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, padding: theme.space[4] }}>
            <Skeleton height={56} radius={theme.radius.input} />
            <Skeleton height={56} radius={theme.radius.input} />
            <Skeleton height={56} radius={theme.radius.input} />
          </div>
        ) : error ? (
          <p style={{ margin: 0, padding: theme.space[4], fontSize: theme.type.size.sm, color: theme.color.alert }}>
            Couldn't load past calls: {error}
          </p>
        ) : rows.length === 0 ? (
          <div style={{ padding: theme.space[4] }}>
            <EmptyState
              icon={<PhoneCall size={24} />}
              title="No calls logged yet"
              description="Every logged voice call will show up here, across every patient."
            />
          </div>
        ) : filteredRows.length === 0 ? (
          <p style={{ margin: 0, padding: theme.space[4], fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
            No calls match this search.
          </p>
        ) : (
          <>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {filteredRows.map((row, i) => (
                <PastCallEntry key={row.id} row={row} isLast={i === filteredRows.length - 1} />
              ))}
            </ul>
            {hasMore ? (
              <div style={{ padding: theme.space[4], display: 'flex', justifyContent: 'center' }}>
                <Button variant="tertiary" onClick={handleLoadMore} loading={loadingMore} disabled={loadingMore}>
                  Load more
                </Button>
              </div>
            ) : null}
          </>
        )}
      </Card>
    </section>
  );
}

function PastCallEntry({ row, isLast }: { row: PastCallRow; isLast: boolean }) {
  const navigate = useNavigate();
  const [recordingState, setRecordingState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [hovered, setHovered] = useState(false);

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
        borderBottom: isLast ? 'none' : `1px solid ${theme.color.border}`,
        background: hovered ? theme.color.bg : 'transparent',
        transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.spring}`,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: theme.space[3], padding: theme.space[4] }}>
        <Avatar name={row.patientName} size="sm" />
        <div style={{ flex: 1, minWidth: 0 }}>
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
          </button>
          <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>
            {formatRelativeShort(row.createdAt)}
            {row.agentName ? ` · ${row.agentName}` : ''}
          </p>

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

          {row.recordingStatus === 'available' || row.recordingStatus === 'deleted' ? (
            <div style={{ marginTop: theme.space[3], display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
              {row.recordingStatus === 'available' ? (
                recordingState === 'ready' && objectUrl ? (
                  <audio controls src={objectUrl} style={{ width: '100%', height: 32 }} />
                ) : (
                  <div>
                    <button
                      type="button"
                      onClick={handlePlay}
                      disabled={recordingState === 'loading'}
                      style={{
                        appearance: 'none',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: theme.space[2],
                        height: 30,
                        padding: `0 ${theme.space[3]}px 0 ${theme.space[2]}px`,
                        borderRadius: theme.radius.pill,
                        border: `1px solid ${theme.category.voiceCall}33`,
                        background: `${theme.category.voiceCall}0D`,
                        color: theme.category.voiceCall,
                        fontFamily: 'inherit',
                        fontSize: theme.type.size.xs,
                        fontWeight: theme.type.weight.semibold,
                        cursor: recordingState === 'loading' ? 'default' : 'pointer',
                        opacity: recordingState === 'loading' ? 0.7 : 1,
                      }}
                    >
                      <PlayCircle size={15} aria-hidden />
                      {recordingState === 'loading' ? 'Loading recording…' : 'Play recording'}
                    </button>
                    {recordingState === 'error' && recordingError ? (
                      <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.alert }}>
                        {recordingError}
                      </p>
                    ) : null}
                  </div>
                )
              ) : (
                <p style={{ margin: 0, fontSize: theme.type.size.xs, color: theme.color.inkSubtle, fontStyle: 'italic' }}>
                  Recording and transcript removed after the retention period.
                </p>
              )}

              {row.transcriptStatus === 'pending' ? (
                <p style={{ margin: 0, fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>Transcribing…</p>
              ) : row.transcriptStatus === 'available' && row.transcriptText ? (
                <div>
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
                        borderLeft: `3px solid ${theme.color.border}`,
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
            </div>
          ) : row.transcriptStatus === 'pending' ? (
            <p style={{ margin: `${theme.space[2]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
              Transcribing…
            </p>
          ) : null}
        </div>
      </div>
    </li>
  );
}
