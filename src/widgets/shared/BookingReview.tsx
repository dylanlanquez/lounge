import {
  axesForService,
  axisValueLabel,
  type AxisKey,
} from '../../lib/queries/bookingTypeAxes.ts';
import type { BookingServiceType } from '../../lib/queries/bookingTypes.ts';
import type { BookingStateApi, WidgetState } from './state.ts';
import { formatPrice } from './state.ts';
import type { WidgetCopy } from './copy.ts';
import { QUIZ } from './quizTokens.ts';

// Booking review — appointment recap + price total shown inside
// the combined Details step. Single column, zero card chrome on
// this screen (the form inputs above carry the only borders).
//
// Rules learned the hard way on this screen:
//   1. NEVER repeat the deposit / balance split here. The sticky
//      footer already shows TODAY / ON THE DAY. Duplicating those
//      figures (Deposit today, Balance on the day) makes the screen
//      a wall of numbers and confuses non-technical customers.
//   2. NEVER mix icon weights/colours in the booking list. The pin,
//      ribbon, calendar, sparkle quartet looked busy and the
//      vertical centres didn't line up. Typography-only is calmer
//      and more premium.
//   3. Right-aligned amounts MUST have `flex-shrink: 0` so they
//      can't clip off the right edge of narrow viewports.

export function BookingReview({
  api,
  copy,
  accent = QUIZ.ACCENT,
}: {
  api: BookingStateApi;
  copy: WidgetCopy;
  accent?: string;
}) {
  const { state, upgrades, priceBreakdown } = api;
  const selectedUpgrades = upgrades.filter((u) =>
    state.upgradeIds.includes(u.id),
  );
  const archIsBoth = state.axes.arch === 'both';
  const upgradePrice = (upgradeId: string): number => {
    const u = upgrades.find((x) => x.id === upgradeId);
    if (!u) return 0;
    return archIsBoth && u.bothArchesPricePence !== null
      ? u.bothArchesPricePence
      : u.unitPricePence;
  };

  const total = priceBreakdown.subtotalPence;
  const showExtras = priceBreakdown.upgradesLinePence > 0;
  void copy;
  void accent;

  const serviceLine = state.service
    ? buildServiceLine(state, state.service.label)
    : null;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 28,
        width: '100%',
      }}
    >
      {/* ── Your booking ─────────────────────────────────────────
          Label-content rows. No icons, no card. Each row is
          self-titled by a small-caps label on the left (desktop)
          or above (mobile, via the .vlounge-review-row class). */}
      <section>
        <SectionLabel>Your booking</SectionLabel>
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            borderTop: '1px solid rgba(0, 0, 0, 0.08)',
          }}
        >
          {state.location ? (
            <ReviewRow
              label="Location"
              primary={state.location.name}
              secondary={state.location.addressLine}
            />
          ) : null}
          {serviceLine ? (
            <ReviewRow label="Service" primary={serviceLine} />
          ) : null}
          {state.slotIso ? (
            <ReviewRow label="When" primary={formatSlotLong(state.slotIso)} />
          ) : null}
          {selectedUpgrades.map((u) => (
            <ReviewRow
              key={u.id}
              label="Extra"
              primary={u.name}
              rightAmount={`+${formatPrice(upgradePrice(u.id))}`}
              rightAmountColour={QUIZ.LAVENDER}
            />
          ))}
        </ul>
      </section>

      {/* ── Total ────────────────────────────────────────────────
          Three lines max: Service · Extras (if any) · Total.
          Deposit/Balance split lives in the sticky footer only —
          showing it twice was the headline complaint on the
          previous pass. */}
      <section>
        <SectionLabel>Total</SectionLabel>
        <div
          style={{
            borderTop: '1px solid rgba(0, 0, 0, 0.08)',
          }}
        >
          {priceBreakdown.serviceLinePence > 0 ? (
            <PriceRow
              label="Service"
              amount={formatPrice(priceBreakdown.serviceLinePence)}
            />
          ) : null}
          {showExtras ? (
            <PriceRow
              label="Extras"
              amount={`+${formatPrice(priceBreakdown.upgradesLinePence)}`}
              amountColour={QUIZ.LAVENDER}
            />
          ) : null}
          {total > 0 ? (
            <PriceRow label="Total" amount={formatPrice(total)} emphasised />
          ) : null}
        </div>
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Section primitives
// ─────────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3
      style={{
        margin: '0 0 10px',
        fontSize: 11,
        fontWeight: 600,
        color: QUIZ.MUTED_2,
        textTransform: 'uppercase',
        letterSpacing: '0.1em',
      }}
    >
      {children}
    </h3>
  );
}

