import { PhoneCall } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { telHref } from '../../lib/voiceCall.ts';

// The voice-call sibling of MeetingLinkCard: same card shape, same
// left-accent-bar convention (the category colour, here indigo
// instead of virtual's teal), but built around a phone number and a
// tap-to-dial button instead of a meeting link. Sits in the same
// layout slot MeetingLinkCard occupies for a Google Meet booking, so
// the two service types read as siblings rather than one being an
// afterthought.
export function VoiceCallActionCard({ patientPhone }: { patientPhone: string | null }) {
  const href = telHref(patientPhone);
  const colour = theme.category.voiceCall;

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

      {href ? (
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
          <a
            href={href}
            style={{
              appearance: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: theme.space[2],
              height: 44,
              padding: `0 ${theme.space[5]}px`,
              borderRadius: theme.radius.pill,
              background: colour,
              color: theme.color.surface,
              fontFamily: 'inherit',
              fontSize: theme.type.size.sm,
              fontWeight: theme.type.weight.semibold,
              textDecoration: 'none',
              flexShrink: 0,
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            <PhoneCall size={16} aria-hidden />
            Call patient
          </a>
        </div>
      ) : (
        <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted, lineHeight: theme.type.leading.snug }}>
          No phone number on file. Open the patient profile and add one before the call.
        </p>
      )}
    </div>
  );
}
