import { useEffect, useState } from 'react';
import { Eye, Mic, MicOff, PhoneOff } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { useActiveCall } from '../../lib/activeCall.tsx';
import { supabase } from '../../lib/supabase.ts';
import { KIOSK_STATUS_BAR_HEIGHT } from '../KioskStatusBar/KioskStatusBar.tsx';

// Whether the agent sees an "an admin has joined this call"
// indicator at all. This is a genuine open compliance question (see
// the voice-call recording/monitoring plan), not an engineering
// default — recommended on, since telling the agent monitoring is
// possible costs nothing and matches how most call-centre QA already
// works, but gated behind this one flag so the decision is a one-line
// change either way, not a rebuild.
const ADMIN_JOINED_INDICATOR_ENABLED = true;

// Simple poll, not a realtime subscription — this is a rare,
// low-stakes informational indicator, not something worth new
// infrastructure for. Only runs while a call is actually connected.
function useAdminListening(sessionId: string | null, active: boolean): boolean {
  const [listening, setListening] = useState(false);
  useEffect(() => {
    if (!ADMIN_JOINED_INDICATOR_ENABLED || !sessionId || !active) {
      setListening(false);
      return;
    }
    let cancelled = false;
    const check = async () => {
      const { data } = await supabase
        .from('lng_voice_call_listeners')
        .select('id')
        .eq('session_id', sessionId)
        .is('left_at', null)
        .limit(1);
      if (!cancelled) setListening((data?.length ?? 0) > 0);
    };
    check();
    const interval = setInterval(check, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [sessionId, active]);
  return listening;
}

// The persistent "on a call" bar. Sits directly under KioskStatusBar,
// mounted at the App root so it survives route navigation the same
// way KioskStatusBar and BottomNav do — an agent mid-call can still
// open the patient's profile or check another tab without the call
// bar (or the call itself) disappearing. Self-gates to nothing when
// there is no active call, exactly like KioskStatusBar self-gates on
// pathname/auth.

// Reserved height, so ListenInBar can stack directly below this
// (rather than overlapping it) in the rare case an admin is both on
// their own call and listening to another session.
export const CALL_BAR_HEIGHT = 44;

export function CallBar() {
  const { state, sessionId, patientName, elapsedSeconds, errorMessage, hangUp, toggleMute } = useActiveCall();
  const live = state === 'in-call' || state === 'muted';
  const adminListening = useAdminListening(sessionId, live);

  if (state === 'idle') return null;

  const muted = state === 'muted';
  const label =
    state === 'connecting'
      ? 'Connecting…'
      : state === 'ringing'
        ? 'Ringing…'
        : state === 'ended'
          ? 'Call ended'
          : state === 'error'
            ? (errorMessage ?? 'Call failed')
            : formatElapsed(elapsedSeconds);

  return (
    <div
      role="status"
      aria-label="Active call"
      style={{
        position: 'fixed',
        top: `calc(${KIOSK_STATUS_BAR_HEIGHT}px + env(safe-area-inset-top, 0px))`,
        left: 0,
        right: 0,
        zIndex: 60,
        height: CALL_BAR_HEIGHT,
        background: theme.category.voiceCall,
        color: theme.color.surface,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space[3],
        padding: `0 ${theme.space[4]}px`,
        boxShadow: theme.shadow.card,
      }}
    >
      <style>{`@keyframes lng-pulse-dot{0%{box-shadow:0 0 0 0 rgba(255,255,255,0.45)}70%{box-shadow:0 0 0 6px rgba(255,255,255,0)}100%{box-shadow:0 0 0 0 rgba(255,255,255,0)}}`}</style>

      <span style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], minWidth: 0 }}>
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: theme.color.surface,
            flexShrink: 0,
            animation: live ? 'lng-pulse-dot 2s infinite' : undefined,
            opacity: live ? 1 : 0.6,
          }}
        />
        <span
          style={{
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {patientName ?? 'Call'}
        </span>
        <span style={{ fontSize: theme.type.size.sm, fontVariantNumeric: 'tabular-nums', opacity: 0.9 }}>
          {label}
        </span>
        {adminListening ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              padding: `1px ${theme.space[2]}px`,
              borderRadius: theme.radius.pill,
              background: 'rgba(255,255,255,0.18)',
              fontSize: theme.type.size.xs,
              fontWeight: theme.type.weight.semibold,
              flexShrink: 0,
            }}
          >
            <Eye size={11} aria-hidden />
            Admin joined
          </span>
        ) : null}
      </span>

      {state !== 'ended' && state !== 'error' ? (
        <span style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], flexShrink: 0 }}>
          <button
            type="button"
            onClick={toggleMute}
            aria-label={muted ? 'Unmute' : 'Mute'}
            style={{
              appearance: 'none',
              width: 32,
              height: 32,
              borderRadius: theme.radius.pill,
              border: 'none',
              background: muted ? theme.color.surface : 'rgba(255,255,255,0.18)',
              color: muted ? theme.category.voiceCall : theme.color.surface,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            {muted ? <MicOff size={15} aria-hidden /> : <Mic size={15} aria-hidden />}
          </button>
          <button
            type="button"
            onClick={hangUp}
            aria-label="Hang up"
            style={{
              appearance: 'none',
              width: 32,
              height: 32,
              borderRadius: theme.radius.pill,
              border: 'none',
              background: theme.color.alert,
              color: theme.color.surface,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            <PhoneOff size={15} aria-hidden />
          </button>
        </span>
      ) : null}
    </div>
  );
}

function formatElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
