import { Calendar, MapPin, Shield, Lock, Award } from 'lucide-react';
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

// Booking review — the summary card block. Previously lived as its
// own step (SummaryStep) but the customer was wading through one
// click too many. Now embedded inside DetailsStep beneath the form
// so the customer fills + reviews + commits on one screen.
//
// 2-column grid at 900px+ wraps to single column below. Left card:
// appointment-details (location, service, axes chain, time,
// selected upgrades). Right card: price breakdown + payment
// options + trust signals.

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
  const total =
    priceBreakdown.depositPence > 0
      ? priceBreakdown.depositPence
      : priceBreakdown.subtotalPence;
  const showPayLater = priceBreakdown.payAtAppointmentPence > 0;
  const archIsBoth = state.axes.arch === 'both';
  const upgradePrice = (upgradeId: string): number => {
    const u = upgrades.find((x) => x.id === upgradeId);
    if (!u) return 0;
    return archIsBoth && u.bothArchesPricePence !== null
      ? u.bothArchesPricePence
      : u.unitPricePence;
  };

  return (
    <div
      className="vlounge-stagger"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
        gap: 16,
        maxWidth: 1100,
        margin: '0 auto',
        alignItems: 'start',
      }}
    >
      {/* Left column — appointment details */}
      <SummaryCard>
        <SectionTitle accent={accent}>{copy.summaryTitle}</SectionTitle>

        {state.location ? (
          <SummaryRow
            icon={<MapPin size={16} aria-hidden style={{ color: accent }} />}
            label={state.location.name}
            sub={state.location.addressLine}
          />
        ) : null}

        {state.service ? (
          <SummaryRow
            icon={<Award size={16} aria-hidden style={{ color: accent }} />}
            label={state.service.label.replace(/<[^>]*>/g, '')}
            sub={axisChainLabel(state) ?? undefined}
          />
        ) : null}

        {state.slotIso ? (
          <SummaryRow
            icon={<Calendar size={16} aria-hidden style={{ color: accent }} />}
            label={formatSlotLong(state.slotIso)}
          />
        ) : null}

        {selectedUpgrades.length > 0 ? (
          <>
            <Divider />
            <SectionTitle accent={accent}>Optional extras</SectionTitle>
            {selectedUpgrades.map((u) => (
              <PriceRow
                key={u.id}
                label={u.name}
                amount={`+${formatPrice(upgradePrice(u.id))}`}
                amountColour={QUIZ.LAVENDER}
              />
            ))}
          </>
        ) : null}
      </SummaryCard>

      {/* Right column — price + payment + trust */}
      <SummaryCard>
        <SectionTitle accent={accent}>Total</SectionTitle>

        {priceBreakdown.serviceLinePence > 0 ? (
          <PriceRow
            label="Service"
            amount={formatPrice(priceBreakdown.serviceLinePence)}
          />
        ) : null}
        {priceBreakdown.upgradesLinePence > 0 ? (
          <PriceRow
            label="Extras"
            amount={formatPrice(priceBreakdown.upgradesLinePence)}
            amountColour={QUIZ.LAVENDER}
          />
        ) : null}

        <Divider />

        <TotalRow
          accent={accent}
          label={copy.summaryTotalLabel}
          amount={formatPrice(total)}
        />

        {showPayLater ? (
          <p
            style={{
              margin: '8px 0 0',
              fontSize: 12,
              color: QUIZ.MUTED_2,
              fontStyle: 'italic',
              textAlign: 'right',
            }}
          >
            {copy.summaryPayLaterLabel}{' '}
            {formatPrice(priceBreakdown.payAtAppointmentPence)}
          </p>
        ) : null}

        {total >= 3000 ? <PaymentOptions total={total} /> : null}

        <TrustSignals accent={accent} />
      </SummaryCard>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Building blocks
// ─────────────────────────────────────────────────────────────────

function SummaryCard({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: QUIZ.SURFACE,
        border: `2px solid ${QUIZ.BORDER}`,
        borderRadius: QUIZ.R_CARD,
        padding: 20,
        animation: `vlounge-fadeInUp 0.3s ${QUIZ.EASE_BOUNCE} backwards`,
      }}
    >
      {children}
    </div>
  );
}

