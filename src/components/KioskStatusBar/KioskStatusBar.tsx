import { Battery, BatteryFull, BatteryLow, BatteryMedium, BatteryWarning, Zap } from 'lucide-react';
import { batteryTone, useBattery } from '../../lib/useBattery.ts';
import { useNow } from '../../lib/useNow.ts';
import { theme } from '../../theme/index.ts';

// Reserved height pages add as paddingTop so content doesn't slip
// underneath the fixed bar.
export const KIOSK_STATUS_BAR_HEIGHT = 32;

// Always-visible top strip showing wall-clock time and device battery.
// Lives outside any route so it persists through navigation. Critical
// in kiosk mode where the system status bar is hidden — the receptionist
// has no other way to see the battery before it dies.
export function KioskStatusBar() {
  const now = useNow(60_000);
  const { level, charging, supported } = useBattery();

  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const percent = level === null ? null : Math.round(level * 100);
  const tone = batteryTone(percent);

  const batteryColor =
    tone === 'critical' ? theme.color.alert : tone === 'low' ? theme.color.alert : theme.color.ink;
  const batteryWeight =
    tone === 'critical' || tone === 'low' ? theme.type.weight.semibold : theme.type.weight.medium;

  return (
    <div
      role="status"
      aria-label="Kiosk status"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 49,
        height: KIOSK_STATUS_BAR_HEIGHT,
        background: theme.color.surface,
        borderBottom: `1px solid ${theme.color.border}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: `0 ${theme.space[5]}px`,
        paddingTop: 'env(safe-area-inset-top, 0px)',
        fontSize: theme.type.size.xs,
        fontVariantNumeric: 'tabular-nums',
        color: theme.color.ink,
      }}
    >
      <span
        style={{
          fontWeight: theme.type.weight.semibold,
          letterSpacing: theme.type.tracking.normal,
        }}
      >
        {time}
      </span>

      {supported && percent !== null ? (
        <span
          aria-label={`Battery ${percent}%${charging ? ', charging' : ''}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: theme.space[1],
            color: batteryColor,
            fontWeight: batteryWeight,
          }}
        >
          {charging ? <Zap size={14} fill="currentColor" stroke="none" aria-hidden /> : null}
          <BatteryGlyph percent={percent} tone={tone} />
          <span>{percent}%</span>
        </span>
      ) : null}
    </div>
  );
}

function BatteryGlyph({ percent, tone }: { percent: number; tone: ReturnType<typeof batteryTone> }) {
  if (tone === 'critical') return <BatteryWarning size={16} aria-hidden />;
  if (tone === 'low') return <BatteryLow size={16} aria-hidden />;
  if (percent >= 75) return <BatteryFull size={16} aria-hidden />;
  if (percent >= 40) return <BatteryMedium size={16} aria-hidden />;
  return <Battery size={16} aria-hidden />;
}
