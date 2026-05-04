import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { theme } from '../../theme/index.ts';
import type { BookingStateApi } from '../state.ts';
import { formatPrice } from '../state.ts';
import { env } from '../../lib/env.ts';
import { supabase } from '../../lib/supabase.ts';

// Payment step.
//
// Conditional: only appears when the chosen service has
// `depositPence > 0`. Free services skip straight from Details to
// the confirmation.
//
// Two-stage flow:
//
//   1. On mount, POST to widget-create-payment-intent with the
//      service + axes + email. The endpoint resolves the deposit
//      amount server-side (never trust the client) and creates a
//      Stripe PaymentIntent with receipt_email set so Stripe
//      auto-emails the receipt.
//
//   2. Render Stripe's PaymentElement against the returned
//      clientSecret. The element handles card / Apple Pay / Google
//      Pay / wallets automatically based on the Stripe dashboard
//      config. Pay button calls stripe.confirmPayment with
//      redirect: 'if_required' (most cards stay in-page; 3DS-
//      required cards bounce out and back).
//
//   3. On confirmation success, the wrapped onPaid handler hands
//      paymentIntent.id back to the widget shell, which calls
//      widget-create-appointment with paymentIntentId. That edge
//      function re-verifies the PI with Stripe before populating
//      deposit_* fields on the appointment row.

// Lazy-loaded once at module level, per Stripe's recommendation.
// loadStripe returns a singleton promise the Elements provider
// awaits. If VITE_STRIPE_PUBLISHABLE_KEY isn't configured the step
// renders a helpful warning instead of the form.
const stripePromise: Promise<Stripe | null> | null = env.STRIPE_PUBLISHABLE_KEY
  ? loadStripe(env.STRIPE_PUBLISHABLE_KEY)
  : null;

