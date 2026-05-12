import { useState } from 'react';
import { Loader2, RefreshCw, Users, Video } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { Card } from '../Card/Card.tsx';
import { Skeleton } from '../Skeleton/Skeleton.tsx';
import { Toast } from '../Toast/Toast.tsx';
import {
  fetchMeetAttendance,
  useMeetAttendance,
} from '../../lib/queries/meetHosts.ts';

// Renders the Google Meet attendance summary for a virtual
// appointment. Persists pulled rows in lng_meet_attendance so a
// re-render between refreshes shows the same data; the Refresh
// button hits meet-fetch-attendance which upserts a fresh
// snapshot from the Meet API. Only renders when the appointment
// has a meet_space_id (i.e. went through the per-host flow).

export interface MeetAttendanceCardProps {
  appointmentId: string;
  meetMeetingCode: string | null;
  meetingHasEnded: boolean;
}

export function MeetAttendanceCard({
  appointmentId,
  meetMeetingCode,
  meetingHasEnded,
}: MeetAttendanceCardProps) {
  const { rows, loading, error, refresh } = useMeetAttendance(appointmentId);
  const [pulling, setPulling] = useState(false);
  const [toast, setToast] = useState<
    | { tone: 'success' | 'error'; title: string; description?: string }
    | null
  >(null);

  const onRefresh = async () => {
    setPulling(true);
    try {
      const result = await fetchMeetAttendance(appointmentId);
      if (result.ok) {
        if (result.waitingForMeeting) {
          setToast({
            tone: 'success',
            title: 'No attendance yet',
            description:
              'Google publishes attendance once the meeting ends. Try again after the appointment finishes.',
          });
        } else {
          setToast({
            tone: 'success',
            title: result.upserts === 1 ? '1 participant updated' : `${result.upserts ?? 0} participants updated`,
          });
        }
        refresh();
      } else {
        setToast({
          tone: 'error',
          title: 'Could not refresh attendance',
          description: result.error ?? undefined,
        });
      }
    } catch (e) {
      setToast({
        tone: 'error',
        title: 'Could not refresh attendance',
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setPulling(false);
    }
  };

  const totalParticipants = new Set(rows.map((r) => r.participant_name ?? 'guest')).size;

  return (
    <>
      <style>{`@keyframes lng-meet-spin { to { transform: rotate(360deg); } }`}</style>
      <Card padding="lg">
        <Header
          meetingCode={meetMeetingCode}
          rowCount={rows.length}
          totalParticipants={totalParticipants}
          loading={loading}
          pulling={pulling}
          onRefresh={onRefresh}
        />
        <div
          style={{
            height: 1,
            background: theme.color.border,
            margin: `${theme.space[4]}px 0 ${theme.space[5]}px`,
          }}
        />
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
            <Skeleton height={48} radius={12} />
            <Skeleton height={48} radius={12} />
          </div>
        ) : error ? (
          <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.alert }}>
            Could not load attendance: {error}
          </p>
        ) : rows.length === 0 ? (
          <EmptyMessage meetingHasEnded={meetingHasEnded} />
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
            {rows.map((row) => (
              <li
                key={row.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: theme.space[3],
                  padding: `${theme.space[3]}px ${theme.space[4]}px`,
                  borderRadius: theme.radius.input,
                  background: theme.color.surface,
                  border: `1px solid ${theme.color.border}`,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <p
                    style={{
                      margin: 0,
                      fontSize: theme.type.size.base,
                      fontWeight: theme.type.weight.semibold,
                      color: theme.color.ink,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {row.participant_name ?? 'Guest'}
                  </p>
                  <p
                    style={{
                      margin: `${theme.space[1]}px 0 0`,
                      fontSize: theme.type.size.xs,
                      color: theme.color.inkMuted,
                    }}
                  >
                    {row.participant_email ? row.participant_email : 'No email (guest)'}
                  </p>
                </div>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-end',
                    gap: 2,
                  }}
                >
                  <p
                    style={{
                      margin: 0,
                      fontSize: theme.type.size.sm,
                      color: theme.color.ink,
                      fontVariantNumeric: 'tabular-nums',
                      fontWeight: theme.type.weight.medium,
                    }}
                  >
                    {formatDuration(row.duration_seconds)}
                  </p>
                  <p
                    style={{
                      margin: 0,
                      fontSize: theme.type.size.xs,
                      color: theme.color.inkMuted,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {formatRange(row.joined_at, row.left_at)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {toast ? (
        <Toast
          tone={toast.tone}
          title={toast.title}
          description={toast.description}
          duration={4000}
          onDismiss={() => setToast(null)}
        />
      ) : null}
    </>
  );
}

function Header({
  meetingCode,
  rowCount,
  totalParticipants,
  loading,
  pulling,
  onRefresh,
}: {
  meetingCode: string | null;
  rowCount: number;
  totalParticipants: number;
  loading: boolean;
  pulling: boolean;
  onRefresh: () => void;
}) {
  const meta = loading
    ? 'Loading'
    : rowCount === 0
      ? 'No attendance yet'
      : `${totalParticipants} ${totalParticipants === 1 ? 'person' : 'people'} · ${rowCount} ${rowCount === 1 ? 'session' : 'sessions'}`;
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: theme.space[3] }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2], minWidth: 0 }}>
        <Users size={18} aria-hidden />
        <h2
          style={{
            margin: 0,
            fontSize: theme.type.size.lg,
            fontWeight: theme.type.weight.semibold,
            letterSpacing: theme.type.tracking.tight,
            color: theme.color.ink,
          }}
        >
          Meeting attendance
        </h2>
        {meetingCode ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '2px 8px',
              borderRadius: theme.radius.pill,
              background: theme.color.bg,
              border: `1px solid ${theme.color.border}`,
              color: theme.color.inkMuted,
              fontSize: theme.type.size.xs,
              fontWeight: theme.type.weight.medium,
              fontVariantNumeric: 'tabular-nums',
              marginLeft: theme.space[2],
            }}
          >
            <Video size={11} aria-hidden />
            {meetingCode}
          </span>
        ) : null}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[3] }}>
        <span
          style={{
            color: theme.color.inkMuted,
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.medium,
          }}
        >
          {meta}
        </span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={pulling}
          aria-label="Refresh attendance"
          style={{
            appearance: 'none',
            border: `1px solid ${theme.color.border}`,
            background: theme.color.surface,
            color: pulling ? theme.color.inkMuted : theme.color.accent,
            cursor: pulling ? 'wait' : 'pointer',
            padding: '6px 12px',
            borderRadius: theme.radius.pill,
            fontSize: theme.type.size.xs,
            fontWeight: theme.type.weight.semibold,
            fontFamily: 'inherit',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            opacity: pulling ? 0.7 : 1,
          }}
        >
          {pulling ? (
            <Loader2 size={12} aria-hidden style={{ animation: 'lng-meet-spin 600ms linear infinite' }} />
          ) : (
            <RefreshCw size={12} aria-hidden />
          )}
          {pulling ? 'Pulling' : 'Refresh'}
        </button>
      </div>
    </div>
  );
}

function EmptyMessage({ meetingHasEnded }: { meetingHasEnded: boolean }) {
  return (
    <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted, lineHeight: 1.5 }}>
      {meetingHasEnded
        ? 'No attendance recorded yet. Tap Refresh to pull the latest from Google.'
        : 'Attendance lands here once the meeting has ended. Google only publishes conference records after the room closes.'}
    </p>
  );
}

function formatDuration(seconds: number | null): string {
  if (seconds == null) return 'Still in meeting';
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return `${mins}m ${secs.toString().padStart(2, '0')}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h ${remMins.toString().padStart(2, '0')}m`;
}

function formatRange(joinedAtIso: string | null, leftAtIso: string | null): string {
  if (!joinedAtIso) return '';
  const fmt = (iso: string) =>
    new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return leftAtIso ? `${fmt(joinedAtIso)} → ${fmt(leftAtIso)}` : `from ${fmt(joinedAtIso)}`;
}
