import { MapPin, Award, Calendar } from 'lucide-react';
import {
  axesForService,
  axisValueLabel,
  type AxisKey,
} from '../../lib/queries/bookingTypeAxes.ts';
import type { BookingServiceType } from '../../lib/queries/bookingTypes.ts';
import type { BookingStateApi, RepairLine, WidgetState } from './state.ts';
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

  const isRepair = state.service?.serviceType === 'denture_repair';
  // For denture-repair the service line is just the type label (per-
  // arch breakdown follows in its own section); for everything else
  // the legacy axis-appending behaviour stays so the line still reads
  // "Retainers, Upper" etc.
  const serviceLine = state.service
    ? isRepair
      ? state.service.label.replace(/<[^>]*>/g, '').trim()
      : buildServiceLine(state, state.service.label)
    : null;

  // Build the row set in order so we can render hairlines between
  // rows but never after the final row (mirrors IncludedPerksCard).
  // Four row kinds:
  //   subheader — uppercase muted section divider (UPPER / LOWER /
  //               UPGRADES). No hairline below; the rows that follow
  //               carry their own.
  //   item  — full-size icon row (location / service / when / extra)
  //   total — emphasised summary row with heavier top hairline
  //   split — smaller payment-split row (deposit today / balance)
  //           that sits after the Total to break the headline into
  //           how much is paid now vs at the appointment.
  type Row =
    | {
        kind: 'subheader';
        key: string;
        label: string;
      }
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
        // Iconless row used under a subheader (per-arch repair lines,
        // upgrade lines). Matches the staff AppointmentExtras pattern
        // — section header carries the context, rows below are flat
        // label + price. Visual break with the icon-led rows above is
        // intentional and signals "you're now reading the breakdown".
        kind: 'extra';
        key: string;
        title: string;
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
        emphasized?: boolean;
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
      // Repair bookings sum prices per-line below; the type-only
      // service row shouldn't carry a duplicate aggregate price.
      rightAmount:
        !isRepair && priceBreakdown.serviceLinePence > 0
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
  // Denture-repair per-arch breakdown. Each pinned arch gets its own
  // subheader followed by its repair lines (qty suffix for per-tooth).
  // Mirrors AppointmentExtras on the staff side so the patient and
  // receptionist see the same shape.
  if (isRepair && state.repairItems.length > 0) {
    const repairsByArch = groupRepairsByArch(state.repairItems);
    const archOrder: Array<'upper' | 'lower' | 'both'> = ['upper', 'lower', 'both'];
    for (const arch of archOrder) {
      const lines = repairsByArch.get(arch);
      if (!lines || lines.length === 0) continue;
      rows.push({
        kind: 'subheader',
        key: `repair-${arch}-header`,
        label: ARCH_LABEL[arch],
      });
      for (const line of lines) {
        const qtySuffix =
          line.unitLabel === 'per tooth' && line.quantity > 1
            ? ` × ${line.quantity} teeth`
            : '';
        rows.push({
          kind: 'extra',
          key: `repair-${line.lineId}`,
          title: `${line.name}${qtySuffix}`,
          rightAmount: formatPrice(line.lineTotalPence),
        });
      }
    }
  }
  if (selectedUpgrades.length > 0) {
    rows.push({
      kind: 'subheader',
      key: 'upgrades-header',
      label: 'Upgrades',
    });
    for (const u of selectedUpgrades) {
      rows.push({
        kind: 'extra',
        key: `upgrade-${u.id}`,
        title: u.name,
        rightAmount: `+${formatPrice(upgradePrice(u.id))}`,
        rightAmountColour: QUIZ.LAVENDER,
      });
    }
  }
  if (total > 0) {
    rows.push({
      kind: 'total',
      key: 'total',
      label: 'Total',
      amount: formatPrice(total),
    });
  }
  // Pay-now vs pay-on-the-day is now chosen via the two CTAs in
  // the footer, not surfaced as deduction rows here. The summary
  // card just owns the line items + Total; the buttons below own
  // the timing.

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
        // 1px lines on top of each other. Subheaders never carry
        // a bottom hairline (the row they introduce owns it), and
        // the row before a subheader keeps its own hairline so
        // the section break reads cleanly.
        const next = rows[i + 1];
        const nextIsTotal = next?.kind === 'total';
        const nextIsSubheader = next?.kind === 'subheader';
        if (row.kind === 'subheader') {
          return (
            <SubheaderRow key={row.key} label={row.label} accent={accent} />
          );
        }
        if (row.kind === 'item') {
          return (
            <ItemRow
              key={row.key}
              icon={row.icon}
              title={row.title}
              subtitle={row.subtitle}
              rightAmount={row.rightAmount}
              rightAmountColour={row.rightAmountColour}
              isLast={isLast || nextIsTotal || nextIsSubheader}
            />
          );
        }
        if (row.kind === 'extra') {
          return (
            <ExtraRow
              key={row.key}
              title={row.title}
              rightAmount={row.rightAmount}
              rightAmountColour={row.rightAmountColour}
              isLast={isLast || nextIsTotal || nextIsSubheader}
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
            emphasized={row.emphasized}
            accent={accent}
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
  emphasized,
  accent,
  isLast,
}: {
  icon: React.ReactNode;
  label: string;
  amount: string;
  muted?: boolean;
  emphasized?: boolean;
  accent: string;
  isLast: boolean;
}) {
  // Three visual modes:
  //   • emphasized — the row the eye should land on (Balance on the
  //     day). Larger label, big bold amount in the brand accent so
  //     the customer's "what do I pay on the day" question is
  //     answered at a glance after the deductions above.
  //   • muted       — deductions / secondary references (deposit
  //     today carries a minus prefix from the producer, so this
  //     row reads as money coming off the Total above).
  //   • default     — historical SplitRow look, kept in place for
  //     any future row that fits neither of the above.
  const iconSize = emphasized ? 26 : 22;
  const padY = emphasized ? 16 : 12;
  const labelStyle: React.CSSProperties = emphasized
    ? { fontSize: 15, fontWeight: 600, color: QUIZ.INK, lineHeight: 1.3 }
    : { fontSize: 14, fontWeight: 500, color: muted ? QUIZ.MUTED_2 : QUIZ.INK, lineHeight: 1.3 };
  const amountStyle: React.CSSProperties = emphasized
    ? {
        fontSize: 20,
        fontWeight: 700,
        color: accent,
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
        flexShrink: 0,
        letterSpacing: '0.01em',
      }
    : {
        fontSize: 14,
        fontWeight: 600,
        color: muted ? QUIZ.MUTED_2 : QUIZ.INK,
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
        flexShrink: 0,
        letterSpacing: '0.02em',
      };
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: `${padY}px 0`,
        borderBottom: isLast ? 'none' : `1px solid #e9ecef`,
      }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: iconSize,
          height: iconSize,
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
        <span style={labelStyle}>{label}</span>
        <span style={amountStyle}>{amount}</span>
      </div>
    </div>
  );
}

