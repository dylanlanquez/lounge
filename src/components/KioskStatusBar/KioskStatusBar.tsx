import { useState } from 'react';
import { BarChart3, PoundSterling, Settings } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth.tsx';
import { useCurrentAccount } from '../../lib/queries/currentAccount.ts';
import { batteryTone, useBattery, type BatteryTone } from '../../lib/useBattery.ts';
import { useNow } from '../../lib/useNow.ts';
import { barsFromEffectiveType, useNetwork, type EffectiveType } from '../../lib/useNetwork.ts';
import { theme } from '../../theme/index.ts';
import { Avatar } from '../Avatar/Avatar.tsx';
import { BottomSheet } from '../BottomSheet/BottomSheet.tsx';
import { Button } from '../Button/Button.tsx';

// Reserved height pages add as paddingTop so content doesn't slip
// underneath the fixed bar.
export const KIOSK_STATUS_BAR_HEIGHT = 32;

// Always-visible top strip *for signed-in staff*. Left side carries
// the faint Lounge watermark; right side is the system tray —
// Settings, Wi-Fi, battery, then date and time. Lives outside any
// route so it persists through navigation.
//
// Hidden entirely when no user is signed in (and while the auth
// session is still resolving). The Settings button on this bar
// links straight into the admin surface, so anyone walking past an
// unattended kiosk on the sign-in screen could otherwise tap
// through. SignIn drops the matching paddingTop so the layout
// doesn't carry a phantom 32px gap.
export function KioskStatusBar() {
  const { user, loading: authLoading, signOut } = useAuth();
  const { account } = useCurrentAccount();
  const now = useNow(60_000);
  const { level, charging, supported: batterySupported } = useBattery();
  const network = useNetwork();
  const navigate = useNavigate();
  const [profileOpen, setProfileOpen] = useState(false);

  if (authLoading || !user) return null;
  const showAdminButton = !!account && (account.is_admin || account.is_super_admin);
  const showReportsButton = !!account && account.can_view_reports;
  const showFinancialsButton = !!account && account.can_view_financials;

  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const date = now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const percent = level === null ? null : Math.round(level * 100);
  const tone = batteryTone(percent);

  return (
    <>
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
      <span style={{ display: 'inline-flex', alignItems: 'center' }}>
        {/* Faint logo as a watermark on the left edge. */}
        <img
          src="/lounge-logo.png"
          alt=""
          aria-hidden
          style={{
            height: 16,
            width: 'auto',
            opacity: 0.45,
            display: 'block',
            flexShrink: 0,
          }}
        />
      </span>

      {/* Right cluster: Reports · Financials · Settings · Wi-Fi · Battery
          · Date · Time. Each entry is gated on the matching permission
          flag — receptionists never see the doors they can't open. The
          routes themselves enforce the same gate as defense-in-depth. */}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[3] }}>
        {showReportsButton ? (
          <KioskIconButton label="Reports" onClick={() => navigate('/reports')}>
            <BarChart3 size={15} />
          </KioskIconButton>
        ) : null}
        {showFinancialsButton ? (
          <KioskIconButton label="Financials" onClick={() => navigate('/financials')}>
            <PoundSterling size={15} />
          </KioskIconButton>
        ) : null}
        {showAdminButton ? (
          <KioskIconButton label="Admin" onClick={() => navigate('/admin')}>
            <Settings size={15} />
          </KioskIconButton>
        ) : null}
        {showReportsButton || showFinancialsButton || showAdminButton ? <Divider /> : null}
        <NetworkIndicator
          online={network.online}
          effectiveType={network.effectiveType}
          downlink={network.downlink}
          supported={network.supported}
        />
        {batterySupported && percent !== null ? (
          <BatteryIndicator percent={percent} charging={!!charging} tone={tone} />
        ) : null}
        <Divider />
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'baseline',
            gap: theme.space[2],
          }}
        >
          <span style={{ color: theme.color.inkMuted, fontWeight: theme.type.weight.medium }}>
            {date}
          </span>
          <span style={{ fontWeight: theme.type.weight.semibold }}>{time}</span>
        </span>
        <Divider />
        <ProfileButton
          name={account?.display_name ?? user.email ?? 'You'}
          onClick={() => setProfileOpen(true)}
        />
      </span>

      <StatusBarKeyframes />
    </div>
    <ProfileSheet
      open={profileOpen}
      onClose={() => setProfileOpen(false)}
      email={user.email ?? null}
      displayName={account?.display_name ?? null}
      onSignOut={() => {
        setProfileOpen(false);
        void signOut();
      }}
    />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile button + sheet — moved here from BottomNav so the bottom
