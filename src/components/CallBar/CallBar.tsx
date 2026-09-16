import { Mic, MicOff, PhoneOff } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { useActiveCall } from '../../lib/activeCall.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../KioskStatusBar/KioskStatusBar.tsx';

// The persistent "on a call" bar. Sits directly under KioskStatusBar,
// mounted at the App root so it survives route navigation the same
// way KioskStatusBar and BottomNav do — an agent mid-call can still
// open the patient's profile or check another tab without the call
// bar (or the call itself) disappearing. Self-gates to nothing when
// there is no active call, exactly like KioskStatusBar self-gates on
// pathname/auth.
export function CallBar() {
  const { state, patientName, elapsedSeconds, errorMessage, hangUp, toggleMute } = useActiveCall();

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

  const live = state === 'in-call' || state === 'muted';

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
        height: 44,
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
