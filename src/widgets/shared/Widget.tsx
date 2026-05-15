import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ArrowLeft } from 'lucide-react';
import { PaymentStep, type PaymentApi } from './steps/Payment.tsx';
import {
  type BookingStateApi,
  type ResolvedPrefill,
  formatPrice,
  formatPriceShort,
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
import { RepairArchStep, RepairLinesStep } from './steps/RepairBuilder.tsx';
import { UpgradesStep } from './steps/Upgrades.tsx';
import { TimeStep } from './steps/Time.tsx';
import { DetailsStep } from './steps/Details.tsx';
// PaymentStep imports statically. Previously this was lazy() +
// dynamic import to save ~7 KB gzipped on the initial bundle, but
// the cost was a chunk-mismatch 404 if a Vercel deploy landed
// while a customer was mid-flow: the cached main.js still
// referenced the old Payment-<hash>.js, which Vercel had already
// replaced on the production domain. Inlining the Payment step
// trades the 7 KB for reliability — patients never see a broken
// payment screen because their browser is one deploy behind.
// (The actual Stripe SDK still loads from js.stripe.com on demand
// via loadStripe(), so the heavy ~80 KB bundle this comment used
// to worry about is NOT in our bundle either way.)
import { SuccessScreen } from './steps/Success.tsx';
import { submitBooking, type SubmitError } from './submit.ts';
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
    appointmentId: string | null;
    manageToken: string | null;
    error: string | null;
  }>({
    state: 'idle',
    appointmentRef: null,
    appointmentId: null,
    manageToken: null,
    error: null,
  });

  // Payment step plumbing — the Pay button lives in the sticky
  // footer (not in the Payment step) so the layout matches the
  // rest of the form. PaymentStep exposes a `pay()` method via
  // ref so the footer can trigger stripe.confirmPayment without
  // losing the Elements context, and the footer's
  // disabled/label state reads `paymentReady` + `paymentPaying`.
  //
  // These hooks MUST sit above the early returns below — React's
  // rules of hooks require the same hook count every render, and
  // returning <SuccessScreen> or <WelcomeBack> early would otherwise
  // drop these three hook slots on the render where the branch
  // changes, throwing React error #300 ("Rendered fewer hooks
  // than expected") and blanking the page right after booking.
  const paymentRef = useRef<PaymentApi | null>(null);
  const [paymentReady, setPaymentReady] = useState(false);
  const [paymentPaying, setPaymentPaying] = useState(false);

  // Lock the modal + the browser tab while a payment is being
  // confirmed or the booking is being submitted server-side. Two
  // separate threats to a mid-flight payment:
  //   1. Modal close paths (X button, backdrop click, Esc) — we
  //      flip data-locked="true" on the embed root; embedHost.ts
  //      reads that flag and swallows every close path so a
  //      mistimed click can't unmount the Stripe confirmation.
  //   2. Tab close / refresh / back-button — we install a
  //      beforeunload handler so the browser shows its native
  //      "Leave site?" prompt before tearing the page down.
  const busy =
    paymentPaying || submission.state === 'submitting';
  useEffect(() => {
    if (!busy) return;
    const modalRoot =
      typeof document !== 'undefined'
        ? document.getElementById('vlounge-embed-modal')
        : null;
    if (modalRoot) modalRoot.dataset.locked = 'true';
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      // Chrome / Safari require BOTH preventDefault + a non-empty
      // returnValue to trigger the dialog. The actual string is
      // ignored on modern browsers (they show their own generic
      // copy), but it has to be set.
      e.preventDefault();
      e.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      if (modalRoot) delete modalRoot.dataset.locked;
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [busy]);

  // Single submission entry-point. Called from the footer Next
  // button on the summary step (free booking) or from the Payment
  // step's onPaid handler after Stripe confirms.
  const submit = async (
    paymentIntentId: string | null = null,
    paymentMode: 'full' | 'deposit' | 'on_the_day' | null = null,
  ) => {
    if (submission.state === 'submitting') return;
    setSubmission({
      state: 'submitting',
      appointmentRef: null,
      appointmentId: null,
      manageToken: null,
      error: null,
    });
    try {
      // paymentMode is explicit because the summary-footer CTAs set
      // api.state.paymentChoice and call submit in the same handler —
      // React hasn't committed yet, so we'd read the stale value off
      // api.state. Passing it through sidesteps that race; falls back
      // to api.state for legacy callers (free-service path) and for
      // the Payment-step success handler (which is post-commit).
      const resolvedMode =
        paymentMode ??
        (api.state.paymentChoice === 'pay_full'
          ? 'full'
          : api.state.paymentChoice === 'pay_deposit'
            ? 'deposit'
            : api.state.paymentChoice === 'pay_on_the_day'
              ? 'on_the_day'
              : null);
      const result = await submitBooking(
        api.state,
        paymentIntentId,
        brand?.id,
        resolvedMode,
      );
      if (result.manageToken) rememberBookingToken(result.manageToken);
      setSubmission({
        state: 'done',
        appointmentRef: result.appointmentRef,
        appointmentId: result.appointmentId,
        manageToken: result.manageToken,
        error: null,
      });
    } catch (e) {
      const err = e as SubmitError;
      if (err.code === 'slot_unavailable') {
        setSubmission({
          state: 'idle',
          appointmentRef: null,
          appointmentId: null,
          manageToken: null,
          error: 'That slot was just taken, pick another time.',
        });
        api.goTo('time');
        return;
      }
      if (err.code === 'startAt_in_past') {
        // Slot has aged past `now` between the patient picking it and
        // hitting submit (long pause on the details/payment step).
        // Clear the stale slotIso and bounce back to the time step
        // so they can pick a current one. Same UX shape as the slot-
        // unavailable branch.
        api.setState((prev) => ({ ...prev, slotIso: null }));
        setSubmission({
          state: 'idle',
          appointmentRef: null,
          appointmentId: null,
          manageToken: null,
          error: 'That time has just passed, pick another slot.',
        });
        api.goTo('time');
        return;
      }
      setSubmission({
        state: 'idle',
        appointmentRef: null,
        appointmentId: null,
        manageToken: null,
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
        appointmentId={submission.appointmentId}
        manageToken={submission.manageToken}
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
  // - 'payment' → call paymentRef.current.pay()
  // - 'details' → handled inline by the two-button summary footer
  //   (Pay now / Pay on the day); for free services the footer
  //   falls back to a single Book button that submits directly.
  // - other steps → goNext
  const onFooterNext = () => {
    if (api.stepKey === 'payment') {
      paymentRef.current?.pay();
      return;
    }
    if (api.stepKey === 'details') {
      // Free-service path. Paid services route through onPayNow /
      // onPayOnTheDay below, never through this branch.
      submit(null, null);
      return;
    }
    api.goNext();
  };

  // The summary-footer CTAs. Each sets api.state.paymentChoice (so
  // activeSteps recalcs and the back-arrow knows where to land) and
  // either advances to the Payment step or fires submit straight
  // away. paymentMode is passed to submit explicitly because the
  // setState above hasn't propagated by the time we call it.
  //
  // Three choices map to two routes:
  //   • Pay in full / Pay deposit  → Payment step (Stripe form)
  //   • Pay on the day             → submit immediately, no PI
  const onPayInFull = () => {
    api.choosePayment('pay_full');
  };
  const onPayDeposit = () => {
    api.choosePayment('pay_deposit');
  };
  const onPayOnTheDay = () => {
    api.choosePayment('pay_on_the_day');
    submit(null, 'on_the_day');
  };
  const submitting = submission.state === 'submitting';

  return (
    <ChromeShell
      api={api}
      copy={copy}
      brand={brand}
      locations={locations}
      onNext={onFooterNext}
      onPayInFull={onPayInFull}
      onPayDeposit={onPayDeposit}
      onPayOnTheDay={onPayOnTheDay}
      onSubmit={submit}
      submitting={submitting}
      submissionError={submission.error}
      onDismissError={() =>
        setSubmission((s) => ({ ...s, error: null }))
      }
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
  onPayInFull,
  onPayDeposit,
  onPayOnTheDay,
  onSubmit,
  submitting,
  submissionError,
  onDismissError,
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
  onPayInFull: () => void;
  onPayDeposit: () => void;
  onPayOnTheDay: () => void;
  onSubmit: (paymentIntentId: string | null) => void;
  submitting: boolean;
  submissionError: string | null;
  onDismissError: () => void;
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
        <ProgressBar
          value={api.visibleCurrentIdx + 1}
          total={api.visibleTotalSteps}
          still={api.stepKey === 'payment'}
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
        onPayInFull={onPayInFull}
        onPayDeposit={onPayDeposit}
        onPayOnTheDay={onPayOnTheDay}
        submitting={submitting}
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

function ProgressBar({
  value,
  total,
  still = false,
}: {
  value: number;
  total: number;
  /** Disable the shimmering gradient/shine animations. On the
   *  Payment step we want all motion to come from the Pay button
   *  alone, so the progress bar should sit static rather than
   *  competing for the eye. */
  still?: boolean;
}) {
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
        className={
          still ? 'vlounge-progress-fill vlounge-progress-fill--still' : 'vlounge-progress-fill'
        }
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step title — centred 28px header at the top of each step
// ─────────────────────────────────────────────────────────────────────────────

export function StepTitle({
  children,
  align = 'center',
}: {
  children: React.ReactNode;
  align?: 'center' | 'left';
}) {
  return (
    <h2
      style={{
        // Tight title/subtitle pair. Title pulls up 7.5px from the
        // earlier 30px top so the heading sits closer to the
        // progress bar; bottom drops to 6px so the step's intro
        // paragraph reads as a direct continuation rather than a
        // separate region.
        // `align='left'` keeps the same 720px centred column the
        // form below uses but flushes the text to the left so the
        // h2 sits over the first input — used on Details + Payment
        // where the body is form/card-like rather than option-grid.
        margin: '22px auto 6px',
        maxWidth: 720,
        textAlign: align,
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
  // Details + Payment use a left-aligned title because their body
  // is a single-column form/card rather than an option grid —
  // left-flush reads better above an input than centred does.
  const titleAlign: 'center' | 'left' =
    api.stepKey === 'details' || api.stepKey === 'payment' ? 'left' : 'center';
  // Repair per-arch steps render their own title inline so the
  // arch-context chip can sit ABOVE the title in the DOM and stick
  // to the top of the scroll container. If we let StepBody render
  // the default title here, the chip would have to live below it.
  const stepOwnsTitle =
    api.stepKey === 'repair:top' || api.stepKey === 'repair:bottom';
  return (
    <>
      {stepOwnsTitle ? null : (
        <StepTitle align={titleAlign}>{stepTitle(api.stepKey, copy, api.state)}</StepTitle>
      )}
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
  // Denture-repair custom step keys. These never overlap with the
  // generic axis flow — see activeStepsFor in state.ts.
  if (api.stepKey === 'repair:arch') {
    return <RepairArchStep api={api} accent={accent} />;
  }
  if (api.stepKey === 'repair:top') {
    return <RepairLinesStep api={api} arch="upper" accent={accent} />;
  }
  if (api.stepKey === 'repair:bottom') {
    return <RepairLinesStep api={api} arch="lower" accent={accent} />;
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
        <PaymentStep
          ref={paymentRef}
          api={api}
          onPaid={(pi) => onSubmit(pi)}
          submitting={submitting}
          onReadyChange={onPaymentReadyChange}
          onPayingChange={onPaymentPayingChange}
        />
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
  onPayInFull,
  onPayDeposit,
  onPayOnTheDay,
  submitting,
  paymentReady,
  paymentPaying,
}: {
  api: BookingStateApi;
  copy: WidgetCopy;
  accent: string;
  onNext: () => void;
  onBack: () => void;
  onPayInFull: () => void;
  onPayDeposit: () => void;
  onPayOnTheDay: () => void;
  submitting: boolean;
  paymentReady: boolean;
  paymentPaying: boolean;
}) {
  const isPaymentStep = api.stepKey === 'payment';
  const isDetailsStep = api.stepKey === 'details';
  const breakdown = api.priceBreakdown;
  const fullAmount = breakdown.subtotalPence;
  // Per-booking-type payment options. The Lounge admin (Widget tab)
  // sets each flag independently:
  //
  //   widget_deposit_pence        > 0       → "Pay deposit £X"
  //   widget_allow_pay_in_full    = TRUE    → "Pay in full"
  //   widget_allow_pay_on_the_day = TRUE    → "Pay on the day"
  //
  // Defaults: pay-in-full TRUE (historical universal option),
  // pay-on-the-day FALSE (legacy deposit-only). Deposit follows
  // depositPence > 0. If a misconfigured booking type has every
  // flag off + no deposit, fall back to the pay-in-full CTA so the
  // customer can still book.
  const depositPence = api.state.service?.depositPence ?? 0;
  const allowFull = api.state.service?.allowPayInFull !== false; // default TRUE
  const allowOTD = api.state.service?.allowPayOnTheDay === true;
  const showDepositCta = depositPence > 0;
  const showOTDCta = allowOTD;
  // Pay-in-full has to surface unless the admin explicitly turned it
  // off AND another option exists. Without this the footer would
  // render zero CTAs for a booking type that was misconfigured to
  // disable every option, locking the customer out of paying.
  const wouldHaveAnyCta = showDepositCta || showOTDCta || allowFull;
  const showFullCta = allowFull || !wouldHaveAnyCta;

  // "Pay on the day" needs a confirmation beat — clicking it
  // shouldn't book the appointment outright; the customer needs a
  // moment of "right, this is going to commit me". When confirmOTD
  // is true the two-CTA row collapses into one full-width "Book
  // appointment" button. The back arrow rolls back to the two-button
  // view instead of navigating to the previous step (handled by
  // effectiveOnBack below) so there's no separate "Change" link
  // cluttering the footer. Local state (not api.state) because the
  // intent is a transient UI mode, not a piece of the booking the
  // server cares about until the customer hits Book.
  const [confirmOTD, setConfirmOTD] = useState(false);
  // Reset the confirmation flag any time the customer leaves the
  // details step (Back arrow, etc.) so they land in the
  // two-button view next time they reach the summary.
  useEffect(() => {
    if (!isDetailsStep) setConfirmOTD(false);
  }, [isDetailsStep]);
  // Footer total line: hidden on Details (BookingReview shows the
  // full breakdown inline) and Payment (PayHeader spells it out
  // and the Pay button carries the amount). Everywhere else we
  // surface a single "Total" so the patient sees the running cost
  // as soon as the price is resolvable from the catalogue.
  const showPrice = !isDetailsStep && !isPaymentStep && fullAmount > 0;

  const detailsValid = isNextEnabled(api);
  const summaryPaid = isDetailsStep && fullAmount > 0;
  const summaryFree = isDetailsStep && fullAmount === 0;

  // Back-arrow behaviour: when the user has tapped "Pay on the day"
  // and is sitting on the Book-appointment confirmation, the arrow
  // rolls back the confirmation rather than navigating to the
  // previous step. Two presses still walk them all the way back
  // (first rolls confirmOTD off, second goes to the prior step).
  const inOTDConfirm = summaryPaid && confirmOTD;
  const backEnabled = inOTDConfirm || api.canGoBack;
  const effectiveOnBack = () => {
    if (inOTDConfirm) {
      setConfirmOTD(false);
      return;
    }
    onBack();
  };

  const nextDisabled = isPaymentStep
    ? !paymentReady || paymentPaying || submitting
    : !detailsValid || submitting;

  const nextLabel = (() => {
    if (isPaymentStep) {
      if (paymentPaying || submitting) return 'Processing…';
      // Match the Pay-on-the-day path's Book-appointment CTA verbatim
      // so the commit verb is identical regardless of which payment
      // route the patient picked. The price + verb context lives in
      // the PayHeader above the card form, so the button itself just
      // needs to read as the commit action.
      return 'Book appointment';
    }
    if (submitting) return 'Booking…';
    if (isDetailsStep) return copy.summaryCtaBook;
    return 'Next';
  })();

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
          totalPence={fullAmount}
          depositPence={showDepositCta ? depositPence : 0}
          accent={accent}
        />
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
        <BackButton disabled={!backEnabled} onClick={effectiveOnBack} />

        {summaryPaid ? (
          confirmOTD ? (
            // Confirmation beat — Pay-on-the-day was tapped once;
            // surfacing the explicit "Book appointment" makes the
            // commit step obvious. The back arrow (now overridden by
            // effectiveOnBack) rolls this confirmation off without
            // needing a separate "Change" link.
            <NextButton
              disabled={nextDisabled}
              onClick={onPayOnTheDay}
              accent={accent}
              shimmer={!submitting}
            >
              {submitting ? (
                'Booking…'
              ) : (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                  }}
                >
                  Book appointment
                  <BookCheckIcon size={16} />
                </span>
              )}
            </NextButton>
          ) : (
            // Per-booking-type CTA row. Picks the primary commit
            // (right-most NextButton) and zero or more secondary
            // outlined pills (left of primary) from the three flags
            // the admin sets per booking type. Primary priority is
            // deposit > pay-in-full > pay-on-the-day; remaining
            // enabled options surface as secondary pills, OTD
            // furthest-left when present. All buttons share the
            // disabled state so the row only lights up once the
            // form is valid.
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                minWidth: 0,
              }}
            >
              {(() => {
                // Primary picker: deposit beats full beats OTD. The
                // primary slot is the visual anchor that commits the
                // booking; secondaries are alternatives the customer
                // can pick instead.
                const primary: 'deposit' | 'full' | 'otd' = showDepositCta
                  ? 'deposit'
                  : showFullCta
                    ? 'full'
                    : 'otd';
                // Secondary slot: pay-in-full when deposit is the
                // primary AND pay-in-full is also enabled.
                const showFullSecondary = primary === 'deposit' && showFullCta;
                return (
                  <>
                    {showOTDCta && primary !== 'otd' ? (
                      <PayOnTheDayButton
                        disabled={nextDisabled}
                        onClick={() => setConfirmOTD(true)}
                        accent={accent}
                      >
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 6,
                          }}
                        >
                          <PayLaterIcon size={14} />
                          Pay on the day
                        </span>
                      </PayOnTheDayButton>
                    ) : null}
                    {showFullSecondary ? (
                      // Secondary outlined pill matches the OTD pill
                      // chrome so the row reads as a balanced set.
                      <PayOnTheDayButton
                        disabled={nextDisabled}
                        onClick={onPayInFull}
                        accent={accent}
                      >
                        {`Pay in full · ${formatPriceShort(fullAmount)}`}
                      </PayOnTheDayButton>
                    ) : null}
                    {primary === 'deposit' ? (
                      // When deposit is the ONLY option (no Pay-in-full
                      // pill, no OTD pill) the button reads as a
                      // generic "Next" — there's no choice to make,
                      // tapping just walks the patient into the Stripe
                      // step where the deposit amount + secure-card
                      // chrome carries the price + verb context. When
                      // a secondary CTA also exists the deposit row
                      // keeps its explicit "Pay deposit · £X" label so
                      // the choice between options stays unambiguous.
                      <NextButton
                        disabled={nextDisabled}
                        onClick={onPayDeposit}
                        accent={accent}
                        shimmer={false}
                      >
                        {showFullCta || showOTDCta
                          ? `Pay deposit · ${formatPriceShort(depositPence)}`
                          : 'Next'}
                      </NextButton>
                    ) : primary === 'full' ? (
                      <NextButton
                        disabled={nextDisabled}
                        onClick={onPayInFull}
                        accent={accent}
                        shimmer={false}
                      >
                        {`Pay ${formatPriceShort(fullAmount)} now`}
                      </NextButton>
                    ) : (
                      // OTD-only: the primary commit. The single-tap
                      // confirmation beat (confirmOTD) still applies
                      // — confirmOTD === true above swaps this row for
                      // a "Book appointment" Next button.
                      <NextButton
                        disabled={nextDisabled}
                        onClick={() => setConfirmOTD(true)}
                        accent={accent}
                        shimmer={false}
                      >
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 6,
                          }}
                        >
                          <PayLaterIcon size={14} />
                          Pay on the day
                        </span>
                      </NextButton>
                    )}
                  </>
                );
              })()}
            </div>
          )
        ) : summaryFree ? (
          // Free-service path — there's no payment step, the Book
          // button on Details IS the commit. Same shimmer + shield
          // treatment as every other Book-appointment commit so the
          // conversion moment reads the same regardless of price.
          <NextButton
            disabled={nextDisabled}
            onClick={onNext}
            accent={accent}
            shimmer={!submitting}
          >
            {submitting ? (
              nextLabel
            ) : (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                }}
              >
                {nextLabel}
                <BookCheckIcon size={16} />
              </span>
            )}
          </NextButton>
        ) : (
          <NextButton
            disabled={nextDisabled}
            onClick={onNext}
            accent={accent}
            shimmer={isPaymentStep}
          >
            {isPaymentStep && !paymentPaying && !submitting ? (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                }}
              >
                {nextLabel}
                <BookCheckIcon size={16} />
              </span>
            ) : (
              nextLabel
            )}
          </NextButton>
        )}
      </div>
    </footer>
  );
}

