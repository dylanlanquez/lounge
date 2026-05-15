import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Calendar, CalendarClock, Mail, MapPin } from 'lucide-react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import type { BookingStateApi } from '../state.ts';
import { formatPriceShort } from '../state.ts';
import { formatSlotLong } from '../BookingReview.tsx';
import { QUIZ } from '../quizTokens.ts';
import { env } from '../../../lib/env.ts';
import { supabase } from '../../../lib/supabase.ts';
import { useClinicSettings } from '../../../lib/queries/clinicSettings.ts';

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

// Stripe publishable keys are picked at runtime based on the
// `stripe.mode` setting from lng_settings (live | test). loadStripe
// returns a singleton per key string, so calling it multiple times
// with the same key reuses the same Stripe instance — meaning
// flipping the toggle without a redeploy works first-render.
const stripeSingletons = new Map<string, Promise<Stripe | null>>();
function getStripeSingleton(publishableKey: string): Promise<Stripe | null> {
  let p = stripeSingletons.get(publishableKey);
  if (!p) {
    p = loadStripe(publishableKey);
    stripeSingletons.set(publishableKey, p);
  }
  return p;
}

function resolvePublishableKey(mode: 'live' | 'test'): string | null {
  if (mode === 'test') {
    return env.STRIPE_PUBLISHABLE_KEY_TEST ?? null;
  }
  // 'live' — prefer the explicit _LIVE var, fall back to the legacy
  // un-suffixed STRIPE_PUBLISHABLE_KEY so deployments configured
  // before the toggle landed keep working without a config change.
  return env.STRIPE_PUBLISHABLE_KEY_LIVE ?? env.STRIPE_PUBLISHABLE_KEY ?? null;
}

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

  // Stripe mode toggle. Defaults to 'live' while clinic settings
  // load so the very first paint doesn't accidentally show a Stripe
  // form pointed at the wrong account on a stale cache.
  const clinic = useClinicSettings();
  const stripeMode: 'live' | 'test' = clinic.data.stripeMode === 'test' ? 'test' : 'live';
  const publishableKey = resolvePublishableKey(stripeMode);
  const stripePromise = publishableKey ? getStripeSingleton(publishableKey) : null;

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
        amountPence?: number;
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
          // New flow: the widget always collects the full price now.
          // Server resolves the catalogue row's unit_price (or
          // both_arches_price when arch === 'both') and charges that;
          // the legacy 'deposit' path stays on the server for any
          // older client that hasn't been redeployed yet.
          paymentMode: 'full',
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

  // The forwarded ref needs to be present from first render so the
  // parent footer never gets a null call, BUT the exposed `pay`
  // method must delegate to PaymentForm's live implementation
  // (which only exists after Elements + Stripe have loaded). The
  // factory below runs once and returns an object whose `pay`
  // closes over `fallbackRef` — so at CALL TIME it reads whatever
  // PaymentForm has assigned, not the no-op stub from mount.
  // (Earlier shape `() => fallbackRef.current` snapshotted the
  // stub at mount and exposed THAT forever, which is why clicking
  // Pay did nothing — orphan PaymentIntents were the smoking gun.)
  const fallbackRef = useRef<PaymentApi>({ pay: async () => {} });
  useImperativeHandle(
    ref,
    () => ({
      pay: () => fallbackRef.current.pay(),
    }),
    [],
  );

  // Full-bill mode: we now collect the resolved service price up
  // front when the patient picked "Pay now" on the summary footer,
  // not the legacy deposit_pence. The price breakdown is the same
  // one the summary card renders, so the headline + Pay button
  // amount line up exactly with what the patient just committed to.
  const fullAmount = api.priceBreakdown.subtotalPence;

  // Read the storefront's actual body font and forward it to
  // Stripe's iframe. Stripe inputs render inside cross-origin
  // iframes, so neither `font-family: inherit` nor a
  // system-ui fallback ever pick up the venneir.com brand font —
  // the placeholder ("1234 1234 1234 1234" etc) rendered in a
  // visibly different typeface to the rest of the form. Sampling
  // getComputedStyle on document.body here gives us the actual
  // string (e.g. "Inter, sans-serif") to feed straight into
  // Stripe.appearance.variables.fontFamily.
  const stripeFontFamily = useMemo(() => {
    const fallback =
      'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return fallback;
    }
    try {
      const computed = window.getComputedStyle(document.body).fontFamily;
      return computed && computed.trim().length > 0 ? computed : fallback;
    } catch {
      return fallback;
    }
  }, []);

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
        <PayHeader fullAmount={fullAmount} slotIso={api.state.slotIso} />
        <p style={{ margin: 0, color: QUIZ.ALERT, fontSize: 14, fontWeight: 600 }}>
          {error}
        </p>
      </Shell>
    );
  }

  if (loading || !clientSecret) {
    return (
      <Shell maxWidth={720}>
        <PayHeader fullAmount={fullAmount} slotIso={api.state.slotIso} />
        <p style={{ margin: 0, color: QUIZ.MUTED_2, fontSize: 14 }}>Preparing payment…</p>
      </Shell>
    );
  }

  return (
    <Shell maxWidth={720}>
      <PayHeader fullAmount={fullAmount} slotIso={api.state.slotIso} />
      <Elements
        stripe={stripePromise}
        options={{
          clientSecret,
          appearance: {
            theme: 'flat',
            variables: {
              // Stripe iframes are cross-origin sandboxed so neither
              // `inherit` nor a system-ui fallback ever picks up the
              // storefront's actual brand font. `stripeFontFamily`
              // is sampled from document.body.fontFamily at mount,
              // so the placeholders and value text now match the
              // exact typeface the rest of the form is rendered in.
              fontFamily: stripeFontFamily,
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
              // Lighter placeholder so "1234 1234 1234 1234" /
              // "MM / YY" / "CVC" read as quiet hints rather than
              // dark labels competing with the actual input value.
              colorTextPlaceholder: 'rgba(14, 20, 20, 0.28)',
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
            // Hide the Stripe Link "Save my information for faster
            // checkout" prompt. Link as a payment method is already
            // excluded server-side (the PaymentIntent declares
            // `payment_method_types[]=card` only), but the Link
            // autofill save offer is a separate Wallet surface that
            // PaymentElement renders by default — `link: 'never'`
            // suppresses it without affecting Apple Pay / Google Pay,
            // which still pop into the card tab on supported
            // devices.
            wallets: {
              applePay: 'auto',
              googlePay: 'auto',
              link: 'never',
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

      {elementReady ? <AfterYouPayCard /> : null}
    </>
  );
}

function AfterYouPayCard() {
  // Soft accent-tinted reassurance block below the card form. Lists
  // what the patient gets after they hit Pay so the moment-of-
  // conversion feels less like a leap into the dark. Three concise
  // items, icons in accent so they read as on-brand chrome rather
  // than third-party widget decoration.
  const items: Array<{ icon: React.ReactNode; text: string }> = [
    {
      icon: <Mail size={16} aria-hidden />,
      text: "Confirmation email with everything for your appointment, sent the moment payment clears.",
    },
    {
      icon: <CalendarClock size={16} aria-hidden />,
      text: "Reschedule or cancel any time from that email, free up to 24 hours before.",
    },
    {
      icon: <MapPin size={16} aria-hidden />,
      text: "Address, parking and what to bring all included so you arrive easy.",
    },
  ];
  return (
    <div
      style={{
        background: 'rgba(8, 55, 88, 0.04)',
        border: '1px solid rgba(8, 55, 88, 0.10)',
        borderRadius: 12,
        padding: '16px 18px',
        marginTop: 8,
      }}
    >
      <h3
        style={{
          margin: '0 0 10px',
          fontSize: 16,
          fontWeight: 700,
          color: QUIZ.ACCENT,
          letterSpacing: '-0.01em',
        }}
      >
        After you pay
      </h3>
      <ul
        style={{
          margin: 0,
          padding: 0,
          listStyle: 'none',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        {items.map((item, i) => (
          <li
            key={i}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              fontSize: 14,
              lineHeight: 1.45,
              color: QUIZ.MUTED,
            }}
          >
            <span
              aria-hidden
              style={{
                color: QUIZ.ACCENT,
                marginTop: 2,
                flexShrink: 0,
              }}
            >
              {item.icon}
            </span>
            <span>{item.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PayHeader({
  fullAmount,
  slotIso,
}: {
  fullAmount: number;
  slotIso: string | null;
}) {
  // Title — slot — separator — assurance copy. The slot line
  // surfaces "what they're paying for" right under the headline so
  // there's no doubt the £X is for THIS appointment. Hairline
  // separates the transactional line from the assurance paragraph.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 4 }}>
      <h2
        style={{
          margin: 0,
          fontSize: 20,
          fontWeight: 700,
          color: QUIZ.INK,
          letterSpacing: '-0.01em',
        }}
      >
        Pay {formatPriceShort(fullAmount)} and book appointment
      </h2>
      {slotIso ? (
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 15,
            fontWeight: 600,
            color: QUIZ.ACCENT,
          }}
        >
          <Calendar size={16} aria-hidden />
          <span>{formatSlotLong(slotIso)}</span>
        </div>
      ) : null}
      <hr
        style={{
          border: 'none',
          borderTop: `1px solid ${QUIZ.BORDER}`,
          margin: '4px 0 2px',
          width: '100%',
        }}
      />
      <p
        style={{
          margin: 0,
          fontSize: 15,
          color: QUIZ.MUTED_2,
          lineHeight: 1.45,
        }}
      >
        Your appointment is paid in full once the card clears. Nothing extra to pay
        at the clinic. We'll send a confirmation email with everything you need.
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
        // 32px from the step title — Payment has no intro
        // paragraph so the Pay-headline + card form would hug the
        // "Payment" h2 without it.
        marginTop: 32,
      }}
    >
      {children}
    </div>
  );
}
