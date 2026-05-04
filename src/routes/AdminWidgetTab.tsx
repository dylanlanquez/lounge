import { useEffect, useState } from 'react';
import {
  Eye,
  EyeOff,
  ExternalLink,
  Monitor,
  PoundSterling,
  RefreshCcw,
  Smartphone,
  Tablet,
  Users,
} from 'lucide-react';
import { Button, Card, Checkbox, Input, Skeleton, Toast } from '../components/index.ts';
import { theme } from '../theme/index.ts';
import {
  saveWidgetBookingType,
  useWidgetAdminBookingTypes,
  type WidgetAdminBookingType,
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

      <BookingTypesEditor
        onSaved={() => {
          reloadPreview();
          setToast({ tone: 'success', title: 'Saved. Preview reloaded.' });
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
// Booking types editor — flip rows on / off, edit copy + price + deposit
// ─────────────────────────────────────────────────────────────────────────────

function BookingTypesEditor({
  onSaved,
  onError,
}: {
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const { data, loading, error, refresh } = useWidgetAdminBookingTypes();

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
          Booking types in this widget
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
          Toggle which services patients see, and edit the copy / price / deposit each
          one shows. Saves go live immediately and reload the preview above.
        </p>
      </div>

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
          <Skeleton height={120} />
          <Skeleton height={120} />
          <Skeleton height={120} />
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
          Couldn't load booking types: {error}
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
          No booking types configured yet. Add one from Admin, Booking types first.
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
          {data.map((row) => (
            <li key={row.id}>
              <BookingTypeRow
                row={row}
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

function BookingTypeRow({
  row,
  onSaved,
  onError,
}: {
  row: WidgetAdminBookingType;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  // Local draft state — saved separately from the parent's read so
  // the admin can leave a card half-edited without it ricocheting
  // across the others.
  const [visible, setVisible] = useState(row.widgetVisible);
  const [label, setLabel] = useState(row.widgetLabel);
  const [description, setDescription] = useState(row.widgetDescription);
  const [priceText, setPriceText] = useState(formatPenceText(row.widgetPricePence));
  const [depositText, setDepositText] = useState(formatPenceText(row.widgetDepositPence));
  const [allowStaffPick, setAllowStaffPick] = useState(row.widgetAllowStaffPick);
  const [saving, setSaving] = useState(false);

  // Re-seed locally if the row prop changes underneath us (after a
  // sibling save → refresh).
  useEffect(() => {
    setVisible(row.widgetVisible);
    setLabel(row.widgetLabel);
    setDescription(row.widgetDescription);
    setPriceText(formatPenceText(row.widgetPricePence));
    setDepositText(formatPenceText(row.widgetDepositPence));
    setAllowStaffPick(row.widgetAllowStaffPick);
  }, [
    row.widgetVisible,
    row.widgetLabel,
    row.widgetDescription,
    row.widgetPricePence,
    row.widgetDepositPence,
    row.widgetAllowStaffPick,
  ]);

  const pricePence = parsePoundsToPence(priceText);
  const depositPence = parsePoundsToPence(depositText) ?? 0;

  const dirty =
    visible !== row.widgetVisible ||
    label !== row.widgetLabel ||
    description !== row.widgetDescription ||
    pricePence !== row.widgetPricePence ||
    depositPence !== row.widgetDepositPence ||
    allowStaffPick !== row.widgetAllowStaffPick;

  const errors: string[] = [];
  if (depositPence < 0) errors.push('Deposit must be £0 or more.');
  if (pricePence !== null && depositPence > pricePence) {
    errors.push("Deposit can't be more than the price.");
  }
  if (visible && !label.trim()) {
    errors.push('Visible booking types need a label.');
  }
  const valid = errors.length === 0;

  const reset = () => {
    setVisible(row.widgetVisible);
    setLabel(row.widgetLabel);
    setDescription(row.widgetDescription);
    setPriceText(formatPenceText(row.widgetPricePence));
    setDepositText(formatPenceText(row.widgetDepositPence));
    setAllowStaffPick(row.widgetAllowStaffPick);
  };

  const onSave = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      await saveWidgetBookingType({
        id: row.id,
        widgetVisible: visible,
        widgetLabel: label,
        widgetDescription: description,
        widgetPricePence: pricePence,
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
        background: theme.color.surface,
        border: `1px solid ${visible ? theme.color.border : theme.color.border}`,
        borderRadius: theme.radius.card,
        padding: theme.space[4],
        opacity: visible ? 1 : 0.85,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: theme.space[3],
          flexWrap: 'wrap',
          marginBottom: theme.space[3],
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[3], minWidth: 0 }}>
          <span
            aria-hidden
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              borderRadius: theme.radius.pill,
              background: visible ? theme.color.accentBg : theme.color.bg,
              color: visible ? theme.color.accent : theme.color.inkMuted,
              border: `1px solid ${theme.color.border}`,
              flexShrink: 0,
            }}
          >
            {visible ? <Eye size={14} aria-hidden /> : <EyeOff size={14} aria-hidden />}
          </span>
          <div style={{ minWidth: 0 }}>
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
              {row.displayLabel || formatServiceType(row.serviceType)}
            </p>
            <p
              style={{
                margin: `${theme.space[1]}px 0 0`,
                fontSize: theme.type.size.xs,
                color: theme.color.inkMuted,
              }}
            >
              {row.durationMinutes} min slot · service key{' '}
              <code
                style={{
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  background: theme.color.bg,
                  padding: '1px 6px',
                  borderRadius: 4,
                  fontSize: 11,
                }}
              >
                {row.serviceType}
              </code>
            </p>
          </div>
        </div>
        <Checkbox
          checked={visible}
          onChange={setVisible}
          label={visible ? 'Visible to patients' : 'Hidden'}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: theme.space[3] }}>
        <Input
          label="Label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="What patients see, e.g. Cleaning &amp; polish"
        />
        <PoundsInput
          label="Price"
          value={priceText}
          onChange={setPriceText}
          icon={<PoundSterling size={14} />}
          placeholder="0.00"
          helper="Empty hides the price."
        />
      </div>

      <div style={{ marginTop: theme.space[3] }}>
        <p
          style={{
            margin: 0,
            marginBottom: theme.space[1],
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
          }}
        >
          Description
        </p>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder="One paragraph the patient sees on the picker."
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
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: theme.space[3],
          marginTop: theme.space[3],
        }}
      >
        <PoundsInput
          label="Deposit captured at booking"
          value={depositText}
          onChange={setDepositText}
          icon={<PoundSterling size={14} />}
          placeholder="0.00"
          helper="£0 means no payment step."
        />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            paddingTop: 22,
          }}
        >
          <Checkbox
            checked={allowStaffPick}
            onChange={setAllowStaffPick}
            label={
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: theme.space[1],
                }}
              >
                <Users size={14} aria-hidden /> Patient picks the dentist
              </span>
            }
          />
        </div>
      </div>

      {errors.length > 0 ? (
        <ul
          style={{
            listStyle: 'none',
            margin: `${theme.space[3]}px 0 0`,
            padding: theme.space[3],
            background: '#FFEEEC',
            borderRadius: theme.radius.input,
            color: theme.color.alert,
            fontSize: theme.type.size.xs,
            display: 'flex',
            flexDirection: 'column',
            gap: theme.space[1],
          }}
        >
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      ) : null}

      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: theme.space[2],
          marginTop: theme.space[4],
          paddingTop: theme.space[3],
          borderTop: `1px solid ${theme.color.border}`,
        }}
      >
        <Button variant="tertiary" onClick={reset} disabled={!dirty || saving}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={onSave}
          disabled={!dirty || !valid || saving}
          loading={saving}
        >
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Pence input — accepts pounds + pence, stores as integer pence
// ─────────────────────────────────────────────────────────────────────────────

function PoundsInput({
  label,
  value,
  onChange,
  icon,
  placeholder,
  helper,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  icon: React.ReactNode;
  placeholder?: string;
  helper?: string;
}) {
  return (
    <div>
      <p
        style={{
          margin: 0,
          marginBottom: theme.space[1],
          fontSize: theme.type.size.sm,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.ink,
        }}
      >
        {label}
      </p>
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
          {icon}
        </span>
        <input
          type="text"
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
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
      {helper ? (
        <p
          style={{
            margin: `${theme.space[1]}px 0 0`,
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
          }}
        >
          {helper}
        </p>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** "12345" pence → "123.45". Null / 0 with no value → "". */
function formatPenceText(pence: number | null): string {
  if (pence === null) return '';
  if (pence === 0) return '';
  return (pence / 100).toFixed(2);
}

/** "123.45" pounds → 12345 pence. Empty / invalid → null. */
function parsePoundsToPence(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const float = Number(trimmed.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(float) || float < 0) return null;
  return Math.round(float * 100);
}

/** "click_in_veneers" → "Click in veneers". Used as a fallback row
 *  title when display_label is empty. */
function formatServiceType(s: string): string {
  return s
    .split('_')
    .filter(Boolean)
    .map((w, i) => (i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}
