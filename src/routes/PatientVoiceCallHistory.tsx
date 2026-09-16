import { useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { PhoneCall } from 'lucide-react';
import { Breadcrumb } from '../components/Breadcrumb/Breadcrumb.tsx';
import { Card, EmptyState, Skeleton } from '../components/index.ts';
import { OutcomeBadge } from '../components/CallOutcomeSheet/OutcomeBadge.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useIsMobile } from '../lib/useIsMobile.ts';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../components/KioskStatusBar/KioskStatusBar.tsx';
import { supabase } from '../lib/supabase.ts';
import { usePatientVoiceCallHistory } from '../lib/queries/voiceCallLog.ts';

// The full call history for one patient — every call to date, most
// recent first, its outcome and its note. Reached from "Previous
// calls" on a voice call's appointment page; each row drills into
// that call's own appointment page in turn.

interface EntryState {
  patientId?: string;
  patientName?: string;
}

export function PatientVoiceCallHistory() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();
  const isMobile = useIsMobile(640);
  const patientId = params.patientId ?? null;
  const entry = (location.state as EntryState | null) ?? {};

  // The name normally arrives via navigation state from the card that
  // linked here. A direct visit or a refresh loses it, so fall back
  // to a plain read rather than show a blank breadcrumb.
  const [fetchedName, setFetchedName] = useState<string | null>(null);
  useEffect(() => {
    if (entry.patientName || !patientId) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('patients')
        .select('first_name, last_name')
        .eq('id', patientId)
        .maybeSingle();
      if (cancelled || !data) return;
      const row = data as { first_name: string | null; last_name: string | null };
      const combined = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
      setFetchedName(combined || null);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId]);

  const patientName = entry.patientName ?? fetchedName;
  const { data, loading, error } = usePatientVoiceCallHistory(patientId, null);

  if (authLoading) return null;
  if (!user) return <Navigate to="/sign-in" replace />;
  if (!patientId) return <Navigate to="/schedule" replace />;

  const outerPaddingX = isMobile ? theme.space[4] : theme.space[6];

  return (
    <main
      style={{
        minHeight: '100dvh',
        background: theme.color.bg,
        padding: `0 ${outerPaddingX}px`,
        paddingTop: `calc(${KIOSK_STATUS_BAR_HEIGHT}px + env(safe-area-inset-top, 0px) + ${theme.space[5]}px)`,
        paddingBottom: `calc(${BOTTOM_NAV_HEIGHT}px + ${isMobile ? theme.space[6] : theme.space[8]}px + env(safe-area-inset-bottom, 0px))`,
      }}
    >
      <div style={{ maxWidth: theme.layout.pageMaxWidth, margin: '0 auto' }}>
        <div style={{ marginBottom: theme.space[4] }}>
          <Breadcrumb
            items={[
              { label: 'Schedule', onClick: () => navigate('/schedule') },
              ...(patientName
                ? [{ label: patientName, onClick: () => navigate(`/patient/${patientId}`) }]
                : []),
              { label: 'Call history' },
            ]}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[3], marginBottom: theme.space[5] }}>
          <span
            aria-hidden
            style={{
              width: 40,
              height: 40,
              borderRadius: theme.radius.pill,
              background: `${theme.category.voiceCall}1F`,
              color: theme.category.voiceCall,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <PhoneCall size={19} aria-hidden />
          </span>
          <div>
            <h1
              style={{
                margin: 0,
                fontSize: theme.type.size.xl,
                fontWeight: theme.type.weight.semibold,
                color: theme.color.ink,
                letterSpacing: theme.type.tracking.tight,
              }}
            >
              {patientName ? `${patientName}'s calls` : 'Call history'}
            </h1>
            <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
              {loading ? 'Loading…' : `${data.length} call${data.length === 1 ? '' : 's'} on record`}
            </p>
          </div>
        </div>

        <Card padding={isMobile ? 'sm' : 'md'}>
          {loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3], padding: theme.space[2] }}>
              <Skeleton height={64} radius={14} />
              <Skeleton height={64} radius={14} />
              <Skeleton height={64} radius={14} />
            </div>
          ) : error ? (
            <p style={{ margin: 0, padding: theme.space[4], fontSize: theme.type.size.sm, color: theme.color.alert }}>
              Couldn't load this patient's calls: {error}
            </p>
          ) : data.length === 0 ? (
            <EmptyState
              icon={<PhoneCall size={24} />}
              title="No calls yet"
              description="Every voice call booked for this patient will show up here, with its outcome and any note."
            />
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
              {data.map((call) => (
                <li key={call.appointmentId}>
                  <button
                    type="button"
                    onClick={() => navigate(`/appointment/${call.appointmentId}`)}
                    style={{
                      appearance: 'none',
                      width: '100%',
                      textAlign: 'left',
                      display: 'flex',
                      alignItems: 'center',
                      gap: theme.space[4],
                      padding: theme.space[4],
                      background: theme.color.surface,
                      border: `1px solid ${theme.color.border}`,
                      borderRadius: 14,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.borderColor = theme.category.voiceCall;
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.borderColor = theme.color.border;
                    }}
                  >
                    <CallDateTile iso={call.startAt} />
                    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], flexWrap: 'wrap' }}>
                        <span style={{ fontSize: theme.type.size.sm, fontWeight: theme.type.weight.semibold, color: theme.color.ink }}>
                          {formatTime(call.startAt)}
                        </span>
                        {call.latestOutcome ? (
                          <OutcomeBadge outcome={call.latestOutcome} />
                        ) : (
                          <StatusBadge status={call.status} />
                        )}
                      </div>
                      {call.latestNote ? (
                        <span
                          style={{
                            fontSize: theme.type.size.sm,
                            color: theme.color.inkMuted,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {call.latestNote}
                        </span>
                      ) : null}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </main>
  );
}

function CallDateTile({ iso }: { iso: string }) {
  const d = new Date(iso);
  const month = d.toLocaleDateString('en-GB', { month: 'short' }).toUpperCase();
  const day = String(d.getDate());
  return (
    <div
      aria-hidden
      style={{
        flexShrink: 0,
        width: 48,
        height: 48,
        borderRadius: 12,
        background: `${theme.category.voiceCall}14`,
        border: `1px solid ${theme.color.border}`,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        color: theme.category.voiceCall,
        lineHeight: 1,
      }}
    >
      <span style={{ fontSize: 9, fontWeight: theme.type.weight.semibold, letterSpacing: theme.type.tracking.wide }}>{month}</span>
      <span style={{ fontSize: theme.type.size.md, fontWeight: theme.type.weight.semibold, marginTop: 2 }}>{day}</span>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const label = status === 'booked' ? 'Booked' : status === 'cancelled' ? 'Cancelled' : status === 'rescheduled' ? 'Rescheduled' : status;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 22,
        padding: `0 ${theme.space[2]}px`,
        borderRadius: theme.radius.pill,
        background: theme.color.bg,
        color: theme.color.inkMuted,
        fontSize: theme.type.size.xs,
        fontWeight: theme.type.weight.medium,
      }}
    >
      {label}
    </span>
  );
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit' });
}