function PayOnTheDayButton({
  children,
  disabled,
  onClick,
  accent,
}: {
  children: React.ReactNode;
  disabled: boolean;
  onClick: () => void;
  accent: string;
}) {
  // Secondary pill. Matches NextButton's geometry (same height,
  // pill radius) so the two CTAs read as a balanced pair; outlined
  // chrome (white fill, 1.5px accent border, accent text) keeps
  // the primary "Pay £X now" as the visual anchor.
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        flex: 1,
        minWidth: 0,
        height: 52,
        borderRadius: 26,
        border: `1.5px solid ${accent}`,
        background: '#fff',
        color: accent,
        fontFamily: 'inherit',
        fontSize: 15,
        fontWeight: 600,
        letterSpacing: '-0.005em',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        transition: 'background 120ms ease, transform 120ms ease',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {children}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Footer price — single Total block, plain typography
// ─────────────────────────────────────────────────────────────────────────────
//
// One running total at the bottom of every step before Details
// (where the customer commits and picks pay-now vs pay-on-the-day).
// Pure typography, accent colour, no chrome. Hides itself when the
// price isn't resolvable yet (axes incomplete, free service).

function FooterPrice({
  totalPence,
  depositPence,
  accent,
}: {
  totalPence: number;
  /** When > 0 the footer renders a TODAY · ON THE DAY split instead
   *  of a single Total — primary block is the deposit ("£25 today"),
   *  muted block is the balance ("£374 on the day"). Mirrors what the
   *  Calendly-style booking summary used to surface; reintroduced for
   *  click-in / same-day where the practice always takes a deposit. */
  depositPence: number;
  accent: string;
}) {
  if (totalPence <= 0) return null;
  // Visual centring: the button row below has a 42px back-button on
  // the left + 8px gap before the Next pill. If the price simply
  // centred on the full footer width (justify-content:center +
  // width:100%) the £-amount sat ~25px left of the Next button's
  // own centre — fine numerically, off-axis visually. Mirror the
  // button row's structure (max-width 600, 42px spacer, flex:1
  // centred slot) so the total stacks directly above the CTA.
  const showSplit = depositPence > 0 && depositPence < totalPence;
  const balancePence = Math.max(0, totalPence - depositPence);
  return (
    <div
      className="vlounge-footer-price"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        maxWidth: 600,
        margin: '0 auto',
        animation: `vlounge-fadeIn 0.25s ease`,
      }}
    >
      <div aria-hidden style={{ width: 42, flexShrink: 0 }} />
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: showSplit ? 18 : 0,
        }}
      >
        {showSplit ? (
          <>
            <FooterPriceBlock
              label="Today"
              showLabel
              valuePence={depositPence}
              muted={false}
              accent={accent}
            />
            <span
              aria-hidden
              style={{
                width: 1,
                height: 30,
                background: accent,
                opacity: 0.18,
                flexShrink: 0,
              }}
            />
            <FooterPriceBlock
              label="On the day"
              showLabel
              valuePence={balancePence}
              muted
              accent={accent}
            />
          </>
        ) : (
          <FooterPriceBlock
            label="Total"
            valuePence={totalPence}
            muted={false}
            accent={accent}
          />
        )}
      </div>
    </div>
  );
}


