import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import type { BookingStateApi } from '../state.ts';
import { formatPrice } from '../state.ts';
import { QUIZ } from '../quizTokens.ts';
import { env } from '../../../lib/env.ts';
import { supabase } from '../../../lib/supabase.ts';

// Payment step.
//
// Conditional: only appears when the chosen service has
// `depositPence > 0`. Free services skip straight from Details to
// the confirmation.
//
// Pay action lives in the widget's sticky FOOTER (not in this
// step) so the layout matches the rest of the form. PaymentStep
// exposes a `pay()` method via the forwarded ref so the footer
// button can trigger stripe.confirmPayment without losing the
// Elements context. Ready + paying signals flow up to the parent
// via callback props so the footer can manage its disabled state.

const stripePromise: Promise<Stripe | null> | null = env.STRIPE_PUBLISHABLE_KEY
  ? loadStripe(env.STRIPE_PUBLISHABLE_KEY)
  : null;

export interface PaymentApi {
  pay: () => Promise<void>;
}

export const PaymentStep = forwardRef<
  PaymentApi,
  {
    api: BookingStateApi;
    onPaid: (paymentIntentId: string) => void;
    submitting: boolean;
    onReadyChange?: (ready: boolean) => void;
    onPayingChange?: (paying: boolean) => void;
    onError?: (error: string | null) => void;
  }
