import { MapPin, Award, Calendar, Sparkles, CreditCard, Clock } from 'lucide-react';
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
// the combined Details step. Mirrors the IncludedPerksCard chrome
// (soft-bg card, 2px #dee9ec border, 12px radius, accent-coloured
// icons in 24px wrappers, 1px hairlines between rows) so the two
// surfaces feel like a matched set.
//
// Prices appear INLINE with the thing they're for — Service line
// carries the service price, each extra carries its own +£X. The
// Total row at the bottom is the only standalone summary. This
// keeps the card a single receipt rather than two stacked summary
// blocks and removes the prior duplication with the sticky
// footer's TODAY / ON THE DAY split.

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
  void copy;

  const serviceLine = state.service
    ? buildServiceLine(state, state.service.label)
    : null;

  // Build the row set in order so we can render hairlines between
  // rows but never after the final row (mirrors IncludedPerksCard).
  // Three row kinds:
  //   item  — full-size icon row (location / service / when / extra)
  //   total — emphasised summary row with heavier top hairline
  //   split — smaller payment-split row (deposit today / balance)
  //           that sits after the Total to break the headline into
  //           how much is paid now vs at the appointment.
  type Row =
    | {
        kind: 'item';
        key: string;
        icon: React.ReactNode;
        title: string;
        subtitle?: string;
        rightAmount?: string;
        rightAmountColour?: string;
      }
    | {
        kind: 'total';
        key: string;
        label: string;
        amount: string;
      }
    | {
        kind: 'split';
        key: string;
        icon: React.ReactNode;
        label: string;
        amount: string;
        muted?: boolean;
      };

  const rows: Row[] = [];

  if (state.location) {
    rows.push({
      kind: 'item',
      key: 'location',
      icon: <MapPin size={20} aria-hidden style={{ color: accent }} />,
      title: state.location.name,
      subtitle: state.location.addressLine,
    });
  }
  if (state.service && serviceLine) {
    rows.push({
      kind: 'item',
      key: 'service',
      icon: <Award size={20} aria-hidden style={{ color: accent }} />,
      title: serviceLine,
      rightAmount:
        priceBreakdown.serviceLinePence > 0
          ? formatPrice(priceBreakdown.serviceLinePence)
          : undefined,
    });
  }
  if (state.slotIso) {
    rows.push({
      kind: 'item',
      key: 'slot',
      icon: <Calendar size={20} aria-hidden style={{ color: accent }} />,
      title: formatSlotLong(state.slotIso),
    });
  }
  for (const u of selectedUpgrades) {
    rows.push({
      kind: 'item',
      key: `upgrade-${u.id}`,
      icon: <Sparkles size={20} aria-hidden style={{ color: QUIZ.LAVENDER }} />,
      title: u.name,
      rightAmount: `+${formatPrice(upgradePrice(u.id))}`,
      rightAmountColour: QUIZ.LAVENDER,
    });
  }
  if (total > 0) {
    rows.push({
      kind: 'total',
      key: 'total',
      label: 'Total',
      amount: formatPrice(total),
    });
  }
  if (priceBreakdown.depositPence > 0) {
    rows.push({
      kind: 'split',
      key: 'deposit',
      icon: <CreditCard size={18} aria-hidden style={{ color: QUIZ.MUTED_2 }} />,
      label: 'Deposit today',
      amount: formatPrice(priceBreakdown.depositPence),
    });
  }
  if (priceBreakdown.payAtAppointmentPence > 0) {
    rows.push({
      kind: 'split',
      key: 'balance',
      icon: <Clock size={18} aria-hidden style={{ color: QUIZ.MUTED_2 }} />,
      label: 'Balance on the day',
      amount: formatPrice(priceBreakdown.payAtAppointmentPence),
      muted: true,
    });
  }

  return (
    <div
      style={{
        background: QUIZ.SOFT_BG,
        border: `2px solid #dee9ec`,
        borderRadius: QUIZ.R_CARD,
        padding: '20px 20px 8px',
        width: '100%',
        // No maxWidth here — the parent (DetailsStep wrapper) caps
        // width at 720px, so letting the card fill its parent makes
        // it line up flush with the form fields above it.
        animation: `vlounge-fadeInUp 0.3s ${QUIZ.EASE_BOUNCE} backwards`,
      }}
    >
      <h3
        style={{
          margin: '0 0 6px',
          fontSize: 17,
          fontWeight: 700,
          color: accent,
          letterSpacing: '-0.01em',
        }}
      >
        Your booking
      </h3>
      {rows.map((row, i) => {
        const isLast = i === rows.length - 1;
        // Suppress the bottom hairline on the row immediately
        // before the Total row — the Total carries its own
        // (heavier) top hairline, so without this we'd stack two
        // 1px lines on top of each other.
        const next = rows[i + 1];
        const nextIsTotal = next?.kind === 'total';
        if (row.kind === 'item') {
          return (
            <ItemRow
              key={row.key}
              icon={row.icon}
              title={row.title}
              subtitle={row.subtitle}
              rightAmount={row.rightAmount}
              rightAmountColour={row.rightAmountColour}
              isLast={isLast || nextIsTotal}
            />
          );
        }
        if (row.kind === 'total') {
          return (
            <TotalRow
              key={row.key}
              label={row.label}
              amount={row.amount}
              isLast={isLast}
            />
          );
        }
        return (
          <SplitRow
            key={row.key}
            icon={row.icon}
            label={row.label}
            amount={row.amount}
            muted={row.muted}
            isLast={isLast}
          />
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Row primitives — chrome matches IncludedPerksCard exactly
// ─────────────────────────────────────────────────────────────────

function ItemRow({
  icon,
  title,
  subtitle,
  rightAmount,
  rightAmountColour,
  isLast,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  rightAmount?: string;
  rightAmountColour?: string;
  isLast: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '14px 0',
        borderBottom: isLast ? 'none' : `1px solid #e9ecef`,
      }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 24,
          flexShrink: 0,
        }}
      >
        {icon}
      </span>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 12,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <p
            style={{
              margin: 0,
              fontSize: 15,
              fontWeight: 600,
              color: QUIZ.INK,
              lineHeight: 1.3,
              wordBreak: 'break-word',
            }}
          >
            {title}
          </p>
          {subtitle ? (
            <p
              style={{
                margin: '4px 0 0',
                fontSize: 13,
                color: QUIZ.SUBTLE,
                lineHeight: 1.3,
                wordBreak: 'break-word',
              }}
            >
              {subtitle}
            </p>
          ) : null}
        </div>
        {rightAmount ? (
          <span
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: rightAmountColour ?? QUIZ.INK,
              whiteSpace: 'nowrap',
              flexShrink: 0,
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: '0.02em',
            }}
          >
            {rightAmount}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function TotalRow({
  label,
  amount,
  isLast,
}: {
  label: string;
  amount: string;
  isLast: boolean;
}) {
  return (
    <div
      role="row"
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: 12,
        padding: '16px 0 14px',
        borderTop: `1px solid #d6dde0`,
        marginTop: 4,
        borderBottom: isLast ? 'none' : `1px solid #e9ecef`,
      }}
    >
      <span
        role="cell"
        style={{
          fontSize: 16,
          fontWeight: 700,
          color: QUIZ.INK,
          letterSpacing: '-0.01em',
        }}
      >
        {label}
      </span>
      <span
        role="cell"
        style={{
          fontSize: 18,
          fontWeight: 700,
          color: QUIZ.INK,
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
          flexShrink: 0,
          letterSpacing: '0.01em',
        }}
      >
        {amount}
      </span>
    </div>
  );
}

function SplitRow({
  icon,
  label,
  amount,
  muted,
  isLast,
}: {
  icon: React.ReactNode;
  label: string;
  amount: string;
  muted?: boolean;
  isLast: boolean;
}) {
  // Smaller scale than ItemRow — these rows are a sub-breakdown of
  // the Total above them, not standalone facts. Icon is muted grey,
  // label is regular weight, amount keeps tabular-nums for clean
  // right-edge alignment when stacked.
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '12px 0',
        borderBottom: isLast ? 'none' : `1px solid #e9ecef`,
      }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 22,
          height: 22,
          flexShrink: 0,
        }}
      >
        {icon}
      </span>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 12,
        }}
      >
        <span
          style={{
            fontSize: 14,
            fontWeight: 500,
            color: muted ? QUIZ.MUTED_2 : QUIZ.INK,
            lineHeight: 1.3,
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: muted ? QUIZ.MUTED_2 : QUIZ.INK,
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
            flexShrink: 0,
            letterSpacing: '0.02em',
          }}
        >
          {amount}
        </span>
      </div>
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
