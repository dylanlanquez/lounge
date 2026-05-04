import { useState } from 'react';
import { ExternalLink, Monitor, RefreshCcw, Smartphone, Tablet } from 'lucide-react';
import { Button, Card } from '../components/index.ts';
import { theme } from '../theme/index.ts';

// Admin → Widget tab.
//
// Lets the admin preview the public booking widget at three viewport
// sizes — mobile, tablet, desktop — without leaving the kiosk. The
// preview renders the same /widget/book route the practice's
// website embeds, so what the admin sees is what the patient sees.
//
// A reload button restarts every iframe in lockstep so design /
// copy iteration is fast: edit, save, hit Reload, look at all three
// frames at once. An "Open in new tab" button is there for closer
// inspection.
//
// Phase 2 will gain a config form (which booking types are visible,
// override pricing, etc.) sat next to the preview frames. Phase 1
// is preview-only.

type Viewport = 'mobile' | 'tablet' | 'desktop';

const VIEWPORTS: {
  key: Viewport;
  label: string;
  icon: React.ReactNode;
  width: number;
  height: number;
}[] = [
  { key: 'mobile', label: 'Mobile', icon: <Smartphone size={14} />, width: 390, height: 720 },
  { key: 'tablet', label: 'Tablet', icon: <Tablet size={14} />, width: 768, height: 800 },
  { key: 'desktop', label: 'Desktop', icon: <Monitor size={14} />, width: 1280, height: 800 },
];

const WIDGET_URL = '/widget/book';

export function AdminWidgetTab() {
  const [active, setActive] = useState<Viewport>('mobile');
  const [reloadTick, setReloadTick] = useState(0);

  const activeVp = VIEWPORTS.find((v) => v.key === active)!;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <header>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.md,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          Booking widget
        </p>
        <p
          style={{
            margin: `${theme.space[1]}px 0 0`,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            lineHeight: theme.type.leading.snug,
            maxWidth: 720,
          }}
        >
          The widget patients see when they book from your website. Switch viewports to
          check how it reads on different devices. Most patients book on mobile.
        </p>
      </header>

      <Card padding="md">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: theme.space[3],
            flexWrap: 'wrap',
            marginBottom: theme.space[4],
          }}
        >
          <ViewportToggle active={active} onChange={setActive} />
          <div style={{ display: 'flex', gap: theme.space[2], flexWrap: 'wrap' }}>
            <Button variant="tertiary" size="sm" onClick={() => setReloadTick((t) => t + 1)}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
                <RefreshCcw size={14} aria-hidden /> Reload
              </span>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => window.open(WIDGET_URL, '_blank', 'noopener,noreferrer')}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
                <ExternalLink size={14} aria-hidden /> Open in new tab
              </span>
            </Button>
          </div>
        </div>

        <DeviceFrame
          viewport={activeVp}
          src={`${WIDGET_URL}?_=${reloadTick}`}
        />

        <p
          style={{
            margin: `${theme.space[4]}px 0 0`,
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
            lineHeight: theme.type.leading.snug,
          }}
        >
          The frame above shows the widget at {activeVp.width}px wide. Scroll inside the
          frame to test long flows. The widget renders against demo booking types in this
          phase, so you can click through every screen without writing a real booking.
        </p>
      </Card>

      <Card padding="md">
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
          }}
        >
          Embed snippet
        </p>
        <p
          style={{
            margin: `${theme.space[1]}px 0 ${theme.space[3]}px`,
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
            lineHeight: theme.type.leading.snug,
          }}
        >
          Drop this iframe into your website wherever the booking widget should appear.
          Resizes responsively to its container. Phase 2 adds an auto-resizing variant.
        </p>
        <pre
          style={{
            margin: 0,
            padding: theme.space[3],
            background: theme.color.bg,
            border: `1px solid ${theme.color.border}`,
            borderRadius: theme.radius.input,
            fontSize: theme.type.size.xs,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            color: theme.color.ink,
            overflowX: 'auto',
          }}
        >
{`<iframe
  src="https://lounge.venneir.com/widget/book"
  style="width:100%;min-height:840px;border:0;border-radius:14px"
  title="Book an appointment"
></iframe>`}
        </pre>
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Viewport toggle
// ─────────────────────────────────────────────────────────────────────────────

