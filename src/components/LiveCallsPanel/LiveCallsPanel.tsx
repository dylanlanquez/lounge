import { useCallback, useEffect, useState } from 'react';
import { Headphones, PhoneCall } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { supabase } from '../../lib/supabase.ts';
import { useRealtimeRefresh } from '../../lib/useRealtimeRefresh.ts';
import { useCurrentAccount } from '../../lib/queries/currentAccount.tsx';
import { useListenIn } from '../../lib/listenIn.tsx';

interface LiveCall {
  sessionId: string;
  patientName: string;
  agentName: string | null;
}

// Admin-only, self-gating to nothing when there's no call to listen
// to — this isn't permanent chrome, it only appears when there's
// actually something live. Mounted in Schedule's voice-calls-mode
// toolbar, next to the existing admin-only voice-call controls.
export function LiveCallsPanel() {
  const { account } = useCurrentAccount();
  const { startListening } = useListenIn();
  const [calls, setCalls] = useState<LiveCall[]>([]);
  const isAdmin = account?.is_admin === true || account?.is_super_admin === true;

  const load = useCallback(async () => {
    if (!isAdmin) return;
    const { data: sessions } = await supabase
      .from('lng_voice_call_sessions')
      .select('id, patient_id, created_by')
      .in('status', ['ringing', 'in-progress'])
      .order('created_at', { ascending: false });
    const rows = (sessions ?? []) as { id: string; patient_id: string; created_by: string | null }[];
    if (rows.length === 0) {
      setCalls([]);
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
      })),
    );
  }, [isAdmin]);

  useEffect(() => {
    load();
  }, [load]);

  useRealtimeRefresh([{ table: 'lng_voice_call_sessions' }], load);

  if (!isAdmin || calls.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
      {calls.map((call) => (
        <div
          key={call.sessionId}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: theme.space[3],
            padding: `${theme.space[2]}px ${theme.space[3]}px`,
            borderRadius: theme.radius.input,
            border: `1px solid ${theme.category.voiceCall}33`,
            background: `${theme.category.voiceCall}0D`,
          }}
        >
          <PhoneCall size={14} color={theme.category.voiceCall} aria-hidden />
          <span style={{ flex: 1, minWidth: 0, fontSize: theme.type.size.sm, color: theme.color.ink }}>
            <strong style={{ fontWeight: theme.type.weight.semibold }}>Live:</strong> {call.patientName}
            {call.agentName ? ` with ${call.agentName}` : ''}
          </span>
          <button
            type="button"
            onClick={() => startListening({ sessionId: call.sessionId, patientName: call.patientName })}
            style={{
              appearance: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: theme.space[1],
              height: 28,
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
            <Headphones size={12} aria-hidden />
            Listen in
          </button>
        </div>
      ))}
    </div>
  );
}