function FooterPriceBlock({
  label,
  showLabel = false,
  valuePence,
  muted,
  icon,
  accent,
}: {
  label: string;
  /** When true the label renders as a tiny uppercase caption ABOVE
   *  the price (the Calendly-style "TODAY £25" / "ON THE DAY £374"
   *  pattern). Default false keeps the legacy single-Total view
   *  unchanged — the price stands alone, label is aria-only. */
  showLabel?: boolean;
  valuePence: number;
  muted: boolean;
  icon?: React.ReactNode;
  accent: string;
}) {
  // Label + amount both tint with the brand accent so the Today
  // block reads as one cohesive primary unit. Muted ("On the day")
  // block dims uniformly via opacity — same colour family, softer
  // presence so the eye lands on Today first.
  return (
    <div
      aria-label={label}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        lineHeight: 1.1,
        opacity: muted ? 0.45 : 1,
        color: accent,
        gap: showLabel ? 3 : 0,
      }}
    >
      {showLabel ? (
        <span
          style={{
            fontSize: 9.5,
            fontWeight: 700,
            color: accent,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          {label}
        </span>
      ) : null}
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          // Muted block (On the day) drops to 500 weight + 18px so
          // the eye still lands on Today first — the deposit is the
          // hero moment, the balance is supporting context.
          fontSize: muted ? 18 : 22,
          fontWeight: muted ? 500 : 700,
          color: accent,
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: '0.01em',
        }}
      >
        {icon ? (
          <span
            aria-hidden
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: accent,
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

// BookCheckIcon — bespoke calendar-with-tick mark used on every Book
// appointment CTA. Custom artwork (sourced from the brand asset set)
// rather than a Lucide icon so the conversion moment carries the
// product's own visual identity. fill=currentColor inherits whatever
// the parent button's text colour is, so the icon flips between
// white-on-accent (NextButton) and accent-on-white (PayOnTheDayButton)
// without per-call-site overrides.
function BookCheckIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 336.08 335.39"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden
      focusable="false"
    >
      <path d="M335.97,59.57l.1,238.96c0,20.87-16.06,36.87-36.93,36.86H36.91c-20.31,0-36.85-15.56-36.86-36.09L0,60.77C0,39.98,16,23.88,36.84,23.91l47.2.07-.07-11.3c-.04-6.99,4.96-12.47,11.72-12.68s12.29,4.95,12.33,11.93l.06,12.02h119.92s-.03-11.27-.03-11.27c-.02-7,4.93-12.47,11.73-12.69s12.31,4.96,12.32,11.93l.02,12.05,47.29-.08c19.58-.03,36.63,15.06,36.64,35.65ZM312.01,95.82l.04-35.93c-.24-6.71-5.13-11.89-12.15-11.97H36.16c-6.9.07-12.12,5.24-12.12,11.97v35.94s287.97,0,287.97,0ZM300.27,311.4c7.02-.48,11.76-5.4,11.76-12.09V119.78s-287.99,0-287.99,0l-.02,179.54c0,6.97,5.26,11.89,12.14,12.08h264.1Z" />
      <path d="M100.1,212.7c-5.09-5.08-5.22-12.34-.56-17.24,4.3-4.53,12.11-5.06,16.94-.24l28.16,28.06,76.88-65.7c5.12-4.37,13.18-1.82,16.43,2.67,3.93,5.42,2.92,12.23-2.29,16.68l-83.45,71.39c-5.36,4.59-12.26,4.15-17.1-.68l-35.02-34.94Z" />
    </svg>
  );
}

