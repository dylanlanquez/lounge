import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ArrowLeft, BadgeCheck, CalendarCheck, Loader2, Lock } from 'lucide-react';
import type { PaymentApi } from './steps/Payment.tsx';
import {
  type BookingStateApi,
  type ResolvedPrefill,
  formatPrice,
  isNextEnabled,
  stepTitle,
  useBookingState,
} from './state.ts';
import { useWidgetCopy, type WidgetCopy } from './copy.ts';
import {
  useWidgetBookingTypes,
  useWidgetLocations,
  type WidgetBookingType,
  type WidgetLocation,
} from './data.ts';
import { LocationStep } from './steps/Location.tsx';
import { ServiceStep } from './steps/Service.tsx';
import { AxisStep } from './steps/Axis.tsx';
import { UpgradesStep } from './steps/Upgrades.tsx';
import { TimeStep } from './steps/Time.tsx';
import { DetailsStep } from './steps/Details.tsx';
// PaymentStep is lazy-loaded so @stripe/stripe-js (~80 KB) and
// @stripe/react-stripe-js only download when a paid booking actually
// reaches the deposit screen. Free-service bookings never fetch Stripe.
const PaymentStep = lazy(() =>
  import('./steps/Payment.tsx').then((m) => ({ default: m.PaymentStep })),
);
import { SuccessScreen } from './steps/Success.tsx';
import { submitBooking, SubmitError } from './submit.ts';
import { loadRememberedIdentity } from './state.ts';
import { rememberBookingToken, useRememberedBookings } from './rememberedBookings.ts';
import { WelcomeBack } from './WelcomeBack.tsx';
import type { AxisKey } from '../../lib/queries/bookingTypeAxes.ts';
import { QUIZ, ensureQuizKeyframes } from './quizTokens.ts';

// Public booking widget — embedded on the practice's website.
//
// Rewritten 2026-05-14 to mirror the venneir.com retainer-cart quiz
// modal at /Users/dylan/Downloads/retainer-cart.liquid. The shell
// has three rows:
//
//   ┌─────────────────────────────────────────────────────────┐
//   │ ProgressBar (gradient + shimmer, 16px tall)             │
//   ├─────────────────────────────────────────────────────────┤
//   │                                                          │
//   │ Step content (absolute, top:80 bottom:108, scrollable)   │
//   │   • centred 28px title with fadeInDown                   │
//   │   • per-step component body                              │
//   │                                                          │
//   ├─────────────────────────────────────────────────────────┤
//   │ Sticky footer:                                           │
//   │   • Terms checkbox (summary step only)                   │
//   │   • Price preview (summary/payment only)                 │
//   │   • [round back] [pill Next]                             │
//   └─────────────────────────────────────────────────────────┘
//
// Selection is decoupled from navigation: the customer taps an
// option to select it, then taps the navy Next pill in the footer
// to advance. Matches the template's UX exactly. No more auto-
// advance, no more right-rail sidebar, no more mobile dock.

export interface WidgetBrand {
  id: 'venneir' | 'denture';
  name: string;
  accent: string;
  accentBg: string;
  logoSrc: string;
  logoAlt: string;
  tagline: string;
}

export interface WidgetPrefill {
  /** Maps to lng_widget_booking_types.service_type. */
  serviceKey?: string | null;
  /** Maps to the catalogue's product_key. */
  productKey?: string | null;
  /** 'upper' | 'lower' | 'both'. */
  arch?: 'upper' | 'lower' | 'both' | null;
  /** Maps to the catalogue's repair_variant column. */
  repairVariant?: string | null;
  /** Maps to lng_widget_locations.id. */
  locationId?: string | null;
  /** Pre-fills the Details step email field. */
  shopifyCustomerEmail?: string | null;
  /** Held but not used yet — see staff-link-shopify-customer. */
  shopifyCustomerId?: string | null;
}

export interface WidgetProps {
  embedded?: boolean;
  brand?: WidgetBrand;
  prefill?: WidgetPrefill;
}

