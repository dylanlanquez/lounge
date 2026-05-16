import { MapPin, BadgeCheck, Calendar, Check, CheckCircle2 } from 'lucide-react';
import type { BookingStateApi, RepairLine, WidgetState } from './state.ts';
import { customerRepairLabel, formatPrice } from './state.ts';
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
  // we produce a natural-language description like "Same-day upper
  // retainer" / "Upper click-in veneers" instead of the previous
  // comma-joined backend jargon "Same-day appliance, Retainer, Upper".
  const serviceLine = state.service
    ? isRepair
      ? state.service.label.replace(/<[^>]*>/g, '').trim()
      : formatSummaryServiceLine(state)
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
        /** Optional leading icon. Pass null on rows that shouldn't
         *  carry one (e.g. the service line). The icon column space
         *  is reserved either way so titles still align across the
         *  row stack. */
        icon: React.ReactNode | null;
        title: string;
        subtitle?: string;
        rightAmount?: string;
        rightAmountColour?: string;
      }
    | {
        // Sub-row used under a subheader (per-arch repair lines,
        // upgrade lines). Leading icon is small and tinted to match
        // its section semantic — tick-style for repair lines, sparkle
        // for upgrades. The icon column is narrower than the top-row
        // icon column so the rows still feel "indented" under the
        // section heading without losing their visual cue.
        kind: 'extra';
        key: string;
        icon: React.ReactNode;
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
      // Optical centring: see ICON_OPTICAL_OFFSETS rationale below
      // ItemRow. MapPin's bulb (the visual mass) sits at viewBox y=10
      // while the icon's geometric centre is y=12 — so when the icon
      // is rendered with its geometric centre at the badge centre, the
      // bulb floats 2 viewBox units (1.5 CSS px at size=18) above the
      // badge centre line. translateY(1.5px) drops the icon so the
      // bulb lands on the badge centre, which is where the eye reads
      // the icon's position from.
      icon: (
        <MapPin
          size={18}
          strokeWidth={2}
          aria-hidden
          style={{ transform: 'translateY(1.5px)' }}
        />
      ),
      title: state.location.name,
      subtitle: state.location.addressLine,
    });
  }
  // Date / time row sits above the service line so the patient
  // reads the booking chronologically: "where, when, what". Dylan
  // moved this above the service line because the previous order
  // (service first) left the date floating between service and
  // upgrades and made the receipt harder to scan top-to-bottom.
  if (state.slotIso) {
    rows.push({
      kind: 'item',
      key: 'slot',
      // Optical centring: Calendar's main rect (the dominant visual
      // mass) is x=3 y=4 w=18 h=18 → its centre is at viewBox y=13,
      // one unit below the icon's geometric centre y=12. The two
      // binding tabs at y=2-6 are thin and add negligible mass, so
      // the rect's centre is effectively the visual centre. With no
      // correction the rect floats below the badge centre; the eye
      // reads the icon as sitting low. translateY(-0.75px) lifts the
      // icon by 1 viewBox unit (0.75 CSS px at size=18) so the rect
      // centre lands on the badge centre.
      icon: (
        <Calendar
          size={18}
          strokeWidth={2}
          aria-hidden
          style={{ transform: 'translateY(-0.75px)' }}
        />
      ),
      title: formatSlotLong(state.slotIso),
    });
  }
  // Denture-repair skips the type-only service row entirely — the
  // per-arch breakdown rendered below carries the booking story by
  // itself, and a bare "Denture Repair" header was reading as
  // redundant noise above the same information. Every other service
  // (retainers, click-in veneers, etc.) still surfaces its service
  // row so the patient sees what they booked.
  // CheckCircle2 (clean circle outline + tick inside) ties the
  // service row into the booking-confirmation theme without
  // shouting the way the previous Award (ribbon / medal) glyph
  // did. Sits in the same accent navy the location pin + calendar
  // use so the icon column reads as one cohesive column rather
  // than a parade of different shapes.
  if (state.service && serviceLine && !isRepair) {
    rows.push({
      kind: 'item',
      key: 'service',
      icon: <CheckCircle2 size={18} strokeWidth={2} aria-hidden />,
      title: serviceLine,
      rightAmount:
        priceBreakdown.serviceLinePence > 0
          ? formatPrice(priceBreakdown.serviceLinePence)
          : undefined,
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
          icon: <BadgeCheck size={16} aria-hidden style={{ color: accent }} />,
          title: `${customerRepairLabel(line.name)}${qtySuffix}`,
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
        // Plain accent check — matches the visual register of the
        // repair-row checks and the staff app's "you picked this"
        // pattern. The lavender Sparkles read as a decorative
        // marketing flourish next to the rest of the summary card's
        // calm accent column.
        icon: <Check size={16} strokeWidth={2.5} aria-hidden style={{ color: accent }} />,
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
              icon={row.icon}
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
//
// ICON_OPTICAL_OFFSETS — why MapPin and Calendar carry translateY
// corrections inline at their declaration sites above.
//
// Lucide normalises icons to their viewBox's GEOMETRIC centre, not
// their visual-mass centre. For symmetric glyphs (CheckCircle2: a
// circle inside a circle) the two coincide and no correction is
// needed. For asymmetric glyphs the geometric centre and the
// visual-mass centre diverge, and aligning by the geometric centre
// leaves the icon visibly off — the eye reads the icon's POSITION
// from where its mass is, not from where its bounding box is.
//
// Per-icon analysis (24x24 viewBox, strokeWidth 2):
//   • MapPin       — bulb + inner circle sit at viewBox y=7-13
//                    (mass centre ≈ y=10), tail tapers to a point
//                    at y=22. Geometric centre is y=12.
//                    Offset: +2 viewBox units (push DOWN).
//   • Calendar     — body rect spans y=4-22 (centre y=13), binding
//                    tabs at y=2-6 are thin and add no mass.
//                    Geometric centre is y=12.
//                    Offset: -1 viewBox unit (push UP).
//   • CheckCircle2 — outer circle is concentric with viewBox.
//                    No correction.
//
// Conversion to CSS px scales with the rendered icon size:
//   shift_css_px = (viewBox_offset * icon_size) / 24
// All icons in this card render at size=18, so:
//   MapPin   = +2 * 18/24 = +1.5px
//   Calendar = -1 * 18/24 = -0.75px
//
// This precise calibration is what differs from commit 4758a42
// (reverted in 7e578b2). 4758a42 used ±2 CSS px at icon size=16,
// which converts to ±3 viewBox units — over-correcting both icons,
// especially Calendar (correct value is -1 viewBox unit, not -3).
// The over-shift made the bounding-box padding read as visibly
// asymmetric, which Dylan called out as worse than the original.
// Smaller, mathematically-derived corrections sit far below the
// bounding-box-asymmetry threshold while still landing each glyph's
// visual centre on the badge centre — the same principle Material
// Symbols, IBM Carbon, and Atlassian Design System apply to their
// own icon sets.

function ItemRow({
  icon,
  title,
  subtitle,
  rightAmount,
  rightAmountColour,
  isLast,
}: {
  /** Pass null to reserve the icon-column space without rendering
   *  anything in it. Used by the service row, which is intentionally
   *  iconless — title still aligns with the iconed location / date
   *  rows above. */
  icon: React.ReactNode | null;
  title: string;
  subtitle?: string;
  rightAmount?: string;
  rightAmountColour?: string;
  isLast: boolean;
}) {
  // The badge MUST sit on the same horizontal line as the title — on
  // every row, regardless of whether the row carries a subtitle. The
  // previous structure ran badge + (title + subtitle) through one
  // alignItems:center flex row, which lands the badge mid-stack on
  // 2-line rows (Location: name + address) so the icon visually
  // floats between the two lines instead of pairing with the title.
  //
  // Structure now:
  //   outer       — block wrapper, padding + hairline only.
  //   title-line  — flex row, alignItems: center. Holds the badge
  //                 next to the title (+ optional rightAmount). With
  //                 only the title in this line, the badge centres
  //                 on the title's line-box, never drifts.
  //   subtitle    — sibling block under the title-line, indented by
  //                 badge width + gap so it hangs under the title's
  //                 left edge, not under the badge.
  const BADGE_SIZE = 30;
  const BADGE_GAP = 12;
  return (
    <div
      style={{
        padding: '13px 0',
        borderBottom: isLast ? 'none' : `1px solid #e9ecef`,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: BADGE_GAP,
        }}
      >
        <span
          aria-hidden
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: BADGE_SIZE,
            height: BADGE_SIZE,
            flexShrink: 0,
            borderRadius: '50%',
            background: 'rgba(8, 55, 88, 0.08)',
            color: QUIZ.ACCENT,
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
            // alignItems: 'baseline' pins title and amount to the same
            // text baseline. Centre alignment lets descenders ("p", "y"
            // in "Same-day upper retainer") push the title's line-box
            // centre below the amount's, which reads as a vertical
            // wobble even though both sit on the same row.
            alignItems: 'baseline',
            gap: 12,
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: 15,
              fontWeight: 600,
              color: QUIZ.INK,
              lineHeight: 1.2,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {title}
          </p>
          {rightAmount ? (
            <span
              style={{
                fontSize: 14,
                fontWeight: 600,
                lineHeight: 1.2,
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
      {subtitle ? (
        // <div> rather than <p>: the typography reset force-zeros
        // <p> margin with !important (see embedHost.ts) so host
        // themes can't inject margin-top via global `p { ... }`
        // rules. Subtitles that need a non-zero top margin live in
        // a <div> to opt out of that rule.
        <div
          style={{
            marginTop: 2,
            paddingLeft: BADGE_SIZE + BADGE_GAP,
            fontSize: 13,
            color: QUIZ.SUBTLE,
            lineHeight: 1.3,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {subtitle}
        </div>
      ) : null}
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
  icon,
  title,
  rightAmount,
  rightAmountColour,
  isLast,
}: {
  icon: React.ReactNode;
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
        alignItems: 'center',
        gap: 10,
        padding: '10px 0',
        borderBottom: isLast ? 'none' : `1px solid #e9ecef`,
      }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 18,
          height: 18,
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
    </div>
  );
}

// SubheaderRow — sentence-case section heading inside the summary
// card. Used for the per-arch denture-repair groups ("Your upper
// denture") and the "Upgrades" header. Bold ink rather than the
// uppercase eyebrow style — reads as a friendly section title at
// customer-facing copy register without shouting at the patient.
// No bottom hairline; the row beneath inherits the section.
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
        padding: '14px 0 6px',
      }}
    >
      <span
        role="cell"
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: QUIZ.INK,
          letterSpacing: '-0.005em',
          lineHeight: 1.3,
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

// Customer-facing per-arch headings. Denture-repair-specific phrasing
// (the only service today that surfaces repair items in the summary
// card) — "Your upper denture" reads naturally where a bare "Upper"
// left the customer asking "upper what?". If a future service ever
// surfaces per-arch rows under this card, swap to a context-aware
// mapping that takes the service type.
const ARCH_LABEL: Record<'upper' | 'lower' | 'both', string> = {
  upper: 'Your upper denture',
  lower: 'Your lower denture',
  both: 'Your upper and lower dentures',
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

// Compose the summary card's service line in natural-language form
// (lower-case appliance, arch interpolated, "Same-day" prefix only
// where it earns its place) rather than the previous comma-joined
// backend jargon like "Same-day appliance, Retainer, Upper".
//
// Examples it produces:
//   same_day_appliance + retainer + upper   → "Same-day upper retainer"
//   same_day_appliance + retainer + both    → "Same-day upper and lower retainers"
//   same_day_appliance + night_guard + lower→ "Same-day lower night guard"
//   click_in_veneers + upper                → "Upper click-in veneers"
//   click_in_veneers + both                 → "Upper and lower click-in veneers"
//   whitening_kit (no axes)                 → "Whitening kit"
//
// For services with axes but unknown to the wording rules, falls back
// to "{Arch} {service.label.toLowerCase()}" so a new service type
// added without updating this helper still reads as a sentence
// instead of leaking the comma-joined raw axes through.
function formatSummaryServiceLine(state: WidgetState): string | null {
  const svc = state.service;
  if (!svc) return null;
  const type = svc.serviceType;
  const archKey = state.axes.arch;
  const isBoth = archKey === 'both';
  const archLower =
    archKey === 'upper'
      ? 'upper'
      : archKey === 'lower'
        ? 'lower'
        : archKey === 'both'
          ? 'upper and lower'
          : null;

  if (type === 'same_day_appliance') {
    const productKey = state.axes.product_key;
    const baseAppliance = productKey
      ? (SUMMARY_APPLIANCE_LOWER[productKey] ?? 'appliance')
      : 'appliance';
    const appliance = isBoth
      ? pluraliseLowerApplianceForBoth(baseAppliance)
      : baseAppliance;
    const parts = ['Same-day'];
    if (archLower) parts.push(archLower);
    parts.push(appliance);
    return parts.join(' ');
  }

  if (type === 'click_in_veneers') {
    const parts: string[] = [];
    if (archLower) parts.push(capitaliseFirst(archLower));
    parts.push('click-in veneers');
    return parts.join(' ');
  }

  // Fallback for services without bespoke wording — strip HTML from
  // the configured display_label and prefix arch when set. This
  // keeps a new service type added to lng_widget_booking_types
  // readable even before this helper learns about it.
  const cleanLabel = svc.label.replace(/<[^>]*>/g, '').trim();
  if (archLower) {
    return `${capitaliseFirst(archLower)} ${cleanLabel.toLowerCase()}`;
  }
  return cleanLabel;
}

// Capitalise only the first letter, leaving the rest intact ("upper
// and lower" → "Upper and lower"). The `&` rendering you might want
// on a hero stays the responsibility of the hero formatter — here
// the running-prose form ("upper and lower") fits the summary card's
// inline copy register better.
function capitaliseFirst(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Lowercase appliance nouns for the summary card running prose.
// Differs from APPLIANCE_TITLE in state.ts (which is Title Case for
// headlines) — kept local so the wording surfaces can diverge
// without one having to chase the other.
const SUMMARY_APPLIANCE_LOWER: Record<string, string> = {
  retainer: 'retainer',
  night_guard: 'night guard',
  day_guard: 'day guard',
  click_in_veneers: 'click-in veneers',
  missing_tooth: 'missing-tooth appliance',
  aligner: 'replacement aligner',
  whitening_tray: 'whitening tray',
  whitening_kit: 'whitening kit',
};

// Pluralise the lower-case appliance noun for both-arches bookings.
// Same rule the success-screen helper uses: catalogue labels stored
// as singular get a +s suffix; words already ending in 's' (e.g.
// "click-in veneers") pass through untouched.
function pluraliseLowerApplianceForBoth(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length === 0) return trimmed;
  if (trimmed.endsWith('s')) return trimmed;
  return `${trimmed}s`;
}