export function PaymentStep({
  api,
  onPaid,
  submitting,
}: {
  api: BookingStateApi;
  /** Fired once Stripe confirms the PaymentIntent succeeded. The
   *  widget shell takes the id and calls widget-create-appointment
   *  to actually persist the booking. */
  onPaid: (paymentIntentId: string) => void;
  /** True while widget-create-appointment is running (the post-pay
   *  step). Keeps the Pay button disabled so a double-tap doesn't
   *  re-confirm. */
  submitting: boolean;
}) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch clientSecret on mount + whenever the booking inputs that
  // affect the deposit change. Stripe's idempotency key is keyed on
  // (email + slot + service + axes) server-side, so re-running this
  // for the same booking returns the same PI.
  const locationId = api.state.location?.id;
  const serviceType = api.state.service?.serviceType;
  const slotIso = api.state.slotIso;
  const email = api.state.details.email.toLowerCase().trim();
  const repairVariant = api.state.axes.repair_variant ?? null;
  const productKey = api.state.axes.product_key ?? null;
  const arch = api.state.axes.arch ?? null;
  useEffect(() => {
    if (!locationId || !serviceType || !slotIso || !email) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      const { data, error: invokeErr } = await supabase.functions.invoke<{
        clientSecret?: string;
        depositPence?: number;
        error?: string;
      }>('widget-create-payment-intent', {
        body: {
          locationId,
          serviceType,
          startAt: slotIso,
          email,
          repairVariant,
          productKey,
          arch,
        },
      });
      if (cancelled) return;
      if (invokeErr || !data?.clientSecret) {
        setError("Couldn't initialise payment. Refresh the page and try again.");
        setLoading(false);
        return;
      }
      setClientSecret(data.clientSecret);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [locationId, serviceType, slotIso, email, repairVariant, productKey, arch]);

  const deposit = api.state.service?.depositPence ?? 0;

  if (!stripePromise) {
    return (
      <Card>
        <p style={{ margin: 0, color: theme.color.alert, fontSize: theme.type.size.sm }}>
          Payment isn't configured for this site (missing Stripe key). Please contact the
          clinic to complete your booking.
        </p>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <p
          style={{
            margin: 0,
            color: theme.color.alert,
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
          }}
        >
          {error}
        </p>
      </Card>
    );
  }

  if (loading || !clientSecret) {
    return (
      <Card>
        <p
          style={{
            margin: 0,
            color: theme.color.inkMuted,
            fontSize: theme.type.size.sm,
          }}
        >
          Preparing payment…
        </p>
      </Card>
    );
  }

  return (
    <Elements
      stripe={stripePromise}
      options={{
        clientSecret,
        // Heavy customisation so the Stripe form reads as part of
        // the widget rather than a third-party drop-in. theme:
        // 'flat' strips Stripe's defaults; we then rebuild every
        // affordance with our own tokens.
        appearance: {
          theme: 'flat',
          variables: {
            fontFamily: theme.type.family,
            fontSizeBase: '15px',
            fontLineHeight: '1.4',
            fontWeightNormal: '400',
            fontWeightMedium: '500',
            fontWeightBold: '600',

            colorPrimary: theme.color.accent,
            colorBackground: theme.color.surface,
            colorText: theme.color.ink,
            colorDanger: theme.color.alert,
            colorSuccess: theme.color.accent,
            colorTextSecondary: 'rgba(14, 20, 20, 0.6)',
            colorTextPlaceholder: 'rgba(14, 20, 20, 0.4)',
            colorIconTab: theme.color.ink,
            colorIconTabSelected: theme.color.accent,

            spacingUnit: '4px',
            gridColumnSpacing: '12px',
            gridRowSpacing: '14px',

            borderRadius: '12px',
            focusBoxShadow: '0 0 0 3px rgba(31, 77, 58, 0.18)',
            focusOutline: '0',
          },
          rules: {
            '.Tab': {
              padding: '14px 12px',
              border: '1px solid rgba(14, 20, 20, 0.08)',
              boxShadow: '0 1px 2px rgba(14, 20, 20, 0.04)',
              backgroundColor: '#FFFFFF',
              transition: 'border-color 120ms ease, transform 120ms ease',
            },
            '.Tab:hover': {
              borderColor: theme.color.ink,
            },
            '.Tab--selected': {
              borderColor: theme.color.accent,
              backgroundColor: theme.color.accentBg,
              boxShadow: '0 1px 2px rgba(14, 20, 20, 0.04)',
            },
            '.Tab--selected:focus': {
              borderColor: theme.color.accent,
              boxShadow: '0 0 0 3px rgba(31, 77, 58, 0.18)',
            },
            '.TabLabel': {
              fontWeight: '600',
              letterSpacing: '-0.005em',
            },
            '.TabIcon--selected': {
              fill: theme.color.accent,
            },
            '.Input': {
              padding: '12px 14px',
              border: '1px solid rgba(14, 20, 20, 0.08)',
              backgroundColor: '#FFFFFF',
              fontSize: '15px',
              transition: 'border-color 120ms ease, box-shadow 120ms ease',
            },
            '.Input:focus': {
              borderColor: theme.color.ink,
              boxShadow: 'none',
            },
            '.Input--invalid': {
              borderColor: theme.color.alert,
              boxShadow: 'none',
            },
            '.Label': {
              // Eyebrow treatment so the form's field labels read
              // as the same kind of small caps that head every
              // other section of the widget (booking summary
              // tile, manage page card, etc).
              color: 'rgba(14, 20, 20, 0.6)',
              fontWeight: '600',
              fontSize: '11px',
              marginBottom: '6px',
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
            },
            '.Error': {
              color: theme.color.alert,
              fontSize: '12px',
              fontWeight: '600',
              marginTop: '6px',
            },
            '.Block': {
              border: '1px solid rgba(14, 20, 20, 0.08)',
              backgroundColor: '#FFFFFF',
              boxShadow: '0 1px 2px rgba(14, 20, 20, 0.04)',
            },
            '.AccordionItem': {
              border: '1px solid rgba(14, 20, 20, 0.08)',
              backgroundColor: '#FFFFFF',
              boxShadow: '0 1px 2px rgba(14, 20, 20, 0.04)',
              padding: '14px 16px',
            },
            '.AccordionItem--selected': {
              borderColor: theme.color.accent,
              backgroundColor: theme.color.accentBg,
            },
            '.PickerItem': {
              border: '1px solid rgba(14, 20, 20, 0.08)',
              backgroundColor: '#FFFFFF',
              boxShadow: 'none',
            },
            '.PickerItem--selected': {
              borderColor: theme.color.accent,
              backgroundColor: theme.color.accentBg,
            },
            '.CheckboxInput--checked': {
              backgroundColor: theme.color.accent,
              borderColor: theme.color.accent,
            },
            '.MenuIcon': {
              fill: 'rgba(14, 20, 20, 0.6)',
            },
            '.MenuAction': {
              color: theme.color.accent,
              fontWeight: '600',
            },
          },
        },
      }}
    >
      <PaymentForm onPaid={onPaid} submitting={submitting} deposit={deposit} />
    </Elements>
  );
}

