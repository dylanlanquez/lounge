import { useState } from 'react';
import { CreditCard, HelpCircle, Lock } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import type { BookingStateApi } from '../state.ts';
import { formatPrice } from '../state.ts';

// Payment step.
//
// Conditional: only appears when the chosen service has
// `depositPence > 0`. Free services skip straight from Details to
// the confirmation.
//
// Phase 2c (current): visual stub for the card inputs, but the Pay
// button calls the real submit() handler from the widget shell —
// which posts to widget-create-appointment and creates the
// lng_appointments row. The deposit isn't actually charged yet;
// phase 4 wires Stripe and only triggers submit() once the
// PaymentIntent confirms.
//
// Phase 4 wires this to a Stripe PaymentIntent created server-
// side via a new edge function. The card inputs become
// <PaymentElement /> from @stripe/react-stripe-js. Apple/Google
// Pay come for free via PaymentRequestButton.

type PaymentMethod = 'card' | 'apple' | 'google';

export function PaymentStep({
  api,
  onSubmit,
  submitting,
}: {
  api: BookingStateApi;
  onSubmit: () => void;
  submitting: boolean;
}) {
  const [method, setMethod] = useState<PaymentMethod>('card');
  const [cardNumber, setCardNumber] = useState('');
  const [expiry, setExpiry] = useState('');
  const [cvc, setCvc] = useState('');

  const deposit = api.state.service?.depositPence ?? 0;
  const inputsBlock = method === 'card' && (!cardNumber || !expiry || !cvc);
  const disabled = submitting || inputsBlock;

  return (
    <div
      style={{
        background: theme.color.surface,
        border: `1px solid ${theme.color.border}`,
        borderRadius: theme.radius.card,
        padding: theme.space[5],
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[4],
        boxShadow: theme.shadow.card,
      }}
    >
      <MethodPicker active={method} onChange={setMethod} />

      {method === 'card' ? (
        <>
          <div>
            <Label>Card number</Label>
            <div style={{ position: 'relative' }}>
              <input
                value={cardNumber}
                onChange={(e) => setCardNumber(e.target.value)}
                placeholder="1234 1234 1234 1234"
                inputMode="numeric"
                style={inputStyle}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = theme.color.ink;
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = theme.color.border;
                }}
              />
              <span
                style={{
                  position: 'absolute',
                  right: theme.space[3],
                  top: '50%',
                  transform: 'translateY(-50%)',
                  fontSize: 11,
                  color: theme.color.inkSubtle,
                  fontWeight: theme.type.weight.semibold,
                  letterSpacing: theme.type.tracking.wide,
                  textTransform: 'uppercase',
                }}
              >
                VISA · MC · AMEX
              </span>
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: theme.space[3],
            }}
          >
            <div>
              <Label>Expiry</Label>
              <CardInputWithHint
                value={expiry}
                onChange={setExpiry}
                placeholder="MM / YY"
                hint="The expiry date on the front of your card."
              />
            </div>
            <div>
              <Label>CVC</Label>
              <CardInputWithHint
                value={cvc}
                onChange={setCvc}
                placeholder="123"
                hint="The 3-digit code on the back of your card."
              />
            </div>
          </div>
        </>
      ) : (
        <div
          style={{
            padding: theme.space[5],
            background: theme.color.bg,
            borderRadius: theme.radius.input,
            border: `1px dashed ${theme.color.border}`,
            textAlign: 'center',
            color: theme.color.inkMuted,
            fontSize: theme.type.size.sm,
            lineHeight: theme.type.leading.snug,
          }}
        >
          {method === 'apple' ? (
            <>Tap Pay to bring up Apple Pay.</>
          ) : (
            <>Tap Pay to bring up Google Pay.</>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={onSubmit}
        disabled={disabled}
        style={{
          appearance: 'none',
          border: 'none',
          background: theme.color.ink,
          color: theme.color.surface,
          height: 52,
          borderRadius: theme.radius.pill,
          fontFamily: 'inherit',
          fontSize: theme.type.size.md,
          fontWeight: theme.type.weight.semibold,
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: theme.space[2],
        }}
      >
        <Lock size={14} aria-hidden /> {submitting ? 'Booking…' : `Pay ${formatPrice(deposit)}`}
      </button>

      <p
        style={{
          margin: 0,
          fontSize: theme.type.size.xs,
          color: theme.color.inkMuted,
          textAlign: 'center',
          lineHeight: theme.type.leading.snug,
        }}
      >
        Payments handled by Stripe. We never see or store your card number.
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Method picker — three tabs at the top
// ─────────────────────────────────────────────────────────────────────────────

function MethodPicker({
  active,
  onChange,
}: {
  active: PaymentMethod;
  onChange: (m: PaymentMethod) => void;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: theme.space[2],
      }}
    >
      <MethodTab
        active={active === 'card'}
        onClick={() => onChange('card')}
        icon={<CreditCard size={18} aria-hidden />}
        label="Card"
      />
      <MethodTab
        active={active === 'apple'}
        onClick={() => onChange('apple')}
        icon={
          <span aria-hidden style={{ fontSize: 16, fontWeight: 700, lineHeight: 1 }}>

          </span>
        }
        label="Apple Pay"
      />
      <MethodTab
        active={active === 'google'}
        onClick={() => onChange('google')}
        icon={
          <span aria-hidden style={{ fontSize: 14, fontWeight: 700, lineHeight: 1 }}>
            G
          </span>
        }
        label="Google Pay"
      />
    </div>
  );
}

function MethodTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        appearance: 'none',
        border: `1px solid ${active ? theme.color.accent : theme.color.border}`,
        background: theme.color.surface,
        borderRadius: theme.radius.input,
        padding: `${theme.space[3]}px ${theme.space[3]}px`,
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: theme.type.size.sm,
        fontWeight: theme.type.weight.semibold,
        color: active ? theme.color.ink : theme.color.inkMuted,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: theme.space[2],
        boxShadow: active ? theme.shadow.card : 'none',
        transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function CardInputWithHint({
  value,
  onChange,
  placeholder,
  hint,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  hint: string;
}) {
  return (
    <div style={{ position: 'relative' }}>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode="numeric"
        style={{ ...inputStyle, paddingRight: 36 }}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = theme.color.ink;
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = theme.color.border;
        }}
      />
      <button
        type="button"
        title={hint}
        aria-label={hint}
        style={{
          position: 'absolute',
          right: 8,
          top: '50%',
          transform: 'translateY(-50%)',
          appearance: 'none',
          border: 'none',
          background: 'transparent',
          color: theme.color.inkMuted,
          cursor: 'help',
          padding: 4,
          display: 'inline-flex',
        }}
      >
        <HelpCircle size={14} />
      </button>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
        margin: 0,
        marginBottom: theme.space[1],
        fontSize: theme.type.size.sm,
        fontWeight: theme.type.weight.semibold,
        color: theme.color.ink,
      }}
    >
      {children}
    </p>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  height: 44,
  padding: `0 ${theme.space[3]}px`,
  borderRadius: theme.radius.input,
  border: `1px solid ${theme.color.border}`,
  background: theme.color.surface,
  color: theme.color.ink,
  fontFamily: 'inherit',
  fontSize: theme.type.size.base,
  outline: 'none',
  boxSizing: 'border-box',
};
