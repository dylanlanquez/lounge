import { useEffect } from 'react';
import { CreditCard, Wallet } from 'lucide-react';
import type { BookingStateApi, WidgetState } from './state.ts';
import { formatPriceShort } from './state.ts';
import { QUIZ } from './quizTokens.ts';

// PaymentChoiceCard — in-form selector for how the customer wants
// to pay. Replaces the old "two pill buttons crammed into the
// sticky footer" pattern (Pay £X now / Pay on the day) which got
// squashed on narrow viewports. The customer now picks the option
// inside the form; the footer carries one context-aware Next that
// either walks into the Stripe step or submits directly.
//
// Renders nothing when:
//   • the booking is free (no payment choice to make)
//   • only one option is enabled (a single-option choice is
//     already implicit — the footer's Next button knows what to do)
//
// Auto-selects a sensible default on mount (deposit > pay-in-full >
// pay-on-the-day) so a customer who doesn't actively pick still
// has a valid choice when they hit Next. Matches Stripe's checkout
// pattern of pre-selected payment methods.

export function PaymentChoiceCard({
  api,
  accent = QUIZ.ACCENT,
}: {
  api: BookingStateApi;
  accent?: string;
}) {
  const options = enabledPaymentOptions(api.state, api.priceBreakdown);

  // Default pre-selection: when paymentChoice is still null on a
  // paid service with at least one enabled option, pick the first
  // in priority order (deposit > full > otd). Fires once per option-
  // set change so reshuffling the available options (e.g. price
  // resolves on a slow network) seeds a fresh default.
  const firstOptionId = options[0]?.id ?? null;
  const currentChoice = api.state.paymentChoice;
  useEffect(() => {
    if (!firstOptionId) return;
    if (currentChoice) return;
    api.choosePayment(firstOptionId);
  }, [firstOptionId, currentChoice, api]);

  if (options.length <= 1) return null;

  return (
    <div
      role="radiogroup"
      aria-label="Payment option"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        marginTop: 16,
      }}
    >
      <h3
        style={{
          margin: 0,
          fontSize: 15,
          fontWeight: 600,
          color: QUIZ.INK,
          letterSpacing: '-0.005em',
        }}
      >
        How would you like to pay?
      </h3>
      {options.map((opt) => (
        <PaymentOption
          key={opt.id}
          option={opt}
          selected={api.state.paymentChoice === opt.id}
          onSelect={() => api.choosePayment(opt.id)}
          accent={accent}
        />
      ))}
    </div>
  );
}

interface PaymentOption {
  id: 'pay_full' | 'pay_deposit' | 'pay_on_the_day';
  title: string;
  description: string;
  amountLabel: string;
  icon: React.ReactNode;
}

function enabledPaymentOptions(
  state: WidgetState,
  priceBreakdown: BookingStateApi['priceBreakdown'],
): PaymentOption[] {
  const svc = state.service;
  if (!svc) return [];
  const total = priceBreakdown.subtotalPence;
  if (total <= 0) return [];

  const depositPence = svc.depositPence ?? 0;
  const allowFull = svc.allowPayInFull !== false; // default TRUE
  const allowOTD = svc.allowPayOnTheDay === true;
  const showDeposit = depositPence > 0;

  const out: PaymentOption[] = [];
  // Order priority matches the legacy footer's primary picker:
  // deposit > pay-in-full > pay-on-the-day. Keeps the visual
  // anchor (Stripe step entry) at the top of the list.
  if (showDeposit) {
    const balance = Math.max(0, total - depositPence);
    out.push({
      id: 'pay_deposit',
      title: `Pay £${(depositPence / 100).toFixed(2)} deposit now`,
      description: `Pay the £${(balance / 100).toFixed(2)} balance at your appointment.`,
      amountLabel: formatPriceShort(depositPence),
      icon: <CreditCard size={18} aria-hidden />,
    });
  }
  if (allowFull) {
    out.push({
      id: 'pay_full',
      title: `Pay in full now`,
      description: showDeposit
        ? `Pay the full amount upfront, nothing on the day.`
        : `Pay now, nothing more on the day.`,
      amountLabel: formatPriceShort(total),
      icon: <CreditCard size={18} aria-hidden />,
    });
  }
  if (allowOTD) {
    out.push({
      id: 'pay_on_the_day',
      title: 'Pay on the day',
      description: 'Pay at the clinic when you arrive.',
      amountLabel: formatPriceShort(total),
      icon: <Wallet size={18} aria-hidden />,
    });
  }
  return out;
}

function PaymentOption({
  option,
  selected,
  onSelect,
  accent,
}: {
  option: PaymentOption;
  selected: boolean;
  onSelect: () => void;
  accent: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      style={{
        appearance: 'none',
        textAlign: 'left',
        fontFamily: 'inherit',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '14px 16px',
        background: selected ? hexWithAlpha(accent, 0.06) : QUIZ.SURFACE,
        border: `2px solid ${selected ? accent : 'transparent'}`,
        borderRadius: 12,
        transition: 'background 0.15s ease, border-color 0.15s ease',
        width: '100%',
        boxSizing: 'border-box',
      }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 36,
          height: 36,
          flexShrink: 0,
          borderRadius: '50%',
          background: selected ? accent : hexWithAlpha(accent, 0.08),
          color: selected ? '#fff' : accent,
          transition: 'background 0.15s ease, color 0.15s ease',
        }}
      >
        {option.icon}
      </span>
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: QUIZ.INK,
            lineHeight: 1.3,
            letterSpacing: '-0.005em',
          }}
        >
          {option.title}
        </span>
        <span
          style={{
            fontSize: 13,
            color: QUIZ.MUTED_2,
            lineHeight: 1.4,
          }}
        >
          {option.description}
        </span>
      </span>
      <RadioGlyph selected={selected} accent={accent} />
    </button>
  );
}

function RadioGlyph({ selected, accent }: { selected: boolean; accent: string }) {
  return (
    <span
      aria-hidden
      style={{
        flexShrink: 0,
        width: 20,
        height: 20,
        borderRadius: '50%',
        border: `2px solid ${selected ? accent : '#d2d6da'}`,
        background: '#fff',
        position: 'relative',
        transition: 'border-color 0.15s ease',
      }}
    >
      {selected ? (
        <span
          style={{
            position: 'absolute',
            inset: 3,
            borderRadius: '50%',
            background: accent,
          }}
        />
      ) : null}
    </span>
  );
}

// Mirror of the helper in steps/Success.tsx — same parse + fallback
// behaviour. Kept inline so this component is self-contained.
function hexWithAlpha(hex: string, alpha: number): string {
  let h = hex.trim();
  if (h.startsWith('#')) h = h.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h)) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