function SectionTitle({
  children,
  accent,
}: {
  children: React.ReactNode;
  accent: string;
}) {
  return (
    <h3
      style={{
        margin: '0 0 14px',
        fontSize: 17,
        fontWeight: 600,
        color: accent,
        letterSpacing: '-0.01em',
      }}
    >
      {children}
    </h3>
  );
}

function SummaryRow({
  icon,
  label,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  sub?: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '10px 0',
        borderBottom: `1px solid ${QUIZ.BORDER_SOFT}`,
      }}
    >
      <span
        style={{
          flexShrink: 0,
          marginTop: 2,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {icon}
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <p
          style={{
            margin: 0,
            fontSize: 15,
            fontWeight: 600,
            color: QUIZ.INK,
            lineHeight: 1.3,
          }}
        >
          {label}
        </p>
        {sub ? (
          <p
            style={{
              margin: '4px 0 0',
              fontSize: 13,
              color: QUIZ.MUTED_2,
              lineHeight: 1.4,
            }}
          >
            {sub}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function PriceRow({
  label,
  amount,
  amountColour,
}: {
  label: string;
  amount: string;
  amountColour?: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '8px 0',
        fontSize: 14,
        color: QUIZ.INK,
      }}
    >
      <span>{label}</span>
      <span
        style={{
          fontWeight: 600,
          color: amountColour ?? QUIZ.INK,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {amount}
      </span>
    </div>
  );
}

function TotalRow({
  label,
  amount,
  accent,
}: {
  label: string;
  amount: string;
  accent: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '10px 0',
        fontSize: 18,
        fontWeight: 700,
        color: accent,
      }}
    >
      <span>{label}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{amount}</span>
    </div>
  );
}

function Divider() {
  return (
    <div
      aria-hidden
      style={{
        height: 2,
        background: QUIZ.BORDER,
        margin: '10px 0',
      }}
    />
  );
}

function PaymentOptions({ total }: { total: number }) {
  // Surface Klarna + Clearpay only when the total clears each
  // provider's typical minimum. Both providers actually accept much
  // smaller amounts than this threshold; the £30 cutoff is a UX
  // judgement to avoid showing 'Pay £1.50 / month' which reads as
  // gimmicky on a deposit.
  const klarnaPerMonth = Math.ceil(total / 3 / 100); // pence → whole £
  const clearpayPerWeek = Math.ceil(total / 4 / 100);
  return (
    <div
      style={{
        marginTop: 18,
        paddingTop: 16,
        borderTop: `2px solid ${QUIZ.BORDER_SOFT}`,
      }}
    >
      <p
        style={{
          margin: '0 0 12px',
          fontSize: 12,
          color: QUIZ.MUTED_2,
          textAlign: 'center',
        }}
      >
        Or pay over time:
      </p>
      <PaymentOption label="Klarna" detail={`3 × £${klarnaPerMonth}`} />
      <PaymentOption
        label="Clearpay"
        detail={`4 × £${clearpayPerWeek} fortnightly`}
      />
    </div>
  );
}

function PaymentOption({ label, detail }: { label: string; detail: string }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '10px 14px',
        background: QUIZ.SOFT_BG,
        border: `1px solid ${QUIZ.BORDER}`,
        borderRadius: QUIZ.R_INPUT,
        marginBottom: 8,
        fontSize: 13,
        color: QUIZ.INK,
      }}
    >
      <span style={{ fontWeight: 600 }}>{label}</span>
      <span>{detail}</span>
    </div>
  );
}

function TrustSignals({ accent }: { accent: string }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-around',
        marginTop: 18,
        paddingTop: 16,
        borderTop: `1px solid ${QUIZ.BORDER}`,
        gap: 12,
      }}
    >
      <TrustItem
        icon={<Shield size={18} aria-hidden style={{ color: accent }} />}
        label="UK GDC registered"
      />
      <TrustItem
        icon={<Lock size={18} aria-hidden style={{ color: accent }} />}
        label="Secure payments"
      />
      <TrustItem
        icon={<Award size={18} aria-hidden style={{ color: accent }} />}
        label="MHRA approved labs"
      />
    </div>
  );
}

function TrustItem({
  icon,
  label,
}: {
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        fontSize: 11,
        color: QUIZ.MUTED_2,
        textAlign: 'center',
        lineHeight: 1.3,
      }}
    >
      {icon}
      <span>{label}</span>
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
