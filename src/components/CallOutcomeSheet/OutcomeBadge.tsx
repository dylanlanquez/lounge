import { Check, Phone, PhoneMissed, Voicemail } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { voiceCallOutcomeLabel, voiceCallOutcomeTone, type VoiceCallOutcome } from '../../lib/queries/voiceCallLog.ts';

// Small pill used everywhere a logged call's outcome is shown: the
// Call record card, the Previous calls list, and the history page.
// Colour follows the outcome's tone; the glyph gives it a second,
// non-colour signal (answered vs missed vs still-moving) so the row
// still reads at a glance for anyone colour-blind to the accent hues.
export function OutcomeBadge({ outcome, size = 'sm' }: { outcome: VoiceCallOutcome; size?: 'sm' | 'md' }) {
  const tone = voiceCallOutcomeTone(outcome);
  const colour = tone === 'good' ? theme.color.accent : tone === 'bad' ? theme.color.alert : theme.color.warn;
  const Icon = outcome === 'answered' ? Check : outcome === 'voicemail' ? Voicemail : outcome === 'no_answer' ? PhoneMissed : Phone;
  const height = size === 'md' ? 26 : 22;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        height,
        padding: `0 ${size === 'md' ? theme.space[3] : theme.space[2]}px`,
        borderRadius: theme.radius.pill,
        background: `${colour}14`,
        color: colour,
        fontSize: size === 'md' ? theme.type.size.sm : theme.type.size.xs,
        fontWeight: theme.type.weight.semibold,
        whiteSpace: 'nowrap',
      }}
    >
      <Icon size={size === 'md' ? 13 : 11} strokeWidth={2.5} aria-hidden />
      {voiceCallOutcomeLabel(outcome)}
    </span>
  );
}