// row can give its slot to Appointment History. Sign-out lives inside
// the sheet so the action stays one tap from any surface.
// ─────────────────────────────────────────────────────────────────────────────

function ProfileButton({ name, onClick }: { name: string; onClick: () => void }) {
  // The avatar uses the new xxs (20px) size so it reads as a small
  // identity glyph in the system tray rather than a feature element.
  // Anything larger competes with the date/time on the 32px-tall bar.
  return (
    <button
      type="button"
      aria-label="Profile"
      title={name}
      onClick={onClick}
      style={{
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        WebkitTapHighlightColor: 'transparent',
        outline: 'none',
      }}
    >
      <Avatar name={name} size="xxs" />
    </button>
  );
}

function ProfileSheet({
  open,
  onClose,
  email,
  displayName,
  onSignOut,
}: {
  open: boolean;
  onClose: () => void;
  email: string | null;
  displayName: string | null;
  onSignOut: () => void;
}) {
  const label = displayName ?? email ?? 'No account';
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Signed in"
      description={
        <span style={{ display: 'flex', flexDirection: 'column', gap: theme.space[1] }}>
          <span>{email ?? 'No account'}</span>
          <span style={{ color: theme.color.inkSubtle, fontSize: theme.type.size.sm }}>
            Tap Sign out below to end the session.
          </span>
        </span>
      }
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      }
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[4],
          padding: `${theme.space[4]}px 0`,
        }}
      >
        <Avatar name={label} size="lg" badge="online" />
        <div>
          <p style={{ margin: 0, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold }}>
            {label}
          </p>
          <p
            style={{
              margin: `${theme.space[1]}px 0 0`,
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
            }}
          >
            Receptionist
          </p>
        </div>
      </div>
    </BottomSheet>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Network indicator — bar glyph + tooltip with effective type and Mbps.
// SSID is unavailable to web pages, so the tooltip surfaces what the
// browser can actually read instead of pretending otherwise.
// ─────────────────────────────────────────────────────────────────────────────

function NetworkIndicator({
  online,
  effectiveType,
  downlink,
  supported,
}: {
  online: boolean;
  effectiveType: EffectiveType;
  downlink: number | null;
  supported: boolean;
}) {
  const bars = barsFromEffectiveType(effectiveType, online);
  const colour = !online
    ? theme.color.alert
    : bars >= 3
      ? theme.color.accent
      : bars === 2
        ? theme.color.warn
        : theme.color.alert;

  const label = !online
    ? 'Offline'
    : !supported
      ? 'Online'
      : effectiveType
        ? `${effectiveTypeLabel(effectiveType)}${downlink ? ` · ${downlink.toFixed(1)} Mbps` : ''}`
        : 'Online';

  return (
    <span
      aria-label={label}
      title={
        !online
          ? 'Offline. The device is not connected to a network.'
          : `${label}\n(Wi-Fi network names cannot be read from the browser.)`
      }
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: theme.space[1],
        color: colour,
        fontWeight: !online ? theme.type.weight.semibold : theme.type.weight.medium,
      }}
    >
      <SignalBars count={bars} dimmed={!supported} colour={colour} />
      {!online ? <span>Offline</span> : null}
    </span>
  );
}

function effectiveTypeLabel(et: EffectiveType): string {
  switch (et) {
    case '4g':
      return 'Strong';
    case '3g':
      return 'Good';
    case '2g':
      return 'Weak';
    case 'slow-2g':
      return 'Very weak';
    default:
      return 'Online';
  }
}

