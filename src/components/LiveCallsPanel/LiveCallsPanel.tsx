import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Headphones } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { supabase } from '../../lib/supabase.ts';
import { useRealtimeRefresh } from '../../lib/useRealtimeRefresh.ts';
import { useCurrentAccount } from '../../lib/queries/currentAccount.tsx';
import { useListenIn } from '../../lib/listenIn.tsx';
import { Avatar } from '../Avatar/Avatar.tsx';

interface LiveCall {
  sessionId: string;
  patientName: string;
  agentName: string | null;
  startedAt: string;
}

interface LiveCallsPanelProps {
  // When supplied, the panel renders this in place of returning null
  // once it has actually checked and found nothing live, so a
  // dashboard section keeps a visible presence instead of collapsing
  // to nothing. Left unset for Schedule's toolbar, which wants true
  // "not there at all" when the clinic is quiet.
  emptyState?: ReactNode;
}

// Admin-only. Mounted in Schedule's voice-calls-mode toolbar (no
// emptyState, self-gates to nothing when there's no call to listen
// to) and inside Admin -> Calls (with an emptyState, so that page
// always reads as a live dashboard).
export function LiveCallsPanel({ emptyState }: LiveCallsPanelProps = {}) {
  const { account } = useCurrentAccount();
  const { startListening } = useListenIn();
  const [calls, setCalls] = useState<LiveCall[]>([]);
  const [checked, setChecked] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const isAdmin = account?.is_admin === true || account?.is_super_admin === true;

  const load = useCallback(async () => {
    if (!isAdmin) return;
    // A row can get stuck at 'ringing'/'in-progress' forever if a test
    // call (or a real one) is abandoned before Twilio's status
    // callback ever lands — this table has no server-side timeout of
    // its own. Without a freshness bound, an orphaned row from hours
    // or days ago would show up here as if it were happening right
    // now. Two hours is generous enough to never cut off a real
    // in-progress call while still hiding old debris.
    const freshnessCutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { data: sessions } = await supabase
      .from('lng_voice_call_sessions')
      .select('id, patient_id, created_by, created_at')
      .in('status', ['ringing', 'in-progress'])
      .gt('created_at', freshnessCutoff)
      .order('created_at', { ascending: false });
    const rows = (sessions ?? []) as { id: string; patient_id: string; created_by: string | null; created_at: string }[];
    if (rows.length === 0) {
      setCalls([]);
      setChecked(true);
      return;
    }

    const patientIds = Array.from(new Set(rows.map((r) => r.patient_id)));
    const agentIds = Array.from(new Set(rows.map((r) => r.created_by).filter((id): id is string => !!id)));

    const [{ data: patients }, { data: agents }] = await Promise.all([
      supabase.from('patients').select('id, first_name, last_name').in('id', patientIds),
      agentIds.length > 0
        ? supabase.from('accounts').select('id, first_name, last_name, name').in('id', agentIds)
        : Promise.resolve({ data: [] as { id: string; first_name: string | null; last_name: string | null; name: string | null }[] }),
    ]);

    const patientNames = new Map<string, string>();
    for (const p of (patients ?? []) as { id: string; first_name: string | null; last_name: string | null }[]) {
      patientNames.set(p.id, [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || 'Unknown patient');
    }
    const agentNames = new Map<string, string>();
    for (const a of (agents ?? []) as { id: string; first_name: string | null; last_name: string | null; name: string | null }[]) {
      agentNames.set(a.id, [a.first_name, a.last_name].filter(Boolean).join(' ').trim() || a.name || 'A team member');
    }

    setCalls(
      rows.map((r) => ({
        sessionId: r.id,
        patientName: patientNames.get(r.patient_id) ?? 'Unknown patient',
        agentName: r.created_by ? (agentNames.get(r.created_by) ?? null) : null,
        startedAt: r.created_at,
      })),
    );
    setChecked(true);
  }, [isAdmin]);

  useEffect(() => {
    load();
  }, [load]);

  useRealtimeRefresh([{ table: 'lng_voice_call_sessions' }], load);

  // A ticking clock for the elapsed-time readout on each live row.
  // Only runs while there's actually something live to time.
  useEffect(() => {
    if (calls.length === 0) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [calls.length]);

  if (!isAdmin) return null;
  if (calls.length === 0) return checked && emptyState !== undefined ? <>{emptyState}</> : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
      <style>{`@keyframes lng-pulse-dot{0%{box-shadow:0 0 0 0 rgba(94,87,165,0.45)}70%{box-shadow:0 0 0 6px rgba(94,87,165,0)}100%{box-shadow:0 0 0 0 rgba(94,87,165,0)}}`}</style>
      {calls.map((call) => {
        const elapsedSeconds = Math.max(0, Math.floor((now - new Date(call.startedAt).getTime()) / 1000));
        const m = Math.floor(elapsedSeconds / 60);
        const s = elapsedSeconds % 60;
        return (
          <div
            key={call.sessionId}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: theme.space[3],
              padding: theme.space[3],
              borderRadius: theme.radius.card,
              border: `1px solid ${theme.category.voiceCall}2E`,
              background: theme.color.surface,
              boxShadow: theme.shadow.card,
              borderLeft: `4px solid ${theme.category.voiceCall}`,
            }}
          >
            <span style={{ position: 'relative', flexShrink: 0 }}>
              <Avatar name={call.patientName} size="md" />
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  bottom: -1,
                  right: -1,
                  width: 11,
                  height: 11,
                  borderRadius: '50%',
                  background: theme.category.voiceCall,
                  border: `2px solid ${theme.color.surface}`,
                  animation: 'lng-pulse-dot 2s infinite',
                }}
              />
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'flex', alignItems: 'baseline', gap: theme.space[2], flexWrap: 'wrap' }}>
                <span style={{ fontSize: theme.type.size.sm, fontWeight: theme.type.weight.semibold, color: theme.color.ink }}>
                  {call.patientName}
                </span>
                <span
                  style={{
                    fontSize: theme.type.size.xs,
                    fontWeight: theme.type.weight.semibold,
                    color: theme.category.voiceCall,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {m}:{String(s).padStart(2, '0')}
                </span>
              </span>
              <span style={{ display: 'block', fontSize: theme.type.size.xs, color: theme.color.inkSubtle, marginTop: 2 }}>
                {call.agentName ? `Live with ${call.agentName}` : 'Live call'}
              </span>
            </span>
            <button
              type="button"
              onClick={() => startListening({ sessionId: call.sessionId, patientName: call.patientName })}
              style={{
                appearance: 'none',
                display: 'inline-flex',
                alignItems: 'center',
                gap: theme.space[1],
                height: 32,
                padding: `0 ${theme.space[3]}px`,
                borderRadius: theme.radius.pill,
                border: 'none',
                background: theme.category.voiceCall,
                color: theme.color.surface,
                fontFamily: 'inherit',
                fontSize: theme.type.size.xs,
                fontWeight: theme.type.weight.semibold,
                cursor: 'pointer',
                WebkitTapHighlightColor: 'transparent',
                flexShrink: 0,
              }}
            >
              <Headphones size={13} aria-hidden />
              Listen in
            </button>
          </div>
        );
      })}
    </div>
  );
}
