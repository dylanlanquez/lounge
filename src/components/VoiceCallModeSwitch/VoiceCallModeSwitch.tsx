import { type ReactNode } from 'react';
import { Building2, PhoneCall } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { useVoiceCallMode } from '../../lib/voiceCallMode.tsx';

// The Clinic / Voice calls switch in the kiosk top bar.
//
// A two-segment pill sized for the 32px bar: 24px tall, so it sits in
// the tray at the same visual weight as the icon buttons either side.
// The selected segment lifts onto a white surface like the app's
// SegmentedControl; when Voice calls is selected its glyph and label
// take the voice call colour, so a glance at the bar says which mode
// the iPad is in. Only rendered for voice call agents (the hook's
// `available` flag); everyone else never sees it.

export interface VoiceCallModeSwitchProps {
  /** Icons only, for the phone-width bar. Labels stay in aria-label and title. */
  compact?: boolean;
}

export function VoiceCallModeSwitch({ compact = false }: VoiceCallModeSwitchProps) {
  const mode = useVoiceCallMode();
  if (!mode.available) return null;
  return (
    <div
      role="group"
      aria-label="Lounge mode"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        padding: 2,
        height: 24,
        background: 'rgba(14, 20, 20, 0.05)',
        borderRadius: theme.radius.pill,
        flexShrink: 0,
      }}
    >
      <Segment
        label="Clinic"
        title="Clinic mode: the full Lounge desk"
        selected={!mode.active}
        compact={compact}
        onClick={() => mode.setActive(false)}
        icon={<Building2 size={12} aria-hidden />}
        selectedColor={theme.color.ink}
      />
      <Segment
        label="Voice calls"
        title="Voice call mode: your calls only, clinic noise hidden"
        selected={mode.active}
        compact={compact}
        onClick={() => mode.setActive(true)}
        icon={<PhoneCall size={12} aria-hidden />}
        selectedColor={theme.category.voiceCall}
      />
    </div>
  );
}

function Segment({
  label,
  title,
  selected,
  compact,
  onClick,
  icon,
  selectedColor,
}: {
  label: string;
  title: string;
  selected: boolean;
  compact: boolean;
  onClick: () => void;
  icon: ReactNode;
  selectedColor: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={label}
      title={title}
      onClick={onClick}
      style={{
        appearance: 'none',
        border: 'none',
        height: 20,
        padding: compact ? '0 7px' : `0 ${theme.space[2]}px`,
        borderRadius: theme.radius.pill,
        background: selected ? theme.color.surface : 'transparent',
        color: selected ? selectedColor : theme.color.inkMuted,
        boxShadow: selected ? theme.shadow.card : 'none',
        fontFamily: 'inherit',
        fontSize: theme.type.size.xs,
        fontWeight: selected ? theme.type.weight.semibold : theme.type.weight.medium,
        lineHeight: 1,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        cursor: selected ? 'default' : 'pointer',
        whiteSpace: 'nowrap',
        WebkitTapHighlightColor: 'transparent',
        outline: 'none',
        transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, box-shadow ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
    >
      {icon}
      {compact ? null : label}
    </button>
  );
}