>(function PaymentStep(
  { api, onPaid, submitting, onReadyChange, onPayingChange, onError },
  ref,
) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch clientSecret on mount + whenever the inputs that affect
  // the deposit change. Server idempotency key (email + slot +
  // service + axes) returns the same PI for the same booking.
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
    onError?.(null);
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
        const msg = "Couldn't initialise payment. Refresh the page and try again.";
        setError(msg);
        onError?.(msg);
        setLoading(false);
        return;
      }
      setClientSecret(data.clientSecret);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [locationId, serviceType, slotIso, email, repairVariant, productKey, arch, onError]);

  // While the Stripe form isn't ready yet, the parent shouldn't
  // enable the footer's Pay button.
  useEffect(() => {
    if (loading || !clientSecret) onReadyChange?.(false);
  }, [loading, clientSecret, onReadyChange]);

  // Even when the PaymentForm hasn't mounted yet we want the
  // forwarded ref to exist so the parent never gets a null call.
  // Replace it once PaymentForm registers its real pay().
  const fallbackRef = useRef<PaymentApi>({ pay: async () => {} });
  useImperativeHandle(ref, () => fallbackRef.current, []);

  const deposit = api.state.service?.depositPence ?? 0;

  if (!stripePromise) {
    return (
      <Shell maxWidth={720}>
        <p style={{ margin: 0, color: QUIZ.ALERT, fontSize: 15 }}>
          Payment isn't configured for this site. Please contact the clinic to complete
          your booking.
        </p>
      </Shell>
    );
  }

  if (error) {
    return (
      <Shell maxWidth={720}>
        <PayHeader deposit={deposit} />
        <p style={{ margin: 0, color: QUIZ.ALERT, fontSize: 14, fontWeight: 600 }}>
          {error}
        </p>
      </Shell>
    );
  }

  if (loading || !clientSecret) {
    return (
      <Shell maxWidth={720}>
        <PayHeader deposit={deposit} />
        <p style={{ margin: 0, color: QUIZ.MUTED_2, fontSize: 14 }}>Preparing payment…</p>
      </Shell>
    );
  }

  return (
    <Shell maxWidth={720}>
      <PayHeader deposit={deposit} />
      <Elements
        stripe={stripePromise}
        options={{
          clientSecret,
          appearance: {
            theme: 'flat',
            variables: {
              fontFamily: QUIZ.FONT_STACK,
              fontSizeBase: '15px',
              fontLineHeight: '1.4',
              fontWeightNormal: '500',
              fontWeightMedium: '500',
              fontWeightBold: '600',

              colorPrimary: QUIZ.ACCENT,
              colorBackground: QUIZ.SURFACE,
              colorText: QUIZ.INK,
              colorDanger: QUIZ.ALERT,
              colorSuccess: QUIZ.ACCENT,
              colorTextSecondary: 'rgba(14, 20, 20, 0.6)',
              colorTextPlaceholder: 'rgba(14, 20, 20, 0.4)',
              colorIconTab: QUIZ.INK,
              colorIconTabSelected: QUIZ.ACCENT,

              spacingUnit: '4px',
              gridColumnSpacing: '12px',
              gridRowSpacing: '14px',

              borderRadius: '8px',
              focusBoxShadow: 'none',
              focusOutline: '0',
            },
            rules: {
              '.Tab': {
                padding: '14px 12px',
                border: '2px solid rgba(14, 20, 20, 0.08)',
                boxShadow: 'none',
                backgroundColor: '#FFFFFF',
                transition: 'border-color 120ms ease, transform 120ms ease',
              },
              '.Tab:hover': {
                borderColor: QUIZ.ACCENT,
              },
              '.Tab--selected': {
                borderColor: QUIZ.ACCENT,
                backgroundColor: 'rgba(8, 55, 88, 0.05)',
                color: QUIZ.INK,
              },
              '.Tab--selected:focus': {
                borderColor: QUIZ.ACCENT,
                color: QUIZ.INK,
              },
              '.Tab--selected:hover': {
                color: QUIZ.INK,
              },
              '.TabLabel': {
                fontWeight: '600',
              },
              '.TabIcon--selected': {
                fill: QUIZ.ACCENT,
              },
              '.Input': {
                padding: '12px 14px',
                border: '2px solid rgba(14, 20, 20, 0.10)',
                backgroundColor: '#FFFFFF',
                fontSize: '15px',
                transition: 'border-color 120ms ease',
              },
              '.Input:focus': {
                borderColor: QUIZ.ACCENT,
                boxShadow: 'none',
              },
              '.Input--invalid': {
                borderColor: QUIZ.ALERT,
                boxShadow: 'none',
              },
              '.Label': {
                color: QUIZ.INK,
                fontWeight: '600',
                fontSize: '15px',
                marginBottom: '8px',
              },
              '.Error': {
                color: QUIZ.ALERT,
                fontSize: '13px',
                fontWeight: '600',
                marginTop: '6px',
              },
              '.Block': {
                border: '2px solid rgba(14, 20, 20, 0.08)',
                backgroundColor: '#FFFFFF',
                boxShadow: 'none',
              },
              '.AccordionItem': {
                border: '2px solid rgba(14, 20, 20, 0.08)',
                backgroundColor: '#FFFFFF',
                boxShadow: 'none',
                padding: '14px 16px',
              },
              '.AccordionItem--selected': {
                borderColor: QUIZ.ACCENT,
                backgroundColor: 'rgba(8, 55, 88, 0.05)',
              },
              '.PickerItem': {
                border: '2px solid rgba(14, 20, 20, 0.08)',
                backgroundColor: '#FFFFFF',
                boxShadow: 'none',
              },
              '.PickerItem--selected': {
                borderColor: QUIZ.ACCENT,
                backgroundColor: 'rgba(8, 55, 88, 0.05)',
              },
              '.CheckboxInput--checked': {
                backgroundColor: QUIZ.ACCENT,
                borderColor: QUIZ.ACCENT,
              },
              '.MenuIcon': {
                fill: 'rgba(14, 20, 20, 0.6)',
              },
              '.MenuAction': {
                color: QUIZ.ACCENT,
                fontWeight: '600',
              },
            },
          },
        }}
      >
        <PaymentForm
          apiRef={fallbackRef}
          onPaid={onPaid}
          submitting={submitting}
          onReadyChange={onReadyChange}
          onPayingChange={onPayingChange}
          onError={onError}
          billingDetails={{
            name: [api.state.details.firstName, api.state.details.lastName]
              .map((s) => s.trim())
              .filter(Boolean)
              .join(' '),
            email: api.state.details.email,
            country: api.state.details.phoneCountry || 'GB',
          }}
        />
      </Elements>
    </Shell>
  );
});

