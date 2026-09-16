import { useState } from 'react';
import { PhoneCall } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { useActiveCall } from '../../lib/activeCall.tsx';

// The voice-call sibling of MeetingLinkCard: same card shape, same
// left-accent-bar convention (the category colour, here indigo
// instead of virtual's teal), but built around a phone number and a
// real in-browser call button instead of a meeting link. Sits in the
// same layout slot MeetingLinkCard occupies for a Google Meet
// booking, so the two service types read as siblings rather than one
// being an afterthought.
//
// "Call patient" places the call itself, through ActiveCallProvider's
// Twilio softphone — mute and hang up live on the persistent CallBar
// once the call is live, not duplicated here.
export function VoiceCallActionCard({
  appointmentId,
  patientId,
  patientPhone,
  patientName,
}: {
  appointmentId: string;
  patientId: string;
  patientPhone: string | null;
  patientName: string;
}) {
  const activeCall = useActiveCall();
  const [starting, setStarting] = useState(false);
  const colour = theme.category.voiceCall;

  const isThisCall = activeCall.appointmentId === appointmentId;
  const callElsewhereActive = activeCall.state !== 'idle' && activeCall.state !== 'ended' && !isThisCall;
  const callHereActive = isThisCall && activeCall.state !== 'idle' && activeCall.state !== 'ended';

  const handleCall = async () => {
    if (!patientPhone || starting || callElsewhereActive || callHereActive) return;
    setStarting(true);
    try {
      await activeCall.startCall({ appointmentId, patientId, patientPhone, patientName });
    } finally {
      setStarting(false);
    }
  };

  return (
    <div
      style={{
        background: theme.color.surface,
        borderRadius: theme.radius.card,
        boxShadow: theme.shadow.card,
        border: `1px solid ${theme.color.border}`,
        borderLeft: `3px solid ${colour}`,
        padding: `${theme.space[4]}px ${theme.space[5]}px`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], marginBottom: theme.space[3] }}>
        <PhoneCall size={16} color={colour} aria-hidden />
        <span
          style={{
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          Voice call
        </span>
      </div>

      {patientPhone ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: theme.space[4], flexWrap: 'wrap' }}>
          <span
            style={{
              fontSize: theme.type.size.xl,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: theme.type.tracking.tight,
            }}
          >
            {patientPhone}
          </span>
          <button
            type="button"
            onClick={handleCall}
            disabled={starting || callElsewhereActive || callHereActive}
            style={{
              appearance: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: theme.space[2],
              height: 44,
              padding: `0 ${theme.space[5]}px`,
              borderRadius: theme.radius.pill,
              border: 'none',
              background: callElsewhereActive ? theme.color.inkSubtle : colour,
              color: theme.color.surface,
              fontFamily: 'inherit',
              fontSize: theme.type.size.sm,
              fontWeight: theme.type.weight.semibold,
              flexShrink: 0,
              cursor: starting || callElsewhereActive || callHereActive ? 'default' : 'pointer',
              opacity: starting ? 0.7 : 1,
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            <PhoneCall size={16} aria-hidden />
            {callElsewhereActive
              ? 'Call in progress elsewhere'
              : callHereActive
                ? callStatusLabel(activeCall.state, activeCall.elapsedSeconds)
                : starting
                  ? 'Connecting…'
                  : 'Call patient'}
          </button>
        </div>
      ) : (
        <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted, lineHeight: theme.type.leading.snug }}>
          No phone number on file. Open the patient profile and add one before the call.
        </p>
      )}
    </div>
  );
}

function callStatusLabel(state: string, elapsedSeconds: number): string {
  if (state === 'connecting') return 'Connecting…';
  if (state === 'ringing') return 'Ringing…';
  if (state === 'error') return 'Call failed';
  const m = Math.floor(elapsedSeconds / 60);
  const s = elapsedSeconds % 60;
  return `In call · ${m}:${String(s).padStart(2, '0')}`;
}