function ReviewRow({
  label,
  primary,
  secondary,
  rightAmount,
  rightAmountColour,
}: {
  label: string;
  primary: string;
  secondary?: string;
  rightAmount?: string;
  rightAmountColour?: string;
}) {
  return (
    <li
      className="vlounge-review-row"
      style={{
        display: 'grid',
        gridTemplateColumns: '110px 1fr auto',
        columnGap: 16,
        rowGap: 2,
        padding: '14px 0',
        borderBottom: '1px solid rgba(0, 0, 0, 0.06)',
        alignItems: 'baseline',
      }}
    >
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: QUIZ.MUTED_2,
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          lineHeight: 1.4,
        }}
      >
        {label}
      </span>
      <div style={{ minWidth: 0 }}>
        <p
          style={{
            margin: 0,
            fontSize: 15,
            fontWeight: 500,
            color: QUIZ.INK,
            lineHeight: 1.4,
            wordBreak: 'break-word',
          }}
        >
          {primary}
        </p>
        {secondary ? (
          <p
            style={{
              margin: '2px 0 0',
              fontSize: 13,
              color: QUIZ.MUTED_2,
              lineHeight: 1.4,
              wordBreak: 'break-word',
            }}
          >
            {secondary}
          </p>
        ) : null}
      </div>
      {rightAmount ? (
        <span
          style={{
            flexShrink: 0,
            fontSize: 14,
            fontWeight: 600,
            color: rightAmountColour ?? QUIZ.INK,
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
          }}
        >
          {rightAmount}
        </span>
      ) : (
        <span aria-hidden />
      )}
    </li>
  );
}

function PriceRow({
  label,
  amount,
  amountColour,
  emphasised = false,
}: {
  label: string;
  amount: string;
  amountColour?: string;
  emphasised?: boolean;
}) {
  return (
    <div
      role="row"
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: 16,
        padding: emphasised ? '14px 0 4px' : '12px 0',
        borderTop: emphasised ? '1px solid rgba(0, 0, 0, 0.10)' : 'none',
        marginTop: emphasised ? 6 : 0,
        fontSize: emphasised ? 16 : 14,
        color: QUIZ.INK,
      }}
    >
      <span role="cell">{label}</span>
      <span
        role="cell"
        style={{
          flexShrink: 0,
          fontWeight: emphasised ? 700 : 600,
          color: amountColour ?? QUIZ.INK,
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
        }}
      >
        {amount}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function formatSlotLong(iso: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
  });
  const hour = d.getHours();
  const minute = d.getMinutes();
  const period = hour < 12 ? 'am' : 'pm';
  const display = hour === 0 ? 12 : hour <= 12 ? hour : hour - 12;
  return `${day}, ${display}:${String(minute).padStart(2, '0')} ${period}`;
}

function buildServiceLine(state: WidgetState, serviceLabel: string): string {
  const cleanLabel = serviceLabel.replace(/<[^>]*>/g, '');
  if (!state.service) return cleanLabel;
  const axes = axesForService(state.service.serviceType as BookingServiceType);
  if (axes.length === 0) return cleanLabel;
  const pieces: string[] = [];
  for (const axis of axes) {
    const value = readAxisPin(state, axis.key);
    if (!value) continue;
    pieces.push(axisValueLabel(axis, value));
  }
  if (pieces.length === 0) return cleanLabel;
  return `${cleanLabel}, ${pieces.join(', ')}`;
}

function readAxisPin(state: WidgetState, key: AxisKey): string | undefined {
  if (key === 'repair_variant') return state.axes.repair_variant;
  if (key === 'product_key') return state.axes.product_key;
  if (key === 'arch') return state.axes.arch;
  return undefined;
}
