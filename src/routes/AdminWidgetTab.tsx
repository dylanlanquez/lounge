import { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  ExternalLink,
  Monitor,
  PoundSterling,
  RefreshCcw,
  Smartphone,
  Tablet,
} from 'lucide-react';
import { Button, Card, Skeleton, Toast } from '../components/index.ts';
import { theme } from '../theme/index.ts';
import {
  saveProductVisibility,
  saveServiceConfig,
  useWidgetAdminServices,
  type WidgetAdminProduct,
  type WidgetAdminService,
} from '../lib/queries/widgetAdmin.ts';

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
  const [toast, setToast] = useState<{
    tone: 'success' | 'error' | 'info';
    title: string;
    description?: string;
  } | null>(null);

  const activeVp = VIEWPORTS.find((v) => v.key === active)!;
  const reloadPreview = () => setReloadTick((t) => t + 1);

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
          frame to test long flows.
        </p>
      </Card>

      <ServicesEditor
        onSaved={() => {
          reloadPreview();
          setToast({ tone: 'success', title: 'Saved' });
        }}
        onError={(message) =>
          setToast({ tone: 'error', title: 'Could not save', description: message })
        }
      />

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

      {toast ? (
        <div
          style={{
            position: 'fixed',
            bottom: theme.space[6],
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 100,
          }}
        >
          <Toast
            tone={toast.tone}
            title={toast.title}
            description={toast.description}
            onDismiss={() => setToast(null)}
          />
        </div>
      ) : null}
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

// ─────────────────────────────────────────────────────────────────────────────
// Services editor — one collapsible card per booking type, with a
// nested product list for services that have a product axis.
// ─────────────────────────────────────────────────────────────────────────────

