import { Bell } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { Checkbox } from '../Checkbox/Checkbox.tsx';
import {
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_TYPE_LABELS,
  type NotificationEventType,
  useNotificationPrefs,
} from '../../lib/queries/notifications.ts';
import { NotificationIcon } from './NotificationIcon.tsx';

// Settings panel for the notifications drawer. Each event type
// gets a single row: icon + name + hint, with a Checkbox on the
// right that toggles the per-account mute state. Saves
// optimistically (the hook reverts on failure) so the UI feels
// instant — matching Linear / Notion settings behaviour.
//
// No save button — auto-saves on toggle.

interface NotificationsSettingsProps {
  // Rendered inside the drawer's main BottomSheet via the onBack
  // navigation; the back chevron is on the parent sheet, not here.
  // This component owns only the body.
}

export function NotificationsSettings(_: NotificationsSettingsProps) {
  const { prefs, loading, error, setTypeEnabled } = useNotificationPrefs();
  const disabled = new Set(prefs?.disabled_types ?? []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
      {/* Header. Bell disc on the leading edge picks up the pastel
          accent (theme.color.accentBg + theme.color.accent) so the
          settings view reads as a sibling of the patient-comms /
          notify-ready section headers elsewhere in the app, not a
          plain text wall. The per-account scope note sits inside
          the same block so it lands in the first read pass. */}
      <header style={{ display: 'flex', alignItems: 'flex-start', gap: theme.space[3] }}>
        <span
          aria-hidden
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 40,
            height: 40,
            borderRadius: theme.radius.pill,
            background: theme.color.accentBg,
            color: theme.color.accent,
            flexShrink: 0,
          }}
        >
          <Bell size={18} aria-hidden />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3
            style={{
              margin: 0,
              fontSize: theme.type.size.md,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              letterSpacing: theme.type.tracking.tight,
            }}
          >
            Notify me about
          </h3>
          <p
            style={{
              margin: `${theme.space[1]}px 0 0`,
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
              lineHeight: theme.type.leading.snug,
            }}
          >
            Pick the event types that appear in your bell. These settings are
            yours alone, turning one off only affects this account, no one else.
            Changes save automatically.
          </p>
        </div>
      </header>

      {loading ? (
        <p style={{ color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>Loading…</p>
      ) : null}

      {error ? (
        <p style={{ color: theme.color.alert, fontSize: theme.type.size.sm }}>{error}</p>
      ) : null}

      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: theme.space[2],
        }}
      >
        {NOTIFICATION_EVENT_TYPES.map((type) => (
          <SettingsRow
            key={type}
            type={type}
            enabled={!disabled.has(type)}
            onToggle={(next) => void setTypeEnabled(type, next)}
          />
        ))}
      </ul>
    </div>
  );
}

function SettingsRow({
  type,
  enabled,
  onToggle,
}: {
  type: NotificationEventType;
  enabled: boolean;
  onToggle: (next: boolean) => void;
}) {
  const labels = NOTIFICATION_TYPE_LABELS[type];
  return (
    <li
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        background: theme.color.surface,
        borderRadius: theme.radius.card,
        border: `1px solid ${theme.color.border}`,
      }}
    >
      <NotificationIcon type={type} size={16} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.base,
            fontWeight: theme.type.weight.medium,
            color: theme.color.ink,
          }}
        >
          {labels.settings}
        </p>
        <p
          style={{
            margin: `${theme.space[1]}px 0 0`,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            lineHeight: theme.type.leading.snug,
          }}
        >
          {labels.hint}
        </p>
      </div>
      <Checkbox
        checked={enabled}
        onChange={onToggle}
        ariaLabel={`Toggle ${labels.settings}`}
      />
    </li>
  );
}