function ViewportToggle({
  active,
  onChange,
}: {
  active: Viewport;
  onChange: (v: Viewport) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Preview viewport"
      style={{
        display: 'inline-flex',
        background: theme.color.bg,
        border: `1px solid ${theme.color.border}`,
        borderRadius: theme.radius.pill,
        padding: 3,
        gap: 2,
      }}
    >
      {VIEWPORTS.map((vp) => {
        const selected = vp.key === active;
        return (
          <button
            key={vp.key}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(vp.key)}
            style={{
              appearance: 'none',
              border: 'none',
              background: selected ? theme.color.surface : 'transparent',
              color: selected ? theme.color.ink : theme.color.inkMuted,
              padding: `${theme.space[2]}px ${theme.space[3]}px`,
              borderRadius: theme.radius.pill,
              fontFamily: 'inherit',
              fontSize: theme.type.size.sm,
              fontWeight: selected ? theme.type.weight.semibold : theme.type.weight.medium,
              cursor: 'pointer',
              boxShadow: selected ? theme.shadow.card : 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: theme.space[2],
              transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
            }}
          >
            {vp.icon}
            <span>{vp.label}</span>
            <span
              style={{
                fontSize: 11,
                color: theme.color.inkSubtle,
                fontVariantNumeric: 'tabular-nums',
                marginLeft: theme.space[1],
              }}
            >
              {vp.width}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Device frame — outer chrome around the iframe
// ─────────────────────────────────────────────────────────────────────────────

function DeviceFrame({
  viewport,
  src,
}: {
  viewport: { width: number; height: number; key: Viewport };
  src: string;
}) {
  // Mobile / tablet get a phone-shaped chrome with bezel and dynamic
  // island. Desktop gets a browser-window chrome with traffic
  // lights. Either way the outer wrapper is centred horizontally and
  // shrinks to fit the page on narrow screens.
  if (viewport.key === 'desktop') {
    return (
      <div
        style={{
          width: '100%',
          maxWidth: viewport.width,
          margin: '0 auto',
          background: theme.color.surface,
          border: `1px solid ${theme.color.border}`,
          borderRadius: 14,
          overflow: 'hidden',
          boxShadow: theme.shadow.overlay,
        }}
      >
        <BrowserChrome />
        <iframe
          title="Widget preview, desktop"
          src={src}
          style={{
            display: 'block',
            width: '100%',
            height: viewport.height,
            border: 0,
            background: theme.color.bg,
          }}
        />
      </div>
    );
  }

  // Mobile / tablet — a hand-held device chrome. Width fixed at the
  // viewport's pixel width; container scrolls horizontally on
  // narrower admin screens.
  const radius = viewport.key === 'mobile' ? 36 : 24;
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        overflowX: 'auto',
        padding: `${theme.space[2]}px 0`,
      }}
    >
      <div
        style={{
          width: viewport.width,
          flexShrink: 0,
          padding: 12,
          background: '#0E1414',
          borderRadius: radius + 12,
          boxShadow: theme.shadow.overlay,
        }}
      >
        <div
          style={{
            position: 'relative',
            background: theme.color.bg,
            borderRadius: radius,
            overflow: 'hidden',
          }}
        >
          {viewport.key === 'mobile' ? (
            <div
              aria-hidden
              style={{
                position: 'absolute',
                top: 8,
                left: '50%',
                transform: 'translateX(-50%)',
                width: 90,
                height: 22,
                borderRadius: theme.radius.pill,
                background: '#0E1414',
                zIndex: 2,
              }}
            />
          ) : null}
          <iframe
            title={`Widget preview, ${viewport.key}`}
            src={src}
            style={{
              display: 'block',
              width: viewport.width,
              height: viewport.height,
              border: 0,
              background: theme.color.bg,
            }}
          />
        </div>
      </div>
    </div>
  );
}

function BrowserChrome() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        background: theme.color.bg,
        borderBottom: `1px solid ${theme.color.border}`,
      }}
    >
      <div style={{ display: 'inline-flex', gap: 6 }}>
        <span style={dotStyle('#FF5F57')} />
        <span style={dotStyle('#FEBC2E')} />
        <span style={dotStyle('#28C840')} />
      </div>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          height: 24,
          background: theme.color.surface,
          border: `1px solid ${theme.color.border}`,
          borderRadius: theme.radius.input,
          padding: `0 ${theme.space[3]}px`,
          fontSize: 11,
          color: theme.color.inkMuted,
          display: 'inline-flex',
          alignItems: 'center',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        }}
      >
        lounge.venneir.com/widget/book
      </div>
    </div>
  );
}

function dotStyle(color: string): React.CSSProperties {
  return {
    width: 12,
    height: 12,
    borderRadius: '50%',
    background: color,
    display: 'inline-block',
  };
}
