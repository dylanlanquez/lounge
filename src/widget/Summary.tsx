import { Calendar, MapPin, Plus, PoundSterling } from 'lucide-react';
import { theme } from '../theme/index.ts';
import {
  formatPrice,
  type PriceBreakdown,
  type WidgetState,
} from './state.ts';
import {
  axesForService,
  axisValueLabel,
  type AxisKey,
} from '../lib/queries/bookingTypeAxes.ts';
import type { BookingServiceType } from '../lib/queries/bookingTypes.ts';
import type { ResolvedCatalogueRow, WidgetUpgrade } from './data.ts';
import type { WidgetCopy } from './copy.ts';

// Summary panel — the right-hand "Booking Summary" card.
//
// Populates progressively: each chosen field appears as a row with
// its icon. Empty state (Step 1, before anything's chosen) shows a
// faded calendar glyph centred in the card so the panel doesn't
// look broken when the patient first lands.
//
// At Step 5 (Your Details) the panel hosts the primary "Book
// appointment" CTA. Everywhere else, just a Total at the bottom.

export function Summary({
  state,
  upgrades,
  resolvedRow,
  breakdown,
  copy,
  showCta,
  onCtaClick,
  isPaymentNext,
}: {
  state: WidgetState;
  /** Upgrade list resolved against the current axis pins. The
   *  Summary picks the rows the patient has ticked. */
  upgrades: WidgetUpgrade[];
  /** Catalogue row the service + axis pins resolve to. Drives the
   *  service-line price and the per-arch upgrade pricing. */
  resolvedRow: ResolvedCatalogueRow | null;
  /** Price breakdown computed in useBookingState. */
  breakdown: PriceBreakdown;
  /** Editable per-step copy. */
  copy: WidgetCopy;
  showCta: boolean;
  onCtaClick: () => void;
  isPaymentNext: boolean;
}) {
  const selectedUpgrades = upgrades.filter((u) => state.upgradeIds.includes(u.id));
  const hasAnything =
    state.location || state.service || state.slotIso || selectedUpgrades.length > 0;
  const total = breakdown.depositPence > 0 ? breakdown.depositPence : breakdown.subtotalPence;
  const payAtAppointment = breakdown.depositPence > 0 ? breakdown.payAtAppointmentPence : 0;
  const archIsBoth = state.axes.arch === 'both';
  const upgradePrice = (u: WidgetUpgrade): number => {
    if (
      resolvedRow?.archMatch === 'single' &&
      archIsBoth &&
      u.bothArchesPricePence !== null
    ) {
      return u.bothArchesPricePence;
    }
    return u.unitPricePence;
  };

  return (
    <div
      style={{
        background: theme.color.surface,
        border: `1px solid ${theme.color.border}`,
        borderRadius: theme.radius.card,
        padding: theme.space[5],
        boxShadow: theme.shadow.card,
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: theme.type.size.md,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.ink,
          letterSpacing: theme.type.tracking.tight,
        }}
      >
        {copy.summaryTitle}
      </p>

      {hasAnything ? (
        <ul
          style={{
            listStyle: 'none',
            margin: `${theme.space[4]}px 0 0`,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: theme.space[3],
          }}
        >
          {state.location ? (
            <Row icon={<MapPin size={14} />} primary={state.location.name} secondary={state.location.addressLine} />
          ) : null}
          {state.service ? (
            <Row
              icon={<PoundSterling size={14} />}
              primary={state.service.label}
              secondary={axisChainLabel(state) ?? undefined}
              right={
                breakdown.serviceLinePence > 0
                  ? formatPrice(breakdown.serviceLinePence)
                  : undefined
              }
            />
          ) : null}
          {selectedUpgrades.map((u) => (
            <Row
              key={u.id}
              icon={<Plus size={14} />}
              primary={u.name}
              right={`+${formatPrice(upgradePrice(u))}`}
            />
          ))}
          {state.slotIso ? (
            <Row icon={<Calendar size={14} />} primary={formatSlotLong(state.slotIso)} />
          ) : null}
        </ul>
      ) : (
        <EmptyIllustration />
      )}

      <div
        style={{
          marginTop: theme.space[5],
          paddingTop: theme.space[4],
          borderTop: `1px solid ${theme.color.border}`,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            gap: theme.space[3],
          }}
        >
          <span
            style={{
              fontSize: theme.type.size.md,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
            }}
          >
            {copy.summaryTotalLabel}
          </span>
          <span
            style={{
              fontSize: theme.type.size.lg,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: theme.type.tracking.tight,
            }}
          >
            {formatPrice(total)}
          </span>
        </div>
        {payAtAppointment > 0 ? (
          <div
            style={{
              marginTop: theme.space[2],
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              gap: theme.space[3],
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
            }}
          >
            <span>{copy.summaryPayLaterLabel}</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>
              {formatPrice(payAtAppointment)}
            </span>
          </div>
        ) : null}
      </div>

      {showCta ? (
        <button
          type="button"
          onClick={onCtaClick}
          style={{
            marginTop: theme.space[4],
            width: '100%',
            height: 48,
            appearance: 'none',
            border: 'none',
            background: theme.color.ink,
            color: theme.color.surface,
            borderRadius: theme.radius.pill,
            fontFamily: 'inherit',
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            cursor: 'pointer',
            transition: `transform ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
          }}
          onMouseDown={(e) => {
            e.currentTarget.style.transform = 'scale(0.98)';
          }}
          onMouseUp={(e) => {
            e.currentTarget.style.transform = 'scale(1)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'scale(1)';
          }}
        >
          {isPaymentNext ? copy.summaryCtaPayment : copy.summaryCtaBook}
        </button>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function Row({
  icon,
  primary,
  secondary,
  right,
}: {
  icon: React.ReactNode;
  primary: string;
  secondary?: string;
  right?: string;
}) {
  return (
    <li
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: theme.space[3],
      }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
          height: 28,
          borderRadius: theme.radius.pill,
          background: theme.color.bg,
          color: theme.color.inkMuted,
          flexShrink: 0,
          marginTop: 2,
        }}
      >
        {icon}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            lineHeight: theme.type.leading.snug,
          }}
        >
          {primary}
        </p>
        {secondary ? (
          <p
            style={{
              margin: `${theme.space[1]}px 0 0`,
              fontSize: theme.type.size.xs,
              color: theme.color.inkMuted,
              lineHeight: theme.type.leading.snug,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {secondary}
          </p>
        ) : null}
      </div>
      {right ? (
        <span
          style={{
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            fontVariantNumeric: 'tabular-nums',
            flexShrink: 0,
          }}
        >
          {right}
        </span>
      ) : null}
    </li>
  );
}

function EmptyIllustration() {
  return (
    <div
      style={{
        margin: `${theme.space[6]}px auto`,
        width: 80,
        height: 80,
        borderRadius: '50%',
        background: theme.color.bg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: theme.color.inkSubtle,
      }}
    >
      <Calendar size={32} aria-hidden />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatSlotLong(iso: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long' });
  const hour = d.getHours();
  const minute = d.getMinutes();
  const period = hour < 12 ? 'am' : 'pm';
  const display = hour <= 12 ? hour : hour - 12;
  return `${day}, ${display}:${String(minute).padStart(2, '0')} ${period}`;
}

/** Builds a "Whitening tray · Upper arch" chain from the booking
 *  state's pinned axes. Returns null if the service has no axes
 *  declared, or no axes have been picked yet. */
function axisChainLabel(state: WidgetState): string | null {
  if (!state.service) return null;
  const axes = axesForService(state.service.serviceType as BookingServiceType);
  if (axes.length === 0) return null;
  const pieces: string[] = [];
  for (const axis of axes) {
    const value = readAxisPin(state, axis.key);
    if (!value) continue;
    pieces.push(axisValueLabel(axis, value));
  }
  return pieces.length > 0 ? pieces.join(' · ') : null;
}

function readAxisPin(state: WidgetState, key: AxisKey): string | undefined {
  if (key === 'repair_variant') return state.axes.repair_variant;
  if (key === 'product_key') return state.axes.product_key;
  if (key === 'arch') return state.axes.arch;
  return undefined;
}