export function Widget({ brand, prefill }: WidgetProps = {}) {
  // Gate the first render on locations + booking types + copy so a
  // deep-linked service has its matching booking-type object
  // resolved before useBookingState seeds initial state.
  const locationsResult = useWidgetLocations();
  const bookingTypesResult = useWidgetBookingTypes();
  const { copy, loading: copyLoading } = useWidgetCopy();

  if (
    locationsResult.loading ||
    bookingTypesResult.loading ||
    copyLoading ||
    !locationsResult.data ||
    !bookingTypesResult.data
  ) {
    return (
      <BootScreen error={locationsResult.error ?? bookingTypesResult.error} />
    );
  }

  return (
    <WidgetReady
      locations={locationsResult.data}
      bookingTypes={bookingTypesResult.data}
      copy={copy}
      brand={brand}
      prefill={prefill}
    />
  );
}

function WidgetReady({
  locations,
  bookingTypes,
  copy,
  brand,
  prefill,
}: {
  locations: WidgetLocation[];
  bookingTypes: WidgetBookingType[];
  copy: WidgetCopy;
  brand?: WidgetBrand;
  prefill?: WidgetPrefill;
}) {
  // Inject the keyframes used by the chrome (modal-slide-in, step
  // fade-in, progress shimmer) once per page. Cheap and idempotent.
  useEffect(() => {
    ensureQuizKeyframes();
  }, []);

  const resolvedPrefill = useMemo<ResolvedPrefill>(() => {
    const out: ResolvedPrefill = {
      location: null,
      service: null,
      axes: {},
      details: {},
    };
    if (prefill?.locationId) {
      const match = locations.find((l) => l.id === prefill.locationId);
      if (match) out.location = match;
    }
    if (prefill?.serviceKey) {
      const match = bookingTypes.find(
        (bt) => bt.serviceType === prefill.serviceKey,
      );
      if (match) out.service = match;
    }
    if (prefill?.productKey) out.axes.product_key = prefill.productKey;
    if (prefill?.arch) out.axes.arch = prefill.arch;
    if (prefill?.repairVariant) out.axes.repair_variant = prefill.repairVariant;
    if (prefill?.shopifyCustomerEmail) {
      out.details.email = prefill.shopifyCustomerEmail.toLowerCase().trim();
    }
    if (!out.location && typeof window !== 'undefined') {
      const param = new URLSearchParams(window.location.search).get('location');
      if (param) {
        const match = locations.find((l) => l.id === param);
        if (match) out.location = match;
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasMeaningfulPrefill = Boolean(
    resolvedPrefill.service ||
      resolvedPrefill.axes.product_key ||
      resolvedPrefill.axes.arch ||
      resolvedPrefill.axes.repair_variant ||
      resolvedPrefill.details.email,
  );

  const remembered = useRememberedBookings();
  const [mode, setMode] = useState<'welcome' | 'booking'>('welcome');
  const showWelcome =
    mode === 'welcome' &&
    !resolvedPrefill.location &&
    !hasMeaningfulPrefill &&
    !remembered.loading &&
    remembered.data.length > 0;
  const greetingName = useMemo(() => {
    const stored = loadRememberedIdentity();
    if (stored?.firstName?.trim()) return stored.firstName.trim();
    const fromBooking = remembered.data.find((b) => b.patientFirstName);
    return fromBooking?.patientFirstName ?? null;
  }, [remembered.data]);

  const api = useBookingState(locations, resolvedPrefill);
  const [submission, setSubmission] = useState<{
    state: 'idle' | 'submitting' | 'done';
    appointmentRef: string | null;
    error: string | null;
  }>({ state: 'idle', appointmentRef: null, error: null });

  // Single submission entry-point. Called from the footer Next
  // button on the summary step (free booking) or from the Payment
  // step's onPaid handler after Stripe confirms.
  const submit = async (paymentIntentId: string | null = null) => {
    if (submission.state === 'submitting') return;
    setSubmission({ state: 'submitting', appointmentRef: null, error: null });
    try {
      const result = await submitBooking(api.state, paymentIntentId, brand?.id);
      if (result.manageToken) rememberBookingToken(result.manageToken);
      setSubmission({
        state: 'done',
        appointmentRef: result.appointmentRef,
        error: null,
      });
    } catch (e) {
      const err = e as SubmitError;
      if (err.code === 'slot_unavailable') {
        setSubmission({
          state: 'idle',
          appointmentRef: null,
          error: 'That slot was just taken — pick another time.',
        });
        api.goTo('time');
        return;
      }
      setSubmission({
        state: 'idle',
        appointmentRef: null,
        error:
          messageForCode(err.code) ??
          "Couldn't book your appointment. Please try again.",
      });
    }
  };

  if (submission.state === 'done') {
    return (
      <SuccessScreen
        state={api.state}
        appointmentRef={submission.appointmentRef}
        brand={brand}
      />
    );
  }

  if (showWelcome) {
    return (
      <WelcomeBack
        bookings={remembered.data}
        onStartNew={() => setMode('booking')}
        greetingName={greetingName}
      />
    );
  }

  // Payment step plumbing — the Pay button lives in the sticky
  // footer (not in the Payment step) so the layout matches the
  // rest of the form. PaymentStep exposes a `pay()` method via
  // ref so the footer can trigger stripe.confirmPayment without
  // losing the Elements context, and the footer's
  // disabled/label state reads `paymentReady` + `paymentPaying`.
  const paymentRef = useRef<PaymentApi | null>(null);
  const [paymentReady, setPaymentReady] = useState(false);
  const [paymentPaying, setPaymentPaying] = useState(false);

  // Determine what the Next button does on this step.
  // - 'details' + no payment next → submit (free booking)
  // - 'details' + payment next → goNext (advance to Stripe)
  // - 'payment' → call paymentRef.current.pay()
  // - other steps → goNext
  const nextStepKey = api.activeSteps[api.currentIdx + 1] ?? null;
  const isPaymentNext = nextStepKey === 'payment';
  const onFooterNext = () => {
    if (api.stepKey === 'payment') {
      paymentRef.current?.pay();
      return;
    }
    if (api.stepKey === 'details' && !isPaymentNext) {
      submit(null);
      return;
    }
    api.goNext();
  };
  const submitting = submission.state === 'submitting';

  return (
    <ChromeShell
      api={api}
      copy={copy}
      brand={brand}
      locations={locations}
      onNext={onFooterNext}
      onSubmit={submit}
      submitting={submitting}
      submissionError={submission.error}
      onDismissError={() =>
        setSubmission((s) => ({ ...s, error: null }))
      }
      isPaymentNext={isPaymentNext}
      paymentRef={paymentRef}
      paymentReady={paymentReady}
      paymentPaying={paymentPaying}
      onPaymentReadyChange={setPaymentReady}
      onPaymentPayingChange={setPaymentPaying}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Chrome shell — three-row layout matching retainer-cart.liquid
// ─────────────────────────────────────────────────────────────────────────────

function ChromeShell({
  api,
  copy,
  brand,
  locations,
  onNext,
  onSubmit,
  submitting,
  submissionError,
  onDismissError,
  isPaymentNext,
  paymentRef,
  paymentReady,
  paymentPaying,
  onPaymentReadyChange,
  onPaymentPayingChange,
}: {
  api: BookingStateApi;
  copy: WidgetCopy;
  brand?: WidgetBrand;
  locations: WidgetLocation[];
  onNext: () => void;
  onSubmit: (paymentIntentId: string | null) => void;
  submitting: boolean;
  submissionError: string | null;
  onDismissError: () => void;
  isPaymentNext: boolean;
  paymentRef: React.MutableRefObject<PaymentApi | null>;
  paymentReady: boolean;
  paymentPaying: boolean;
  onPaymentReadyChange: (ready: boolean) => void;
  onPaymentPayingChange: (paying: boolean) => void;
}) {
  const accent = brand?.accent ?? QUIZ.ACCENT;
  const isHostEmbedded =
    typeof document !== 'undefined' &&
    !!document.getElementById('vlounge-embed-modal');

  // Flex-sibling header / body / footer pattern. The outer card
  // (embedHost.ts) is already display:flex column overflow:hidden;
  // the widget root below is the same — three direct children, the
  // middle one owns the scroll. Avoids the "footer peeks underneath
  // on over-scroll" failure mode you get from position:sticky inside
  // a scroll container. Standalone /book route gets a 100dvh root
  // so the same flex shell expands to the viewport.
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: isHostEmbedded ? '100%' : '100dvh',
        background: isHostEmbedded ? 'transparent' : QUIZ.BG,
        color: QUIZ.INK,
        fontFamily: QUIZ.FONT_STACK,
        overflow: 'hidden',
      }}
    >
      <header
        style={{
          flexShrink: 0,
          padding: '18px 60px 10px 20px', // right padding leaves room for close ×
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        {/* Subtle "Your Appointment" eyebrow so the flow reads as
            booking, not e-commerce. Calendar tick icon + small navy
            tracking-wide label, top-left of the modal. */}
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 12,
            fontWeight: 600,
            color: accent,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}
        >
          <CalendarCheck size={14} aria-hidden />
          <span>Your appointment</span>
        </div>
        <ProgressBar
          value={api.visibleCurrentIdx + 1}
          total={api.visibleTotalSteps}
        />
      </header>

      <div
        key={api.stepKey}
        className="vlounge-scroll"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          // `none` (not `contain`) kills both scroll-chaining AND
          // the rubber-band bounce on macOS/iOS. `contain` was
          // letting the trackpad over-scroll bounce content past
          // the sticky chrome.
          overscrollBehavior: 'none',
          WebkitOverflowScrolling: 'touch',
          scrollBehavior: 'smooth',
          animation: `vlounge-stepFadeIn 0.22s ${QUIZ.EASE_CARD} both`,
        }}
      >
        {/* Inner container caps content width — the modal is 97.5vw
            (~1500px on a large display) but cards / forms read best
            around 920px max. Centred horizontally, full height of
            the scroll container so empty space appears below the
            content rather than the content stretching to fill. */}
        <div
          style={{
            maxWidth: 920,
            margin: '0 auto',
            padding: '8px 20px 24px',
          }}
        >
          <StepBody
            api={api}
            copy={copy}
            locations={locations}
            accent={accent}
            submissionError={submissionError}
            onDismissError={onDismissError}
            onSubmit={onSubmit}
            submitting={submitting}
            paymentRef={paymentRef}
            onPaymentReadyChange={onPaymentReadyChange}
            onPaymentPayingChange={onPaymentPayingChange}
          />
        </div>
      </div>

      <Footer
        api={api}
        copy={copy}
        accent={accent}
        onNext={onNext}
        onBack={api.goBack}
        submitting={submitting}
        isPaymentNext={isPaymentNext}
        paymentReady={paymentReady}
        paymentPaying={paymentPaying}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Progress bar — gradient fill with shimmer. Sits inside the
// header flex slot, not absolute, so over-scroll never lifts it.
// ─────────────────────────────────────────────────────────────────────────────

function ProgressBar({ value, total }: { value: number; total: number }) {
  const pct = total > 0 ? Math.max(0, Math.min(100, (value / total) * 100)) : 0;
  return (
    <div
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-label={`Step ${value} of ${total}`}
      style={{
        height: 16,
        borderRadius: 8,
        background: QUIZ.PROGRESS_TRACK,
        overflow: 'hidden',
        position: 'relative',
        width: '100%',
      }}
    >
      <div
        className="vlounge-progress-fill"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step title — centred 28px header at the top of each step
// ─────────────────────────────────────────────────────────────────────────────

export function StepTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2
      style={{
        // 35px bottom margin matches the template `.step-title-vt`
        // exactly (line 15 of retainer-cart.liquid).
        margin: '0 auto 35px',
        textAlign: 'center',
        fontSize: 28,
        lineHeight: 1.2,
        // .step-title-vt in the template declares no font-weight at
        // all — the storefront's body inheritance carries through.
        // 500 (medium) is a deliberately light register that reads
        // as a section header rather than a marketing headline.
        fontWeight: 500,
        color: QUIZ.INK,
        letterSpacing: '-0.01em',
        animation: `vlounge-fadeInDown 0.3s ${QUIZ.EASE_BOUNCE}`,
        maxWidth: 720,
      }}
    >
      {children}
    </h2>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step body — title + per-step content, dispatched by stepKey
// ─────────────────────────────────────────────────────────────────────────────

function StepBody({
  api,
  copy,
  locations,
  accent,
  submissionError,
  onDismissError,
  onSubmit,
  submitting,
  paymentRef,
  onPaymentReadyChange,
  onPaymentPayingChange,
}: {
  api: BookingStateApi;
  copy: WidgetCopy;
  locations: WidgetLocation[];
  accent: string;
  submissionError: string | null;
  onDismissError: () => void;
  onSubmit: (paymentIntentId: string | null) => void;
  submitting: boolean;
  paymentRef: React.MutableRefObject<PaymentApi | null>;
  onPaymentReadyChange: (ready: boolean) => void;
  onPaymentPayingChange: (paying: boolean) => void;
}) {
  return (
    <>
      <StepTitle>{stepTitle(api.stepKey, copy)}</StepTitle>
      {submissionError ? (
        <ErrorBanner message={submissionError} onDismiss={onDismissError} />
      ) : null}
      <StepRouter
        api={api}
        copy={copy}
        locations={locations}
        accent={accent}
        onSubmit={onSubmit}
        submitting={submitting}
        paymentRef={paymentRef}
        onPaymentReadyChange={onPaymentReadyChange}
        onPaymentPayingChange={onPaymentPayingChange}
      />
    </>
  );
}

function StepRouter({
  api,
  copy,
  locations,
  accent,
  onSubmit,
  submitting,
  paymentRef,
  onPaymentReadyChange,
  onPaymentPayingChange,
}: {
  api: BookingStateApi;
  copy: WidgetCopy;
  locations: WidgetLocation[];
  accent: string;
  onSubmit: (paymentIntentId: string | null) => void;
  submitting: boolean;
  paymentRef: React.MutableRefObject<PaymentApi | null>;
  onPaymentReadyChange: (ready: boolean) => void;
  onPaymentPayingChange: (paying: boolean) => void;
}) {
  if (api.stepKey.startsWith('axis:')) {
    const axisKey = api.stepKey.slice(5) as AxisKey;
    return <AxisStep api={api} axisKey={axisKey} accent={accent} />;
  }
  switch (api.stepKey) {
    case 'location':
      return <LocationStep api={api} locations={locations} accent={accent} />;
    case 'service':
      return <ServiceStep api={api} accent={accent} />;
    case 'upgrades':
      return (
        <UpgradesStep api={api} upgrades={api.upgrades} accent={accent} />
      );
    case 'time':
      return <TimeStep api={api} />;
    case 'details':
      return <DetailsStep api={api} copy={copy} accent={accent} />;
    case 'payment':
      return (
        <Suspense fallback={<PaymentLoadingFallback />}>
          <PaymentStep
            ref={paymentRef}
            api={api}
            onPaid={(pi) => onSubmit(pi)}
            submitting={submitting}
            onReadyChange={onPaymentReadyChange}
            onPayingChange={onPaymentPayingChange}
          />
        </Suspense>
      );
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Footer — sticky bottom with terms, price preview, back, next
// ─────────────────────────────────────────────────────────────────────────────

function Footer({
  api,
  copy,
  accent,
  onNext,
  onBack,
  submitting,
  isPaymentNext,
  paymentReady,
  paymentPaying,
}: {
  api: BookingStateApi;
  copy: WidgetCopy;
  accent: string;
  onNext: () => void;
  onBack: () => void;
  submitting: boolean;
  isPaymentNext: boolean;
  paymentReady: boolean;
  paymentPaying: boolean;
}) {
  // Terms checkbox lives in the footer on the combined Details
  // step — the form + summary are above; the customer ticks terms
  // and hits Next once everything reads right.
  const showTerms = api.stepKey === 'details';
  const isPaymentStep = api.stepKey === 'payment';
  // Today / On-the-day split: shown on every priced step.
  const breakdown = api.priceBreakdown;
  const depositPence = breakdown.depositPence;
  const onTheDayPence = breakdown.payAtAppointmentPence;
  const showPrice = depositPence > 0 || onTheDayPence > 0;

  const nextDisabled = isPaymentStep
    ? !paymentReady || paymentPaying || submitting
    : !isNextEnabled(api) || submitting;

  const nextLabel = (() => {
    if (isPaymentStep) {
      if (paymentPaying || submitting) return 'Processing…';
      return `Pay ${formatPrice(depositPence)}`;
    }
    if (submitting) return 'Booking…';
    if (api.stepKey === 'details') {
      return isPaymentNext ? copy.summaryCtaPayment : copy.summaryCtaBook;
    }
    return 'Continue';
  })();

  // Payment step shows the Pay button in the footer; the actual
  // stripe.confirmPayment call is wired through paymentRef in the
  // parent. We keep the Back button so the patient can return to
  // the Details/Summary if they change their mind.
  const showNext = true;

  return (
    <footer
      style={{
        flexShrink: 0,
        padding: '16px 20px 18px',
        background: QUIZ.BG,
        boxShadow: QUIZ.SHADOW_FOOTER,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
        paddingBottom: 'calc(18px + env(safe-area-inset-bottom, 0px))',
      }}
    >
      {showPrice ? (
        <FooterPrice
          depositPence={depositPence}
          onTheDayPence={onTheDayPence}
        />
      ) : null}

      {showTerms ? (
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            cursor: 'pointer',
            maxWidth: 600,
            width: '100%',
          }}
        >
          <input
            type="checkbox"
            checked={api.state.details.agreeTerms}
            onChange={(e) =>
              api.setState((prev) => ({
                ...prev,
                details: { ...prev.details, agreeTerms: e.target.checked },
              }))
            }
            style={{
              width: 16,
              height: 16,
              cursor: 'pointer',
              flexShrink: 0,
              accentColor: accent,
            }}
          />
          <span
            style={{
              fontSize: 14,
              color: QUIZ.MUTED_2,
              lineHeight: 1.4,
              textAlign: 'left',
            }}
          >
            I agree to the{' '}
            <a
              href={copy.detailsTermsUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: accent,
                fontWeight: 500,
                textDecoration: 'none',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.textDecoration = 'underline';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.textDecoration = 'none';
              }}
            >
              terms and conditions
            </a>
            .
          </span>
        </label>
      ) : null}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          maxWidth: 600,
        }}
      >
        <BackButton
          disabled={!api.canGoBack}
          onClick={onBack}
        />
        {showNext ? (
          <NextButton
            disabled={nextDisabled}
            onClick={onNext}
            accent={accent}
          >
            {isPaymentStep ? (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                }}
              >
                <Lock size={14} aria-hidden />
                {nextLabel}
              </span>
            ) : (
              nextLabel
            )}
          </NextButton>
        ) : (
          <div style={{ flex: 1 }} />
        )}
      </div>
    </footer>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Footer price — Today / On the day as plain typography
// ─────────────────────────────────────────────────────────────────────────────
//
// Pure typography, no boxes, no icons. Small-caps label on top,
// large bold number below. On-the-day faded to ~55% opacity so the
// eye lands on the deposit first. Pair is centred with a hair-line
// divider between on screens wide enough; stacks vertically on
// narrow viewports (≤ 480px effective width). Either block hides
// if its amount is zero.

function FooterPrice({
  depositPence,
  onTheDayPence,
}: {
  depositPence: number;
  onTheDayPence: number;
}) {
  const showDeposit = depositPence > 0;
  const showOnTheDay = onTheDayPence > 0;
  if (!showDeposit && !showOnTheDay) return null;
  return (
    <div
      className="vlounge-footer-price"
      style={{
        display: 'flex',
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 20,
        width: '100%',
        animation: `vlounge-fadeIn 0.25s ease`,
      }}
    >
      {showDeposit ? (
        <FooterPriceBlock
          label="Today"
          valuePence={depositPence}
          muted={false}
          icon={<BadgeCheck size={18} aria-hidden />}
        />
      ) : null}
      {showDeposit && showOnTheDay ? (
        <span
          aria-hidden
          className="vlounge-footer-price-divider"
          style={{
            width: 1,
            height: 32,
            background: 'rgba(0, 0, 0, 0.10)',
            flexShrink: 0,
          }}
        />
      ) : null}
      {showOnTheDay ? (
        <FooterPriceBlock label="On the day" valuePence={onTheDayPence} muted />
      ) : null}
    </div>
  );
}

function FooterPriceBlock({
  label,
  valuePence,
  muted,
  icon,
}: {
  label: string;
  valuePence: number;
  muted: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        lineHeight: 1.1,
        opacity: muted ? 0.55 : 1,
      }}
    >
      <span
        style={{
          fontSize: 10,
          fontWeight: 600,
          color: QUIZ.MUTED_2,
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          marginTop: 4,
          fontSize: 22,
          fontWeight: 700,
          color: QUIZ.INK,
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: '-0.01em',
        }}
      >
        {icon ? (
          <span
            aria-hidden
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: QUIZ.ACCENT,
            }}
          >
            {icon}
          </span>
        ) : null}
        {formatPrice(valuePence)}
      </span>
    </div>
  );
}

