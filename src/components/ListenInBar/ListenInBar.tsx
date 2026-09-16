import { Headphones, PhoneOff } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { useListenIn } from '../../lib/listenIn.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../KioskStatusBar/KioskStatusBar.tsx';
import { CALL_BAR_HEIGHT } from '../CallBar/CallBar.tsx';

// The admin's own "I am silently listening" indicator. Deliberately
// styled nothing like CallBar (dark, not indigo) so an admin can
// never mistake "I am monitoring" for "I am on this call" — the only
// control offered is Stop listening, no mute toggle, since the admin
// is never meant to be unmuted at all. Stacks below CallBar in the
// rare case an admin is both on their own call and listening to
// another session, rather than overlapping it.
export function ListenInBar() {
  const { state, patientName, errorMessage, stopListening } = useListenIn();

  if (state === 'idle') return null;

  const label =
    state === 'connecting'
      ? 'Connecting…'
      : state === 'ended'
        ? 'Call ended'
        : state === 'error'
          ? (errorMessage ?? 'Listening failed')
          : 'Listening';

  return (
    <div
      role="status"
      aria-label="Listening in on a call"
      style={{
        position: 'fixed',
        top: `calc(${KIOSK_STATUS_BAR_HEIGHT}px + ${CALL_BAR_HEIGHT}px + env(safe-area-inset-top, 0px))`,
        left: 0,
        right: 0,
        zIndex: 59,
        height: 40,
        background: theme.color.ink,
        color: theme.color.surface,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space[3],
        padding: `0 ${theme.space[4]}px`,
        boxShadow: theme.shadow.card,
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], minWidth: 0 }}>
        <Headphones size={15} aria-hidden />
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
        <span style={{ fontSize: theme.type.size.sm, opacity: 0.75 }}>{label}</span>
      </span>

      {state !== 'ended' && state !== 'error' ? (
        <button
          type="button"
          onClick={stopListening}
          style={{
            appearance: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            gap: theme.space[1],
            height: 28,
            padding: `0 ${theme.space[3]}px`,
            borderRadius: theme.radius.pill,
            border: 'none',
            background: 'rgba(255,255,255,0.16)',
            color: theme.color.surface,
            fontFamily: 'inherit',
            fontSize: theme.type.size.xs,
            fontWeight: theme.type.weight.semibold,
            cursor: 'pointer',
            WebkitTapHighlightColor: 'transparent',
            flexShrink: 0,
          }}
        >
          <PhoneOff size={13} aria-hidden />
          Stop listening
        </button>
      ) : null}
    </div>
  );
}
