import { Calendar, MapPin, Award, ShieldCheck, Sparkles } from 'lucide-react';
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

// Booking review — appointment recap + price breakdown shown
// inside the combined Details step. Single column, no card chrome
// on this screen at all (the inputs above this carry the only
// borders). Sections are separated by 1px hairlines, not boxes.
//
// 2026 reference set: Stripe Checkout, Calendly, Apple Pay sheet.
// All four use plain typography for prices, right-aligned amounts,
// and zero card backgrounds around money. We follow that here.

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

  // The "Total" row is the full price (service + extras), before
  // splitting into deposit-today vs balance-on-the-day below.
  const total = priceBreakdown.subtotalPence;
  const deposit = priceBreakdown.depositPence;
  const onTheDay = priceBreakdown.payAtAppointmentPence;
  void copy;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 32,
        width: '100%',
      }}
    >
      {/* ── Your booking ────────────────────────────────────────── */}
      <section>
        <SectionLabel>Your booking</SectionLabel>
        <ItemList>
          {state.location ? (
            <Item
              icon={<MapPin size={16} aria-hidden style={{ color: accent }} />}
              label={state.location.name}
              sub={state.location.addressLine}
            />
          ) : null}
          {state.service ? (
            <Item
              icon={<Award size={16} aria-hidden style={{ color: accent }} />}
              label={state.service.label.replace(/<[^>]*>/g, '')}
              sub={axisChainLabel(state) ?? undefined}
            />
          ) : null}
          {state.slotIso ? (
            <Item
              icon={<Calendar size={16} aria-hidden style={{ color: accent }} />}
              label={formatSlotLong(state.slotIso)}
            />
          ) : null}
          {selectedUpgrades.map((u) => (
            <Item
              key={u.id}
              icon={<Sparkles size={16} aria-hidden style={{ color: QUIZ.LAVENDER }} />}
              label={u.name}
              right={
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: QUIZ.LAVENDER,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  +{formatPrice(upgradePrice(u.id))}
                </span>
              }
            />
          ))}
        </ItemList>
      </section>

      {/* ── Total ───────────────────────────────────────────────── */}
      <section>
        <SectionLabel>Total</SectionLabel>
        <PriceTable>
          {priceBreakdown.serviceLinePence > 0 ? (
            <PriceRow
              label="Service"
              amount={formatPrice(priceBreakdown.serviceLinePence)}
            />
          ) : null}
          {priceBreakdown.upgradesLinePence > 0 ? (
            <PriceRow
              label="Extras"
              amount={`+${formatPrice(priceBreakdown.upgradesLinePence)}`}
              amountColour={QUIZ.LAVENDER}
            />
          ) : null}
          {total > 0 ? (
            <PriceRow label="Total" amount={formatPrice(total)} emphasised />
          ) : null}
          {deposit > 0 ? (
            <PriceRow
              label="Deposit today"
              amount={formatPrice(deposit)}
            />
          ) : null}
          {onTheDay > 0 ? (
            <PriceRow
              label="Balance on the day"
              amount={formatPrice(onTheDay)}
              muted
            />
          ) : null}
        </PriceTable>
      </section>

      {/* ── Trust signals ───────────────────────────────────────── */}
      <TrustSignals accent={accent} />
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
        margin: '0 0 12px',
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

function ItemList({ children }: { children: React.ReactNode }) {
  return (
    <ul
      style={{
        listStyle: 'none',
        margin: 0,
        padding: 0,
      }}
    >
      {children}
    </ul>
  );
}

function Item({
  icon,
  label,
  sub,
  right,
}: {
  icon: React.ReactNode;
  label: string;
  sub?: string;
  right?: React.ReactNode;
}) {
  return (
    <li
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '12px 0',
        borderBottom: '1px solid rgba(0, 0, 0, 0.06)',
      }}
    >
      <span
        aria-hidden
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
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            margin: 0,
            fontSize: 15,
            fontWeight: 500,
            color: QUIZ.INK,
            lineHeight: 1.35,
          }}
        >
          {label}
        </p>
        {sub ? (
          <p
            style={{
              margin: '2px 0 0',
              fontSize: 13,
              color: QUIZ.MUTED_2,
              lineHeight: 1.4,
            }}
          >
            {sub}
          </p>
        ) : null}
      </div>
      {right ? (
        <span style={{ flexShrink: 0, marginTop: 2 }}>{right}</span>
      ) : null}
    </li>
  );
}

function PriceTable({ children }: { children: React.ReactNode }) {
  return (
    <div role="table">{children}</div>
  );
}

function PriceRow({
  label,
  amount,
  amountColour,
  emphasised = false,
  muted = false,
}: {
  label: string;
  amount: string;
  amountColour?: string;
  emphasised?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      role="row"
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        padding: emphasised ? '12px 0 10px' : '8px 0',
        borderTop: emphasised ? '1px solid rgba(0, 0, 0, 0.10)' : 'none',
        marginTop: emphasised ? 4 : 0,
        fontSize: emphasised ? 16 : 14,
        color: muted ? QUIZ.MUTED_2 : QUIZ.INK,
        opacity: muted ? 0.7 : 1,
      }}
    >
      <span role="cell">{label}</span>
      <span
        role="cell"
        style={{
          fontWeight: emphasised ? 700 : 600,
          color: amountColour ?? (muted ? QUIZ.MUTED_2 : QUIZ.INK),
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {amount}
      </span>
    </div>
  );
}

function TrustSignals({ accent }: { accent: string }) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: 20,
        paddingTop: 8,
      }}
    >
      <TrustItem
        icon={<ShieldCheck size={14} aria-hidden style={{ color: accent }} />}
        label="GDC registered"
      />
      <TrustItem
        icon={<Award size={14} aria-hidden style={{ color: accent }} />}
        label="UK lab"
      />
      <TrustItem
        icon={<ShieldCheck size={14} aria-hidden style={{ color: accent }} />}
        label="14-day warranty"
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
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        color: QUIZ.MUTED_2,
        lineHeight: 1.3,
      }}
    >
      {icon}
      {label}
    </span>
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