interface BillingDetails {
  name: string;
  email: string;
  country: string;
}

function PaymentForm({
  apiRef,
  onPaid,
  submitting,
  onReadyChange,
  onPayingChange,
  onError,
  billingDetails,
}: {
  apiRef: React.MutableRefObject<PaymentApi>;
  onPaid: (paymentIntentId: string) => void;
  submitting: boolean;
  onReadyChange?: (ready: boolean) => void;
  onPayingChange?: (paying: boolean) => void;
  onError?: (error: string | null) => void;
  billingDetails: BillingDetails;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [payError, setPayError] = useState<string | null>(null);
  const [elementReady, setElementReady] = useState(false);
  void submitting;

  // Bubble Stripe-iframe readiness up to the parent so the footer's
  // Pay button stays disabled until the patient can actually type.
  useEffect(() => {
    onReadyChange?.(Boolean(stripe && elements && elementReady));
  }, [stripe, elements, elementReady, onReadyChange]);

  // Imperatively pay() from the parent footer. Updates `paying`
  // state via callback so the footer can flip its label and
  // disable itself during stripe.confirmPayment.
  apiRef.current = {
    pay: async () => {
      if (!stripe || !elements) return;
      setPayError(null);
      onError?.(null);
      onPayingChange?.(true);
      try {
        const result = await stripe.confirmPayment({
          elements,
          redirect: 'if_required',
          confirmParams: {
            return_url: window.location.href,
            payment_method_data: {
              billing_details: {
                name: billingDetails.name || undefined,
                email: billingDetails.email || undefined,
                address: {
                  country: billingDetails.country,
                },
              },
            },
          },
        });
        if (result.error) {
          const msg = result.error.message ?? 'Payment failed. Please try a different card.';
          setPayError(msg);
          onError?.(msg);
          return;
        }
        const pi = result.paymentIntent;
        if (pi && pi.status === 'succeeded') {
          onPaid(pi.id);
        } else {
          const msg = 'Payment did not complete.';
          setPayError(msg);
          onError?.(msg);
        }
      } finally {
        onPayingChange?.(false);
      }
    },
  };

  return (
    <>
      {!elementReady ? (
        <p style={{ margin: 0, color: QUIZ.MUTED_2, fontSize: 14 }}>Preparing payment…</p>
      ) : null}
      <div style={{ display: elementReady ? 'block' : 'none' }}>
        <PaymentElement
          onReady={() => setElementReady(true)}
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
      </div>

      {payError && elementReady ? (
        <p
          role="alert"
          style={{
            margin: 0,
            padding: '12px 14px',
            background: 'rgba(184, 58, 42, 0.08)',
            border: `1px solid ${QUIZ.ALERT}`,
            borderRadius: 8,
            color: QUIZ.ALERT,
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          {payError}
        </p>
      ) : null}
    </>
  );
}

function PayHeader({ deposit }: { deposit: number }) {
  // Plain headline + sub. No uppercase eyebrow — the surrounding
  // step is already framed by the "Your appointment" banner at
  // the top of the modal, so an additional small-caps label here
  // was visual noise that didn't match the rest of the form's
  // typography.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 4 }}>
      <h2
        style={{
          margin: 0,
          fontSize: 20,
          fontWeight: 700,
          color: QUIZ.INK,
          letterSpacing: '-0.01em',
        }}
      >
        Pay {formatPrice(deposit)} to secure your slot
      </h2>
      <p
        style={{
          margin: 0,
          fontSize: 15,
          color: QUIZ.MUTED_2,
          lineHeight: 1.45,
        }}
      >
        Refundable per our cancellation policy. The remaining balance is paid at your
        appointment, and we'll send a confirmation email with everything you need.
      </p>
    </div>
  );
}

function Shell({
  children,
  maxWidth,
}: {
  children: React.ReactNode;
  maxWidth: number;
}) {
  return (
    <div
      style={{
        maxWidth,
        margin: '0 auto',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
      }}
    >
      {children}
    </div>
  );
}