function BackButton({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      aria-label="Back"
      style={{
        border: 'none',
        width: 42,
        height: 42,
        minWidth: 32,
        padding: 0,
        borderRadius: '50%',
        cursor: disabled ? 'default' : 'pointer',
        background: QUIZ.PROGRESS_BACK_BG,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        color: QUIZ.ACCENT,
        transition: `all 0.2s ${QUIZ.EASE_CARD}`,
        opacity: disabled ? 0 : 1,
        pointerEvents: disabled ? 'none' : 'auto',
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = QUIZ.PROGRESS_BACK_BG_HOVER;
        e.currentTarget.style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = QUIZ.PROGRESS_BACK_BG;
        e.currentTarget.style.transform = 'translateY(0)';
      }}
    >
      <ArrowLeft size={20} aria-hidden />
    </button>
  );
}

function NextButton({
  disabled,
  onClick,
  accent,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        border: 'none',
        padding: '12px 28px',
        borderRadius: QUIZ.R_PILL,
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: 16,
        fontWeight: 700,
        background: accent,
        color: '#fff',
        flex: 1,
        fontFamily: 'inherit',
        transition: `all 0.2s ${QUIZ.EASE_CARD}`,
        opacity: disabled ? 0.4 : 1,
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.transform = 'translateY(-1px)';
        e.currentTarget.style.boxShadow = QUIZ.SHADOW_BUTTON_HOVER;
      }}
      onMouseLeave={(e) => {
        if (disabled) return;
        e.currentTarget.style.transform = 'translateY(0)';
        e.currentTarget.style.boxShadow = 'none';
      }}
    >
      {children}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function PaymentLoadingFallback() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '200px',
        color: QUIZ.MUTED,
        fontSize: 14,
        gap: 8,
      }}
      aria-live="polite"
    >
      <style>{`@keyframes lng-widget-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      <Loader2
        size={16}
        style={{ animation: 'lng-widget-spin 0.9s linear infinite' }}
      />
      <span>Preparing payment…</span>
    </div>
  );
}

function BootScreen({ error }: { error: string | null }) {
  return (
    <div
      style={{
        minHeight: '100dvh',
        background: QUIZ.BG,
        color: QUIZ.MUTED,
        fontFamily: QUIZ.FONT_STACK,
        fontSize: 14,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      {error ? (
        <p
          style={{
            margin: 0,
            color: QUIZ.ALERT,
            fontWeight: 600,
          }}
        >
          Couldn't reach the booking system. Please refresh the page.
        </p>
      ) : (
        <span aria-live="polite">Loading…</span>
      )}
    </div>
  );
}

function ErrorBanner({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div
      role="alert"
      style={{
        marginBottom: 16,
        padding: '12px 16px',
        background: 'rgba(184, 58, 42, 0.08)',
        border: `1px solid ${QUIZ.ALERT}`,
        borderRadius: QUIZ.R_INPUT,
        color: QUIZ.ALERT,
        fontSize: 14,
        fontWeight: 600,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        maxWidth: 720,
        marginLeft: 'auto',
        marginRight: 'auto',
      }}
    >
      <span>{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        style={{
          border: 'none',
          background: 'transparent',
          color: 'inherit',
          fontSize: 20,
          fontWeight: 600,
          cursor: 'pointer',
          padding: 0,
          lineHeight: 1,
        }}
      >
        ×
      </button>
    </div>
  );
}

function messageForCode(code: string): string | null {
  switch (code) {
    case 'terms_not_accepted':
      return 'Please tick the terms and conditions to continue.';
    case 'invalid':
    case 'firstName_missing':
    case 'lastName_missing':
    case 'email_invalid':
    case 'phone_invalid':
      return 'Some details are missing or invalid. Check the form and try again.';
    case 'no_booking_config':
      return 'This service is currently unavailable. Please try a different option.';
    case 'no_location_resolved':
      return "We couldn't find an available location.";
    case 'payment_intent_required':
      return 'Please complete payment before booking.';
    case 'payment_not_succeeded':
    case 'payment_amount_mismatch':
    case 'payment_currency_mismatch':
    case 'payment_metadata_mismatch':
    case 'payment_intent_fetch_failed':
    case 'payment_intent_unparseable':
      return "We couldn't verify your payment. Please contact the clinic before retrying.";
    default:
      return null;
  }
}