function ServicesEditor({
  onSaved,
  onError,
}: {
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const { data, loading, error, refresh } = useWidgetAdminServices();

  return (
    <Card padding="md">
      <div style={{ marginBottom: theme.space[4] }}>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.md,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          Services
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
          Choose which services patients can book online, and (for services with options)
          which products inside each service are offered. Labels and prices come from
          your booking types and catalogue. Edit those in their own tabs; this is just
          the on / off switchboard.
        </p>
      </div>

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
          <Skeleton height={88} />
          <Skeleton height={88} />
          <Skeleton height={88} />
        </div>
      ) : error ? (
        <p
          role="alert"
          style={{
            margin: 0,
            padding: theme.space[3],
            background: '#FFEEEC',
            color: theme.color.alert,
            borderRadius: theme.radius.input,
            fontSize: theme.type.size.sm,
          }}
        >
          Couldn't load services: {error}
        </p>
      ) : data.length === 0 ? (
        <p
          style={{
            margin: 0,
            padding: theme.space[5],
            border: `1px dashed ${theme.color.border}`,
            borderRadius: theme.radius.input,
            background: theme.color.bg,
            color: theme.color.inkMuted,
            fontSize: theme.type.size.sm,
            textAlign: 'center',
          }}
        >
          No services configured yet. Set them up in Admin, Booking types first.
        </p>
      ) : (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: theme.space[3],
          }}
        >
          {data.map((service) => (
            <li key={service.id}>
              <ServiceCard
                service={service}
                onSaved={() => {
                  refresh();
                  onSaved();
                }}
                onError={onError}
              />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ServiceCard({
  service,
  onSaved,
  onError,
}: {
  service: WidgetAdminService;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  // Headline summary: visible-product count + visible state. Read at
  // render time from the parent's data so it stays in sync after
  // saves elsewhere.
  const visibleProductCount = service.products.filter((p) => p.widgetVisible).length;
  const totalProductCount = service.products.length;

  return (
    <div
      style={{
        background: theme.color.surface,
        border: `1px solid ${theme.color.border}`,
        borderRadius: theme.radius.card,
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        style={{
          appearance: 'none',
          width: '100%',
          background: 'transparent',
          border: 'none',
          padding: `${theme.space[4]}px ${theme.space[5]}px`,
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[3],
          fontFamily: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
          transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        }}
        onMouseEnter={(e) => {
          if (expanded) return;
          e.currentTarget.style.background = theme.color.bg;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
        }}
      >
        <ServiceVisibilityBadge visible={service.widgetVisible} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.md,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              letterSpacing: theme.type.tracking.tight,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {service.label}
          </p>
          <p
            style={{
              margin: `${theme.space[1]}px 0 0`,
              fontSize: theme.type.size.xs,
              color: theme.color.inkMuted,
            }}
          >
            {summaryLine(service, visibleProductCount, totalProductCount)}
          </p>
        </div>
        <span
          style={{
            color: theme.color.inkMuted,
            display: 'inline-flex',
            flexShrink: 0,
          }}
        >
          {expanded ? <ChevronDown size={18} aria-hidden /> : <ChevronRight size={18} aria-hidden />}
        </span>
      </button>

      {expanded ? (
        <ServiceCardBody service={service} onSaved={onSaved} onError={onError} />
      ) : null}
    </div>
  );
}

function ServiceCardBody({
  service,
  onSaved,
  onError,
}: {
  service: WidgetAdminService;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  // Local draft for the parent service's widget-* fields. Save
  // commits these in one shot.
  const [visible, setVisible] = useState(service.widgetVisible);
  const [description, setDescription] = useState(service.widgetDescription);
  const [depositText, setDepositText] = useState(formatPoundsText(service.widgetDepositPence));
  const [allowStaffPick, setAllowStaffPick] = useState(service.widgetAllowStaffPick);
  const [saving, setSaving] = useState(false);

  // Re-seed when the parent row changes underneath us.
  useEffect(() => {
    setVisible(service.widgetVisible);
    setDescription(service.widgetDescription);
    setDepositText(formatPoundsText(service.widgetDepositPence));
    setAllowStaffPick(service.widgetAllowStaffPick);
  }, [
    service.widgetVisible,
    service.widgetDescription,
    service.widgetDepositPence,
    service.widgetAllowStaffPick,
  ]);

  const depositPence = parsePoundsToPence(depositText) ?? 0;
  const dirty =
    visible !== service.widgetVisible ||
    description !== service.widgetDescription ||
    depositPence !== service.widgetDepositPence ||
    allowStaffPick !== service.widgetAllowStaffPick;

  const reset = () => {
    setVisible(service.widgetVisible);
    setDescription(service.widgetDescription);
    setDepositText(formatPoundsText(service.widgetDepositPence));
    setAllowStaffPick(service.widgetAllowStaffPick);
  };

  const onSave = async () => {
    setSaving(true);
    try {
      await saveServiceConfig({
        id: service.id,
        widgetVisible: visible,
        widgetDescription: description,
        widgetDepositPence: depositPence,
        widgetAllowStaffPick: allowStaffPick,
      });
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        borderTop: `1px solid ${theme.color.border}`,
        padding: `${theme.space[5]}px`,
        background: theme.color.bg,
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[5],
      }}
    >
      {/* ── Visibility + sticky settings ──────────────────────── */}
      <Section title="Show this service in the widget?">
        <Toggle
          checked={visible}
          onChange={setVisible}
          onLabel="Patients can book this service"
          offLabel="Hidden — patients can't see this service"
        />
      </Section>

      <Section
        title="Description"
        description="One paragraph the patient sees on the picker. Pricing is read from the catalogue, so don't repeat it here."
      >
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder="e.g. Removable, lifelike veneers, designed and fitted in a single visit."
          style={{
            width: '100%',
            padding: theme.space[3],
            borderRadius: theme.radius.input,
            border: `1px solid ${theme.color.border}`,
            background: theme.color.surface,
            color: theme.color.ink,
            fontFamily: 'inherit',
            fontSize: theme.type.size.sm,
            lineHeight: theme.type.leading.snug,
            resize: 'vertical',
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />
      </Section>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: theme.space[4],
        }}
      >
        <Section
          title="Deposit at booking"
          description="Captured upfront via Stripe. £0 means no payment step."
        >
          <PoundsInput value={depositText} onChange={setDepositText} />
        </Section>
        <Section title="Dentist preference" description="Show patients the dentist picker for this service.">
          <Toggle
            checked={allowStaffPick}
            onChange={setAllowStaffPick}
            onLabel="Patient picks a dentist"
            offLabel="We'll match them with anyone"
          />
        </Section>
      </div>

      {service.hasProductAxis ? (
        <Section
          title="Products in this service"
          description={
            service.products.length === 0
              ? "No products in your catalogue match this service yet. Add them in Admin → Products."
              : 'Tick which products patients can choose. Hidden products simply don\'t appear in the widget.'
          }
        >
          {service.products.length === 0 ? null : (
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
              {service.products.map((p) => (
                <li key={p.id}>
                  <ProductRow product={p} onSaved={onSaved} onError={onError} />
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}

      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: theme.space[2],
          marginTop: theme.space[2],
          paddingTop: theme.space[3],
          borderTop: `1px solid ${theme.color.border}`,
        }}
      >
        <Button variant="tertiary" onClick={reset} disabled={!dirty || saving}>
          Cancel
        </Button>
        <Button variant="primary" onClick={onSave} disabled={!dirty || saving} loading={saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </div>
  );
}

function ProductRow({
  product,
  onSaved,
  onError,
}: {
  product: WidgetAdminProduct;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const onToggle = async (next: boolean) => {
    setBusy(true);
    try {
      await saveProductVisibility({ id: product.id, widgetVisible: next });
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        border: `1px solid ${theme.color.border}`,
        borderRadius: theme.radius.input,
        background: theme.color.surface,
        cursor: busy ? 'progress' : 'pointer',
        opacity: busy ? 0.6 : 1,
      }}
    >
      <input
        type="checkbox"
        checked={product.widgetVisible}
        onChange={(e) => onToggle(e.target.checked)}
        disabled={busy}
        style={{
          width: 18,
          height: 18,
          accentColor: theme.color.ink,
          cursor: busy ? 'progress' : 'pointer',
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
          }}
        >
          {product.name}
        </p>
        <p
          style={{
            margin: `${theme.space[1]}px 0 0`,
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {priceLabel(product)}
        </p>
      </div>
      <code
        style={{
          fontSize: 11,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          color: theme.color.inkSubtle,
          background: theme.color.bg,
          padding: '2px 6px',
          borderRadius: 4,
        }}
      >
        {product.code}
      </code>
    </label>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Small UI primitives
// ─────────────────────────────────────────────────────────────────────────────

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p
        style={{
          margin: 0,
          fontSize: theme.type.size.sm,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.ink,
        }}
      >
        {title}
      </p>
      {description ? (
        <p
          style={{
            margin: `${theme.space[1]}px 0 ${theme.space[2]}px`,
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
            lineHeight: theme.type.leading.snug,
          }}
        >
          {description}
        </p>
      ) : (
        <div style={{ height: theme.space[2] }} />
      )}
      {children}
    </div>
  );
}

function ServiceVisibilityBadge({ visible }: { visible: boolean }) {
  return (
    <span
      aria-hidden
      title={visible ? 'Visible to patients' : 'Hidden'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 36,
        height: 36,
        borderRadius: theme.radius.pill,
        background: visible ? theme.color.accentBg : theme.color.bg,
        color: visible ? theme.color.accent : theme.color.inkMuted,
        border: `1px solid ${theme.color.border}`,
        flexShrink: 0,
      }}
    >
      {visible ? <Eye size={16} aria-hidden /> : <EyeOff size={16} aria-hidden />}
    </span>
  );
}

function Toggle({
  checked,
  onChange,
  onLabel,
  offLabel,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  onLabel: string;
  offLabel: string;
}) {
  return (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: theme.space[3],
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      <span
        style={{
          width: 40,
          height: 22,
          borderRadius: 11,
          background: checked ? theme.color.accent : theme.color.border,
          position: 'relative',
          transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 2,
            left: checked ? 20 : 2,
            width: 18,
            height: 18,
            borderRadius: '50%',
            background: theme.color.surface,
            transition: `left ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
            boxShadow: theme.shadow.card,
          }}
        />
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
      />
      <span
        style={{
          fontSize: theme.type.size.sm,
          color: theme.color.ink,
          fontWeight: theme.type.weight.medium,
        }}
      >
        {checked ? onLabel : offLabel}
      </span>
    </label>
  );
}

function PoundsInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        height: 44,
        borderRadius: theme.radius.input,
        border: `1px solid ${theme.color.border}`,
        background: theme.color.surface,
        paddingLeft: theme.space[3],
      }}
    >
      <span
        aria-hidden
        style={{
          color: theme.color.inkMuted,
          display: 'inline-flex',
          marginRight: theme.space[2],
          flexShrink: 0,
        }}
      >
        <PoundSterling size={14} />
      </span>
      <input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0.00"
        style={{
          flex: 1,
          border: 'none',
          background: 'transparent',
          outline: 'none',
          fontFamily: 'inherit',
          fontSize: theme.type.size.base,
          color: theme.color.ink,
          fontVariantNumeric: 'tabular-nums',
          paddingRight: theme.space[3],
          minWidth: 0,
        }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function summaryLine(
  service: WidgetAdminService,
  visibleProductCount: number,
  totalProductCount: number,
): string {
  const parts: string[] = [];
  parts.push(`${service.durationMinutes} min`);
  if (service.hasProductAxis) {
    if (totalProductCount === 0) {
      parts.push('no products');
    } else {
      parts.push(
        `${visibleProductCount} of ${totalProductCount} product${totalProductCount === 1 ? '' : 's'} on`,
      );
    }
  }
  parts.push(service.widgetVisible ? 'shown to patients' : 'hidden from patients');
  return parts.join(' · ');
}

function priceLabel(p: WidgetAdminProduct): string {
  const single = formatPence(p.unitPricePence);
  if (p.archMatch === 'single' && p.bothArchesPricePence !== null) {
    return `${single} per arch · ${formatPence(p.bothArchesPricePence)} both arches`;
  }
  if (p.archMatch === 'both') {
    return `${single} for both arches`;
  }
  return single;
}

function formatPence(p: number): string {
  if (p === 0) return 'Free';
  if (p % 100 === 0) return `£${p / 100}`;
  return `£${(p / 100).toFixed(2)}`;
}

function formatPoundsText(pence: number): string {
  if (pence === 0) return '';
  if (pence % 100 === 0) return String(pence / 100);
  return (pence / 100).toFixed(2);
}

function parsePoundsToPence(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const float = Number(trimmed.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(float) || float < 0) return null;
  return Math.round(float * 100);
}

