import { Settings, Wifi, WifiOff, Zap } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { batteryTone, useBattery, type BatteryTone } from '../../lib/useBattery.ts';
import { useNow } from '../../lib/useNow.ts';
import { useOnline } from '../../lib/useOnline.ts';
import { theme } from '../../theme/index.ts';

// Reserved height pages add as paddingTop so content doesn't slip
// underneath the fixed bar.
export const KIOSK_STATUS_BAR_HEIGHT = 32;

// Always-visible top strip showing wall-clock time, network status,
// and device battery. Lives outside any route so it persists through
// navigation. Critical in kiosk mode where the system status bar is
// hidden — the receptionist has no other way to see the battery
// before it dies, or to spot an offline state.
export function KioskStatusBar() {
  const now = useNow(60_000);
  const { level, charging, supported } = useBattery();
  const online = useOnline();
  const navigate = useNavigate();

  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  // Compact date — full "Tuesday, 28 April 2026" overflows on portrait
  // tablet. "Tue 28 Apr" + the time reads cleanly inside the 32px bar
  // and gives the receptionist constant temporal context (the page
  // heading sometimes scrolls out of view).
  const date = now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const percent = level === null ? null : Math.round(level * 100);
  const tone = batteryTone(percent);

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
          display: 'inline-flex',
          alignItems: 'baseline',
          gap: theme.space[2],
          letterSpacing: theme.type.tracking.normal,
        }}
      >
        <span style={{ color: theme.color.inkMuted, fontWeight: theme.type.weight.medium }}>
          {date}
        </span>
        <span style={{ fontWeight: theme.type.weight.semibold }}>{time}</span>
      </span>

      <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[3] }}>
        <NetworkIndicator online={online} />
        {supported && percent !== null ? (
          <BatteryIndicator percent={percent} charging={!!charging} tone={tone} />
        ) : null}
        <button
          type="button"
          aria-label="Admin"
          onClick={() => navigate('/admin')}
          style={{
            appearance: 'none',
            border: 'none',
            background: 'transparent',
            color: theme.color.ink,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 24,
            height: 24,
            padding: 0,
            borderRadius: theme.radius.pill,
            WebkitTapHighlightColor: 'transparent',
            outline: 'none',
          }}
        >
          <Settings size={15} />
        </button>
      </span>
    </div>
  );
}

function NetworkIndicator({ online }: { online: boolean }) {
  if (online) {
    return (
      <span
        aria-label="Online"
        title="Online"
        style={{ display: 'inline-flex', alignItems: 'center', color: theme.color.ink }}
      >
        <Wifi size={15} aria-hidden />
      </span>
    );
  }
  return (
    <span
      aria-label="Offline"
      title="Offline. The device is not connected to a network."
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        color: theme.color.alert,
        fontWeight: theme.type.weight.semibold,
      }}
    >
      <WifiOff size={15} aria-hidden />
      <span>Offline</span>
    </span>
  );
}

function BatteryIndicator({
  percent,
  charging,
  tone,
}: {
  percent: number;
  charging: boolean;
  tone: BatteryTone;
}) {
  // Fill colour mirrors iOS conventions:
  //   charging      → green (matches the apple charging fill)
  //   <=10% (crit)  → alert red
  //   <=25% (low)   → amber warn
  //   otherwise     → ink
  const fillColor = charging
    ? theme.color.accent
    : tone === 'critical'
      ? theme.color.alert
      : tone === 'low'
        ? theme.color.warn
        : theme.color.ink;
  const labelColor = charging
    ? theme.color.ink
    : tone === 'critical' || tone === 'low'
      ? fillColor
      : theme.color.ink;

  return (
    <span
      aria-label={`Battery ${percent}%${charging ? ', charging' : ''}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: theme.space[1],
        color: labelColor,
        fontWeight:
          tone === 'critical' || tone === 'low'
            ? theme.type.weight.semibold
            : theme.type.weight.medium,
      }}
    >
      <span>{percent}%</span>
      <BatteryGlyph percent={percent} fillColor={fillColor} charging={charging} />
    </span>
  );
}

// Custom battery glyph: outer rounded body + small terminal nub + inner
// fill rect that scales to the percent. Lucide's outline icons don't
// show the fill clearly on iPad so we draw our own. Charging shows a
// lightning bolt overlay on the fill.
function BatteryGlyph({
  percent,
  fillColor,
  charging,
}: {
  percent: number;
  fillColor: string;
  charging: boolean;
}) {
  const bodyW = 22;
  const bodyH = 11;
  const innerW = 18; // body inner width (after 2px padding each side)
  const innerH = 7;
  const fillW = Math.max(1, Math.round((percent / 100) * innerW));
  return (
    <svg
      width={bodyW + 3}
      height={bodyH}
      viewBox={`0 0 ${bodyW + 3} ${bodyH}`}
      aria-hidden
      style={{ display: 'inline-block', flexShrink: 0 }}
    >
      {/* Body outline */}
      <rect
        x={0.5}
        y={0.5}
        width={bodyW - 1}
        height={bodyH - 1}
        rx={2}
        ry={2}
        fill="none"
        stroke={theme.color.ink}
        strokeOpacity={0.4}
        strokeWidth={1}
      />
      {/* Terminal nub */}
      <rect
        x={bodyW}
        y={(bodyH - 5) / 2}
        width={2}
        height={5}
        rx={1}
        fill={theme.color.ink}
        fillOpacity={0.4}
      />
      {/* Fill */}
      <rect x={2} y={2} width={fillW} height={innerH} rx={1} fill={fillColor} />
      {/* Charging bolt overlay */}
      {charging ? (
        <Zap
          x={(bodyW - 9) / 2}
          y={(bodyH - 9) / 2}
          width={9}
          height={9}
          fill={theme.color.surface}
          stroke={theme.color.surface}
          strokeWidth={0}
        />
      ) : null}
    </svg>
  );
}