// ExtraRow — flat label + amount row used under a subheader for the
// per-arch repair lines + selected upgrades. Mirrors AppointmentExtras
// on the staff side: a hairline-separated full-width row, no icon
// column. The icon-led rows above the first subheader (location /
// service / slot) provide the visual anchor; once a subheader breaks
// the rhythm we drop into the unfussy listing pattern.
function ExtraRow({
  title,
  rightAmount,
  rightAmountColour,
  isLast,
}: {
  title: string;
  rightAmount?: string;
  rightAmountColour?: string;
  isLast: boolean;
}) {
  return (
    <div
      role="row"
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 12,
        padding: '10px 0',
        borderBottom: isLast ? 'none' : `1px solid #e9ecef`,
      }}
    >
      <span
        role="cell"
        style={{
          fontSize: 14,
          color: QUIZ.INK,
          fontWeight: 500,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          lineHeight: 1.3,
        }}
      >
        {title}
      </span>
      {rightAmount ? (
        <span
          role="cell"
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
  );
}

// SubheaderRow — uppercase muted section divider used inside the
// summary card for the per-arch repair groups (UPPER / LOWER) and
// the "UPGRADES" header. Mirrors the AppointmentExtras ArchHeader
// pattern on the staff app so the patient + receptionist see the
// same section hierarchy. No bottom hairline — the row beneath
// inherits the section visually rather than via a divider line.
function SubheaderRow({
  label,
  accent,
}: {
  label: string;
  accent: string;
}) {
  void accent;
  return (
    <div
      role="row"
      style={{
        padding: '14px 0 4px',
      }}
    >
      <span
        role="cell"
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: QUIZ.SUBTLE,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          lineHeight: 1.2,
        }}
      >
        {label}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

const ARCH_LABEL: Record<'upper' | 'lower' | 'both', string> = {
  upper: 'Upper',
  lower: 'Lower',
  both: 'Both arches',
};

function groupRepairsByArch(
  items: ReadonlyArray<RepairLine>,
): Map<'upper' | 'lower' | 'both', RepairLine[]> {
  const byArch = new Map<'upper' | 'lower' | 'both', RepairLine[]>();
  for (const line of items) {
    const list = byArch.get(line.arch) ?? [];
    list.push(line);
    byArch.set(line.arch, list);
  }
  return byArch;
}

export function formatSlotLong(iso: string): string {
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
