import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
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
import { SummaryStep } from './steps/SummaryStep.tsx';
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

  // Determine what the Next button does on this step.
  // - 'summary' + no payment next → submit (free booking)
  // - 'summary' + payment next → goNext (advance to Stripe)
  // - other steps → goNext
  const nextStepKey = api.activeSteps[api.currentIdx + 1] ?? null;
  const isPaymentNext = nextStepKey === 'payment';
  const onFooterNext = () => {
    if (api.stepKey === 'summary' && !isPaymentNext) {
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
}) {
  const accent = brand?.accent ?? QUIZ.ACCENT;
  const isHostEmbedded =
    typeof document !== 'undefined' &&
    !!document.getElementById('vlounge-embed-modal');

  // When embedded in the modal chrome, the shell fills the modal
  // card (height: 100%). When standalone (/book route), the shell
  // takes the full viewport.
  const rootHeight = isHostEmbedded ? '100%' : '100dvh';
  const rootBackground = isHostEmbedded ? 'transparent' : QUIZ.BG;
  const rootPosition = 'relative' as const;

  return (
    <div
      style={{
        position: rootPosition,
        height: rootHeight,
        background: rootBackground,
        color: QUIZ.INK,
        fontFamily: QUIZ.FONT_STACK,
        // Reserve room for the absolute close button in the modal
        // chrome (top:14 right:20) — the progress bar starts below it.
        paddingTop: isHostEmbedded ? 0 : 0,
      }}
    >
      <ProgressBar
        value={api.visibleCurrentIdx + 1}
        total={api.visibleTotalSteps}
      />

      <StepFrame stepKey={api.stepKey}>
        <StepBody
          api={api}
          copy={copy}
          locations={locations}
          accent={accent}
          submissionError={submissionError}
          onDismissError={onDismissError}
          onSubmit={onSubmit}
          submitting={submitting}
        />
      </StepFrame>

      <Footer
        api={api}
        copy={copy}
        accent={accent}
        onNext={onNext}
        onBack={api.goBack}
        submitting={submitting}
        isPaymentNext={isPaymentNext}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Progress bar
// ─────────────────────────────────────────────────────────────────────────────

function ProgressBar({ value, total }: { value: number; total: number }) {
  const pct = total > 0 ? Math.max(0, Math.min(100, (value / total) * 100)) : 0;
  return (
    <div
      style={{
        position: 'absolute',
        top: 20,
        left: 20,
        right: 60, // leave room for the close × button
        zIndex: 5,
      }}
      aria-hidden
    >
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
        }}
      >
        <div
          className="vlounge-progress-fill"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step frame — absolute-positioned content area
// ─────────────────────────────────────────────────────────────────────────────

function StepFrame({
  stepKey,
  children,
}: {
  stepKey: string;
  children: React.ReactNode;
}) {
  // Re-mount fade key whenever stepKey changes so the new step
  // animates in from translateY(8px) → 0.
  return (
    <div
      key={stepKey}
      style={{
        position: 'absolute',
        top: QUIZ.STEP_TOP_OFFSET,
        left: 0,
        right: 0,
        bottom: QUIZ.STEP_BOTTOM_OFFSET,
        overflowY: 'auto',
        overflowX: 'hidden',
        padding: '0 20px 20px',
        WebkitOverflowScrolling: 'touch',
        scrollBehavior: 'smooth',
        animation: `vlounge-stepFadeIn 0.22s ${QUIZ.EASE_CARD} both`,
      }}
    >
      {children}
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
        margin: '0 auto 28px',
        textAlign: 'center',
        fontSize: 28,
        lineHeight: 1.2,
        fontWeight: 700,
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
}: {
  api: BookingStateApi;
  copy: WidgetCopy;
  locations: WidgetLocation[];
  accent: string;
  submissionError: string | null;
  onDismissError: () => void;
  onSubmit: (paymentIntentId: string | null) => void;
  submitting: boolean;
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
}: {
  api: BookingStateApi;
  copy: WidgetCopy;
  locations: WidgetLocation[];
  accent: string;
  onSubmit: (paymentIntentId: string | null) => void;
  submitting: boolean;
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
    case 'summary':
      return <SummaryStep api={api} copy={copy} accent={accent} />;
    case 'details':
      return <DetailsStep api={api} />;
    case 'payment':
      return (
        <Suspense fallback={<PaymentLoadingFallback />}>
          <PaymentStep
            api={api}
            onPaid={(pi) => onSubmit(pi)}
            submitting={submitting}
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
}: {
  api: BookingStateApi;
  copy: WidgetCopy;
  accent: string;
  onNext: () => void;
  onBack: () => void;
  submitting: boolean;
  isPaymentNext: boolean;
}) {
  const showTerms = api.stepKey === 'summary';
  const showPrice =
    api.stepKey === 'summary' || api.stepKey === 'payment';
  const total = priceTotalFor(api);
  const nextDisabled = !isNextEnabled(api) || submitting;

  const nextLabel = (() => {
    if (submitting) return 'Booking…';
    if (api.stepKey === 'summary') {
      return isPaymentNext ? copy.summaryCtaPayment : copy.summaryCtaBook;
    }
    return 'Continue';
  })();

  // Payment step: Stripe owns the submission button. We hide the
  // footer Next entirely — back remains so the customer can return
  // to the summary if they change their mind.
  const showNext = api.stepKey !== 'payment';

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        padding: '16px 20px 18px',
        background: QUIZ.BG,
        boxShadow: QUIZ.SHADOW_FOOTER,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
        zIndex: 10,
        paddingBottom: 'calc(18px + env(safe-area-inset-bottom, 0px))',
      }}
    >
      {showPrice && total > 0 ? (
        <p
          style={{
            margin: 0,
            fontSize: 16,
            fontWeight: 700,
            color: QUIZ.INK,
            animation: `vlounge-fadeIn 0.3s ease`,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          <span style={{ color: QUIZ.MUTED_2, fontWeight: 500, marginRight: 6 }}>
            {copy.summaryTotalLabel}
          </span>
          {formatPrice(total)}
        </p>
      ) : null}

      {showTerms ? (
        <label
          style={{
            display: 'flex',
            alignItems: 'flex-start',
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
              marginTop: 3,
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
            {nextLabel}
          </NextButton>
        ) : (
          <div style={{ flex: 1 }} />
        )}
      </div>
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

function priceTotalFor(api: BookingStateApi): number {
  const b = api.priceBreakdown;
  return b.depositPence > 0 ? b.depositPence : b.subtotalPence;
}

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