function SignalBars({ count, dimmed, colour }: { count: 0 | 1 | 2 | 3 | 4; dimmed: boolean; colour: string }) {
  const widths = [3, 3, 3, 3];
  const heights = [4, 7, 10, 13];
  const gap = 2;
  const totalW = widths.reduce((a, b) => a + b, 0) + gap * (widths.length - 1);
  const totalH = Math.max(...heights);
  const filledOpacity = dimmed ? 0.55 : 1;
  return (
    <svg
      width={totalW}
      height={totalH}
      viewBox={`0 0 ${totalW} ${totalH}`}
      aria-hidden
      style={{ display: 'inline-block', flexShrink: 0 }}
    >
      {widths.map((w, i) => {
        const x = widths.slice(0, i).reduce((a, b) => a + b, 0) + gap * i;
        const h = heights[i]!;
        const y = totalH - h;
        const filled = i < count;
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={w}
            height={h}
            rx={1}
            fill={filled ? colour : theme.color.ink}
            fillOpacity={filled ? filledOpacity : 0.18}
          />
        );
      })}
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Battery indicator — percent + custom glyph. When charging the
// lightning bolt sits INSIDE the battery body, drawn directly into
// the SVG so it's pixel-aligned with the fill and clearly visible
// against the green at every level. The bolt's opacity pulses so it
// reads as live, not static art.
// ─────────────────────────────────────────────────────────────────────────────

function BatteryIndicator({
  percent,
  charging,
  tone,
}: {
  percent: number;
  charging: boolean;
  tone: BatteryTone;
}) {
  const fillColor = charging
    ? theme.color.accent
    : tone === 'critical'
      ? theme.color.alert
      : tone === 'low'
        ? theme.color.warn
        : theme.color.ink;
  const labelColor = charging
    ? theme.color.accent
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
          charging || tone === 'critical' || tone === 'low'
            ? theme.type.weight.semibold
            : theme.type.weight.medium,
      }}
    >
      <span>{percent}%</span>
      <BatteryGlyph percent={percent} fillColor={fillColor} charging={charging} />
    </span>
  );
}

function BatteryGlyph({
  percent,
  fillColor,
  charging,
}: {
  percent: number;
  fillColor: string;
  charging: boolean;
}) {
  // Body: 26 wide × 12 high. Slightly larger than before so the
  // charging bolt has room to read inside without crowding the fill.
  const bodyW = 26;
  const bodyH = 12;
  const innerW = 22;
  const innerH = 8;
  const fillW = Math.max(1, Math.round((percent / 100) * innerW));
  // Compact lightning bolt drawn as an SVG path. Coordinates are
  // tuned to fit a 7×10 box; we translate it so it centres on the
  // body. Solid surface-coloured fill so it stands clear against the
  // green / red / amber fill underneath.
  const boltCx = bodyW / 2;
  const boltCy = bodyH / 2;
  const boltScale = 1;
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
      {/* Fill — full width when charging, percent-scaled otherwise */}
      <rect
        x={2}
        y={2}
        width={charging ? innerW : fillW}
        height={innerH}
        rx={1}
        fill={fillColor}
      />
      {/* Charging bolt, centred inside the body. The path is drawn
          around (0,0) so the translate puts the centre on the body
          centre; scale lets us tune size without recomputing coords. */}
      {charging ? (
        <g
          className="lng-status-bolt"
          transform={`translate(${boltCx} ${boltCy}) scale(${boltScale})`}
        >
          <path
            d="M 1 -5 L -3 1 L 0 1 L -1 5 L 3 -1 L 0 -1 Z"
            fill={theme.color.surface}
            stroke={theme.color.surface}
            strokeWidth={0.4}
            strokeLinejoin="round"
          />
        </g>
      ) : null}
    </svg>
  );
}

// 1px hairline divider used to separate the three groups inside the
// system tray (Settings · Wi-Fi+Battery · Date+Time). Renders at the
// same colour as the bottom border of the bar so it reads as part of
// the chrome, not a content element.
function Divider() {
  return (
    <span
      aria-hidden
      style={{
        width: 1,
        height: 16,
        background: theme.color.border,
        flexShrink: 0,
      }}
    />
  );
}

// Square 24×24 icon button used by the kiosk top-bar entries (Reports,
// Financials, Admin). One helper rather than three near-identical
// inlined <button> tags so any future tweak — focus ring, colour shift,
// disabled state — flows to every entry consistently.
function KioskIconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
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
      {children}
    </button>
  );
}

function StatusBarKeyframes() {
  // Pulse the charging bolt's opacity so it reads as live without the
  // jitter a transform-scale would introduce. Targets the bolt group
  // class so nothing else gets caught.
  return (
    <style>{`
      @keyframes lng-bolt-pulse {
        0%, 100% { opacity: 1; }
        50%      { opacity: 0.55; }
      }
      .lng-status-bolt {
        animation: lng-bolt-pulse 1.6s ease-in-out infinite;
      }
    `}</style>
  );
}