// PayLaterIcon — bespoke "deferred clock" mark used on every Pay on
// the day CTA. Custom artwork (a clock face with a counterclockwise
// arrow over its top-left, suggesting "later") replaces Lucide's
// CalendarClock so the secondary path carries the same brand
// identity as the primary commit. Same currentColor convention as
// BookCheckIcon — paints accent inside the outlined pill, white
// inside the primary NextButton, no per-call-site overrides.
function PayLaterIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 19.79 20.44"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden
      focusable="false"
    >
      <path d="M9.56,20.44c-2.7,0-5.25-1.04-7.18-2.92-.51-.5-.58-1.21-.16-1.74.23-.29.6-.46.98-.46.33,0,.62.12.84.34,1.47,1.47,3.43,2.28,5.51,2.28s3.92-.76,5.37-2.15c3.04-2.92,3.16-7.79.29-10.86-1.45-1.55-3.52-2.44-5.66-2.44-1.94,0-3.8.72-5.23,2.03l-.29.29h1.74c.33,0,.64.14.88.38.24.24.36.58.35.91-.02.68-.58,1.21-1.26,1.21H1.29c-.34,0-.66-.12-.9-.35C.14,6.73,0,6.41,0,6.06V1.57c0-.67.53-1.22,1.2-1.25h0c.74,0,1.3.56,1.3,1.24v1.24s.1-.1.1-.1C4.5.96,6.96,0,9.55,0s5.2,1.01,7.11,2.86c1.98,1.91,3.09,4.47,3.13,7.22.04,2.75-1,5.35-2.93,7.31-1.93,1.97-4.53,3.05-7.3,3.05Z" />
      <path d="M13.69,14.48c-.25,0-.48-.08-.68-.23l-3.86-3.08c-.27-.21-.44-.58-.44-.94v-4.49c0-.68.53-1.23,1.21-1.25h0c.64,0,1.28.48,1.28,1.2v3.93s3.27,2.61,3.27,2.61c.51.41.63,1.13.27,1.68-.22.34-.65.58-1.06.58Z" />
    </svg>
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
  shimmer = false,
}: {
  disabled: boolean;
  onClick: () => void;
  accent: string;
  children: React.ReactNode;
  /** Slow white-gradient sweep across the pill. Used on the Pay
   *  button so the conversion moment feels inviting; the rest of
   *  the flow's Continue buttons stay still. */
  shimmer?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={shimmer && !disabled ? 'vlounge-pay-shimmer' : undefined}
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
      {/* z-index 2 so the label sits ABOVE the .vlounge-pay-shimmer
          ::before overlay (z-index 1) when the shimmer is on.
          Harmless when shimmer is off. */}
      <span style={{ position: 'relative', zIndex: 2 }}>{children}</span>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

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