function PaymentForm({
  onPaid,
  submitting,
  deposit,
}: {
  onPaid: (paymentIntentId: string) => void;
  submitting: boolean;
  deposit: number;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [payError, setPayError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const ready = Boolean(stripe && elements);
  const disabled = !ready || paying || submitting;

  const onPay = async () => {
    if (!stripe || !elements) return;
    setPayError(null);
    setPaying(true);
    const result = await stripe.confirmPayment({
      elements,
      redirect: 'if_required',
      confirmParams: {
        // 3DS-required cards will bounce here. We don't try to
        // resume mid-flow — the patient lands back on the page and
        // can re-enter the booking. v2 of the widget can persist
        // step state in URL params if 3DS is common.
        return_url: window.location.href,
      },
    });
    if (result.error) {
      setPayError(result.error.message ?? 'Payment failed. Please try a different card.');
      setPaying(false);
      return;
    }
    const pi = result.paymentIntent;
    if (pi && pi.status === 'succeeded') {
      // Hand off to the widget shell. Reset our local paying flag
      // immediately — the parent's `submitting` prop takes over
      // as the disable signal during widget-create-appointment.
      // If that call fails the shell flips submitting back to
      // false and surfaces an error banner; the patient can then
      // hit Pay again with paying already cleared.
      onPaid(pi.id);
      setPaying(false);
    } else {
      setPayError('Payment did not complete.');
      setPaying(false);
    }
  };

  return (
    <Card>
      <Section
        eyebrow="How would you like to pay?"
        heading="Choose a payment method"
        description="Apple Pay and Google Pay appear automatically on supported devices."
      >
        <PaymentElement
          options={{
            layout: 'tabs',
            paymentMethodOrder: ['card', 'apple_pay', 'google_pay'],
            fields: {
              billingDetails: {
                address: {
                  country: 'never',
                  postalCode: 'auto',
                },
              },
            },
          }}
        />
      </Section>

      {payError ? (
        <p
          role="alert"
          style={{
            margin: 0,
            padding: `${theme.space[3]}px ${theme.space[4]}px`,
            background: 'rgba(184, 58, 42, 0.08)',
            border: `1px solid ${theme.color.alert}`,
            borderRadius: theme.radius.input,
            color: theme.color.alert,
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
          }}
        >
          {payError}
        </p>
      ) : null}

      <button
        type="button"
        onClick={onPay}
        disabled={disabled}
        style={{
          marginTop: theme.space[4],
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
          width: '100%',
        }}
      >
        <Lock size={14} aria-hidden />{' '}
        {paying || submitting ? 'Processing…' : `Pay ${formatPrice(deposit)}`}
      </button>

      <p
        style={{
          margin: `${theme.space[2]}px 0 0`,
          fontSize: 11,
          color: theme.color.inkSubtle,
          textAlign: 'center',
          lineHeight: theme.type.leading.snug,
          fontWeight: theme.type.weight.semibold,
          textTransform: 'uppercase',
          letterSpacing: theme.type.tracking.wide,
        }}
      >
        Secured by Stripe · We never see your card number
      </p>
    </Card>
  );
}

function Section({
  eyebrow,
  heading,
  description,
  children,
}: {
  eyebrow?: string;
  heading: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
      <div>
        {eyebrow ? (
          <p
            style={{
              margin: 0,
              fontSize: 11,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.inkMuted,
              textTransform: 'uppercase',
              letterSpacing: theme.type.tracking.wide,
              marginBottom: theme.space[1],
            }}
          >
            {eyebrow}
          </p>
        ) : null}
        <h2
          style={{
            margin: 0,
            fontSize: theme.type.size.md,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          {heading}
        </h2>
        {description ? (
          <p
            style={{
              margin: `${theme.space[1]}px 0 0`,
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
              lineHeight: theme.type.leading.snug,
            }}
          >
            {description}
          </p>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: theme.color.surface,
        border: `1px solid ${theme.color.border}`,
        borderRadius: theme.radius.card,
        padding: theme.space[5],
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[3],
        boxShadow: theme.shadow.card,
      }}
    >
      {children}
    </div>
  );
}
