import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ArrowLeft, X } from 'lucide-react';
import { PaymentStep, type PaymentApi } from './steps/Payment.tsx';
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
  configFor,
  useWidgetProductConfig,
  type ProductWidgetConfig,
} from '../../lib/queries/productWidgetConfig.ts';
import {
  useResolvedCatalogueRow,
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
import { ReviewStep } from './steps/Review.tsx';
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
  /** When true, the same-day appliance product picker renders an
   *  extra cross-service "Click-in veneers" card. Driven by the
   *  embed dataset (data-include-click-in="1"). Defaults false. */
  includeClickIn?: boolean;
}

export interface WidgetProps {
  embedded?: boolean;
  brand?: WidgetBrand;
  prefill?: WidgetPrefill;
  /** Provided by the modal host (embedHost.ts via the brand main.tsx
   *  mount API) so the close button inside the widget header can fire
   *  the same close path as Esc / backdrop click. Omitted for the
   *  standalone /book route where there's no modal to close. */
  onClose?: () => void;
}

export function Widget({ brand, prefill, onClose }: WidgetProps = {}) {
  // Gate the first render on locations + booking types + copy + the
  // per-service-type widget config (drives smile-photos intake +
  // upgrades step visibility). All four loads are independent and
  // run in parallel; we just hold rendering until they all settle so
  // a deep-linked service has its matching booking-type object AND
  // its per-service flags resolved before useBookingState seeds
  // initial state.
  const locationsResult = useWidgetLocations();
  const bookingTypesResult = useWidgetBookingTypes();
  const { copy, loading: copyLoading } = useWidgetCopy();
  const productConfigResult = useWidgetProductConfig();

  if (
    locationsResult.loading ||
    bookingTypesResult.loading ||
    copyLoading ||
    productConfigResult.loading ||
    !locationsResult.data ||
    !bookingTypesResult.data ||
    !productConfigResult.data
  ) {
    return (
      <BootScreen
        error={
          locationsResult.error ??
          bookingTypesResult.error ??
          productConfigResult.error
        }
      />
    );
  }

  return (
    <WidgetReady
      locations={locationsResult.data}
      bookingTypes={bookingTypesResult.data}
      copy={copy}
      brand={brand}
      prefill={prefill}
      productConfig={productConfigResult.data}
      onClose={onClose}
    />
  );
}

function WidgetReady({
  locations,
  bookingTypes,
  copy,
  brand,
  prefill,
  productConfig,
  onClose,
}: {
  locations: WidgetLocation[];
  bookingTypes: WidgetBookingType[];
  copy: WidgetCopy;
  brand?: WidgetBrand;
  prefill?: WidgetPrefill;
  /** Map service_type → per-service-type widget toggles. Drives
   *  the upgrades-step gate (show_upgrades) and the success-screen
   *  photo-intake gate (request_smile_photos). */
  productConfig: Record<string, ProductWidgetConfig>;
  onClose?: () => void;
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

  // Pre-mount catalogue lookup for the prefilled product. When a
  // Shopify trigger ships a product_key, useBookingState's
  // state.useState initialiser needs to know that product's
  // catalogue arch_match BEFORE it runs — otherwise initialStepFor
  // would land the patient on the arch step for a product whose
  // arch_match isn't 'single' (e.g. whitening_kit, which is upper
  // & lower by default and shouldn't ask the question at all). The
  // resolver fires once per mount based on prefill values only;
  // useBookingState owns the in-flow resolver that tracks ongoing
  // product changes. The two are intentionally separate concerns
  // — one decides the initial flow shape, the other tracks
  // mid-flow selection — and both cache through Supabase's row
  // cache so the duplicate request is essentially free.
  const prefillResolver = useResolvedCatalogueRow({
    serviceType: resolvedPrefill.service?.serviceType ?? null,
    productKey: resolvedPrefill.axes.product_key ?? null,
    repairVariant: resolvedPrefill.axes.repair_variant ?? null,
  });

  // Gate the mount of useBookingState (which happens inside
  // BookingFlow below) until the prefill resolver returns. Only
  // gates when there's a product_key to resolve — flows without a
  // prefilled product don't need the resolver to decide the
  // initial step. Once the patient picks a product through the
  // widget's own step, setAxisPin captures arch_match synchronously
  // and no gating is needed there either.
  if (resolvedPrefill.axes.product_key && prefillResolver.loading) {
    return <BootScreen error={null} />;
  }

  // Enrich the prefill with the resolver's arch_match before
  // mounting BookingFlow. activeStepsFor reads
  // state.axes.product_arch_match to decide whether to ask the
  // arch question; threading it through here means the very first
  // paint of the stepper is correct, with no orphan stepKey
  // requiring a post-mount re-sync.
  const enrichedPrefill: ResolvedPrefill = {
    ...resolvedPrefill,
    axes: {
      ...resolvedPrefill.axes,
      product_arch_match:
        prefillResolver.data?.archMatch ??
        resolvedPrefill.axes.product_arch_match,
    },
  };

  return (
    <BookingFlow
      locations={locations}
      copy={copy}
      brand={brand}
      productConfig={productConfig}
      onClose={onClose}
      prefill={enrichedPrefill}
      includeClickIn={prefill?.includeClickIn === true}
    />
  );
}

// Inner component that owns useBookingState and the entire stepper
// render. Mounted by WidgetReady once the prefilled product's
// catalogue arch_match is known, so initialStepFor sees the truth
// on its very first call instead of needing a post-mount sync.
function BookingFlow({
  locations,
  copy,
  brand,
  productConfig,
  onClose,
  prefill: resolvedPrefill,
  includeClickIn,
}: {
  locations: WidgetLocation[];
  copy: WidgetCopy;
  brand?: WidgetBrand;
  productConfig: Record<string, ProductWidgetConfig>;
  onClose?: () => void;
  /** Fully resolved by WidgetReady — includes product_arch_match
   *  from the pre-mount catalogue lookup so useBookingState's state
   *  initialiser has everything it needs synchronously. */
  prefill: ResolvedPrefill;
  /** Pass-through opt-in for the cross-service Click-in veneers
   *  card on the same-day product picker. Driven by the embed's
   *  data-include-click-in flag — not part of ResolvedPrefill
   *  because it's a render hint, not a state seed. */
  includeClickIn: boolean;
}) {
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

  const api = useBookingState(locations, resolvedPrefill, productConfig);
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

  // Success state — once the booking has landed, flip
  // data-state="success" on the modal root. The embedHost
  // stylesheet's @media (min-width: 768px) rule shrinks the card
  // down to a compact 480px wide × auto-height footprint via a
  // 450ms transition, so the confirmation screen sits centred on
  // desktop rather than floating in a sea of empty surface.
  // Phones (< 768px) ignore the rule and keep the full-sheet card.
  const success = submission.state === 'done';
  useEffect(() => {
    const modalRoot =
      typeof document !== 'undefined'
        ? document.getElementById('vlounge-embed-modal')
        : null;
    if (!modalRoot) return;
    if (success) {
      modalRoot.dataset.state = 'success';
    } else {
      // Clear the attribute when the success screen unmounts (e.g.
      // the patient closes and re-opens for a new booking on the
      // standalone /book route, where the React tree persists).
      delete modalRoot.dataset.state;
    }
    return () => {
      // Defence on unmount: never leave the attribute hanging if
      // the widget is torn down mid-success.
      const m =
        typeof document !== 'undefined'
          ? document.getElementById('vlounge-embed-modal')
          : null;
      if (m) delete m.dataset.state;
    };
  }, [success]);

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
        resolvedCatalogueName={api.resolvedRow?.name ?? null}
        upgrades={api.upgrades}
        priceBreakdown={api.priceBreakdown}
        appointmentRef={submission.appointmentRef}
        appointmentId={submission.appointmentId}
        manageToken={submission.manageToken}
        brand={brand}
        requestSmilePhotos={
          configFor(
            api.state.service?.serviceType,
            api.state.axes.product_key ?? null,
            productConfig,
          ).request_smile_photos
        }
        onClose={onClose}
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
  // - 'review'  → routes on api.state.paymentChoice (set by the
  //   PaymentChoiceCard inside the review step): full / deposit
  //   walks into the Stripe step, on-the-day submits directly.
  //   Free services fall through the same branch — paymentChoice
  //   stays null and we submit.
  // - 'details' → plain advance to 'review' via goNext
  // - other steps → goNext
  const onFooterNext = () => {
    if (api.stepKey === 'payment') {
      paymentRef.current?.pay();
      return;
    }
    if (api.stepKey === 'review') {
      const total = api.priceBreakdown.subtotalPence;
      if (total === 0) {
        // Free service — no choice, commit directly.
        submit(null, null);
        return;
      }
      const choice = api.state.paymentChoice;
      if (choice === 'pay_full' || choice === 'pay_deposit') {
        api.goTo('payment');
        return;
      }
      if (choice === 'pay_on_the_day') {
        submit(null, 'on_the_day');
        return;
      }
      // Defensive: paid service with no choice picked. The footer's
      // disabled state should prevent this branch from firing, but
      // if it ever does, do nothing — the user can pick an option
      // in the PaymentChoiceCard and try again.
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
      includeClickIn={includeClickIn}
      onNext={onFooterNext}
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
      onClose={onClose}
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
  includeClickIn,
  onNext,
  onSubmit,
  submitting,
  submissionError,
  onDismissError,
  paymentRef,
  paymentReady,
  paymentPaying,
  onPaymentReadyChange,
  onPaymentPayingChange,
  onClose,
}: {
  api: BookingStateApi;
  copy: WidgetCopy;
  brand?: WidgetBrand;
  locations: WidgetLocation[];
  /** Pass-through from prefill — gates the cross-service Click-in
   *  veneers card on the same-day product picker. */
  includeClickIn: boolean;
  onNext: () => void;
  onSubmit: (paymentIntentId: string | null) => void;
  submitting: boolean;
  submissionError: string | null;
  onDismissError: () => void;
  paymentRef: React.MutableRefObject<PaymentApi | null>;
  paymentReady: boolean;
  paymentPaying: boolean;
  onPaymentReadyChange: (ready: boolean) => void;
  onPaymentPayingChange: (paying: boolean) => void;
  onClose?: () => void;
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
      {/* Header is now a single flex row: progress bar grows to fill,
          close × sits at the right. alignItems:center pairs the bar's
          vertical centre with the button's, so the close glyph is
          horizontally on the same line as the bar without any pixel-
          tuned absolute coordinates. Previous structure positioned
          the close button absolutely against the card and the row
          re-broke every time header padding changed. */}
      <header
        style={{
          flexShrink: 0,
          padding: '18px 20px 10px 20px',
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 16,
        }}
      >
        <ProgressBar
          value={api.visibleCurrentIdx + 1}
          total={api.visibleTotalSteps}
          still={api.stepKey === 'payment'}
        />
        {onClose ? <CloseButton onClick={onClose} /> : null}
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
            includeClickIn={includeClickIn}
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
        paymentReady={paymentReady}
        paymentPaying={paymentPaying}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Close button — flex sibling of ProgressBar inside the header.
// ─────────────────────────────────────────────────────────────────────────────
//
// Lives in React (not in embedHost.ts vanilla DOM) so it can share the
// header's flex row with the ProgressBar. alignItems:center on the
// header keeps the × glyph horizontally aligned with the bar's
// vertical centre regardless of header padding or bar height.
//
// aria-label is preserved verbatim because the locked-state CSS rule
// in embedHost.ts targets `button[aria-label="Close booking"]` — the
// selector still matches when the button is rendered by React, so
// the modal's locked / disabled treatment survives the move.
//
// The lucide X icon at size=22 inside a 32×32 button gives a touch
// target that matches the original 32×32 textual × button (font-size
// 28, line-height 1) while keeping the glyph crisp at every density.
// Hover scale + opacity match the storefront retainer-cart close-vt.

function CloseButton({ onClick }: { onClick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);

  // Mirror embedHost's pre-React behaviour: focus lands on the close
  // button when the modal first becomes interactive, so keyboard
  // users have an immediate, predictable focus target inside the
  // modal. requestAnimationFrame defers one frame so React's render
  // commits before .focus() runs — otherwise the focus call can race
  // with the initial layout on slow phones.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      ref.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <button
      ref={ref}
      type="button"
      aria-label="Close booking"
      onClick={onClick}
      className="vlounge-close-btn"
      style={{
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 32,
        height: 32,
        padding: 0,
        background: 'transparent',
        border: 0,
        borderRadius: 0,
        color: '#333',
        cursor: 'pointer',
        // Hover/active styles live in CSS (vlounge-close-btn rules in
        // quizTokens.ts) so they only fire on hover-capable devices.
        // Inline mouse handlers caused the iOS first-tap-is-hover
        // trap on Next / Back; the close × inherits the fix.
        transition: 'transform 0.15s ease, opacity 0.15s ease',
      }}
    >
      <X size={22} strokeWidth={2} aria-hidden />
    </button>
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
        // Top margin only — the bottom-of-title-to-top-of-content
        // gap is owned by StepBody's flex `gap` (STEP_TITLE_BOTTOM_SPACE)
        // so every step shares the same rhythm. Doubling up via a
        // bottom margin here would stack on top of the gap and
        // produce per-step drift, which is the bug Dylan flagged
        // ("moving heights and margins between steps looks very
        // amateur"). Top stays at 16 — reduced from a historical
        // 32 so the title sits close to the progress bar on phones
        // instead of floating in a wide blank band.
        // `align='left'` keeps the same 720px centred column the
        // form below uses but flushes the text to the left so the
        // h2 sits over the first input — used on Details + Payment
        // where the body is form/card-like rather than option-grid.
        margin: '16px auto 0',
        maxWidth: 720,
        textAlign: align,
        fontSize: 24,
        lineHeight: 1.25,
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
  includeClickIn,
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
  /** When true, the same-day-appliance product picker renders an
   *  extra cross-service "Click-in veneers" card. Driven by the
   *  embed dataset (data-include-click-in="1") via WidgetPrefill. */
  includeClickIn: boolean;
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
  //
  // Review step now uses the shell-rendered title ("Booking summary")
  // — the previous "Your booking" heading inside the BookingReview
  // card has been removed so the receipt sits cleanly under the
  // standard StepTitle like every other step.
  const stepOwnsTitle =
    api.stepKey === 'repair:top' || api.stepKey === 'repair:bottom';
  // Single layout shell for every step: flex column with a fixed
  // gap between the title and the step content. Owning the gap
  // here means each step component renders with `marginTop: 0` and
  // doesn't get to invent its own title-to-content spacing — the
  // arch / repair / details / payment / review / service /
  // location steps all share the same rhythm. The previous
  // architecture had each step adding its own marginTop (or relying
  // on the title's bottom margin, which others doubled up on) and
  // drifted into the visible inconsistency Dylan flagged.
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: QUIZ.STEP_TITLE_BOTTOM_SPACE,
      }}
    >
      {stepOwnsTitle ? null : (
        <StepTitle align={titleAlign}>
          {stepTitle(api.stepKey, copy, api.state, api.resolvedRow?.name ?? null)}
        </StepTitle>
      )}
      {submissionError ? (
        <ErrorBanner message={submissionError} onDismiss={onDismissError} />
      ) : null}
      <StepRouter
        api={api}
        copy={copy}
        locations={locations}
        accent={accent}
        includeClickIn={includeClickIn}
        onSubmit={onSubmit}
        submitting={submitting}
        paymentRef={paymentRef}
        onPaymentReadyChange={onPaymentReadyChange}
        onPaymentPayingChange={onPaymentPayingChange}
      />
    </div>
  );
}

function StepRouter({
  api,
  copy,
  locations,
  accent,
  includeClickIn,
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
  includeClickIn: boolean;
  onSubmit: (paymentIntentId: string | null) => void;
  submitting: boolean;
  paymentRef: React.MutableRefObject<PaymentApi | null>;
  onPaymentReadyChange: (ready: boolean) => void;
  onPaymentPayingChange: (paying: boolean) => void;
}) {
  if (api.stepKey.startsWith('axis:')) {
    const axisKey = api.stepKey.slice(5) as AxisKey;
    return <AxisStep api={api} axisKey={axisKey} accent={accent} includeClickIn={includeClickIn} />;
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
      return <DetailsStep api={api} copy={copy} />;
    case 'review':
      return <ReviewStep api={api} copy={copy} accent={accent} />;
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
  submitting,
  paymentReady,
  paymentPaying,
}: {
  api: BookingStateApi;
  copy: WidgetCopy;
  accent: string;
  onNext: () => void;
  onBack: () => void;
  submitting: boolean;
  paymentReady: boolean;
  paymentPaying: boolean;
}) {
  const isPaymentStep = api.stepKey === 'payment';
  const isDetailsStep = api.stepKey === 'details';
  const isReviewStep = api.stepKey === 'review';
  const breakdown = api.priceBreakdown;
  const fullAmount = breakdown.subtotalPence;
  // Deposit info still surfaces on earlier-step FooterPrice as an
  // "if you'd like to pay the deposit only" preview. The actual
  // payment selector lives on the Review step (PaymentChoiceCard)
  // so the customer commits there, not here.
  const depositPence = api.state.service?.depositPence ?? 0;
  const showDepositCta = depositPence > 0;
  // Footer total line: hidden on Review (BookingReview shows the
  // full breakdown inline), Details (form-only, no commercial
  // context needed) and Payment (PayHeader spells it out and the
  // Pay button carries the amount). Everywhere else we'd surface a
  // single "Total" so the patient sees the running cost as soon as
  // the price is resolvable from the catalogue — UNLESS the booking
  // type's widget config has hideRunningTotal set, in which case the
  // price stays out of sight until the Review step. Default is
  // hidden (the seed migration ships every booking type with the
  // flag on); admin can opt a service in via the Widget tab.
  const hideRunningTotal = api.state.service?.hideRunningTotal ?? true;
  const showPrice =
    !isDetailsStep &&
    !isReviewStep &&
    !isPaymentStep &&
    !hideRunningTotal &&
    fullAmount > 0;

  const detailsValid = isNextEnabled(api);
  const summaryFree = isReviewStep && fullAmount === 0;
  // Paid-service Review step needs a payment choice picked before
  // Next commits. PaymentChoiceCard pre-selects a default on mount,
  // so this only blocks Next in the rare race window before the
  // effect lands.
  const summaryPaidWithoutChoice =
    isReviewStep && fullAmount > 0 && api.state.paymentChoice === null;

  const nextDisabled = isPaymentStep
    ? !paymentReady || paymentPaying || submitting
    : !detailsValid || submitting || summaryPaidWithoutChoice;

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
    if (isReviewStep) {
      // Free service — single commit action.
      if (fullAmount === 0) return copy.summaryCtaBook;
      const choice = api.state.paymentChoice;
      // Pay-on-the-day commits directly without a Stripe step, so the
      // verb is the booking commit. Full / deposit walk into the
      // Payment step, so the verb is "Next" — the actual commit lives
      // on the Pay button inside the Stripe card form.
      if (choice === 'pay_on_the_day') return copy.summaryCtaBook;
      return 'Next';
    }
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
        {api.canGoBack ? <BackButton onClick={onBack} /> : null}

        {/* Single context-aware Next / Book button. The label and
            commit verb flex on stepKey + paymentChoice (see
            nextLabel above); the click handler upstream routes to
            the payment step or fires submit based on the same
            choice. Pay-now / Pay-on-the-day live inside the
            details form (PaymentChoiceCard) so the footer stays a
            clean one-button commit row at every viewport. The
            shield icon + shimmer treatment is reserved for actual
            commit moments (free-service Book and Stripe Pay) — a
            mere "advance to Stripe step" Next doesn't earn it. */}
        <NextButton
          disabled={nextDisabled}
          onClick={onNext}
          accent={accent}
          shimmer={(summaryFree || isPaymentStep) && !submitting}
        >
          {submitting ? (
            nextLabel
          ) : isPaymentStep || summaryFree || (isReviewStep && api.state.paymentChoice === 'pay_on_the_day') ? (
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
      </div>
    </footer>
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
      viewBox="0 0 19.79 20.44"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden
      focusable="false"
    >
      <path d="M9.22,20.43C4.17,20.02.31,15.97.02,10.81c-.11-1.86.27-3.65,1.11-5.32C2.75,2.29,5.8.24,9.3.02,9.51,0,9.71,0,9.92,0,15.1,0,19.43,4.2,19.77,9.57l.02,1.3c-.02.15-.03.22-.03.3-.02.23-.05.52-.25.82-.25.36-.65.58-1.07.58-.15,0-.3-.03-.44-.08-.57-.21-.91-.79-.85-1.41.29-2.62-.79-5.24-2.82-6.83-1.29-1.01-2.82-1.55-4.43-1.55-1,0-1.96.21-2.88.61-1.89.84-3.31,2.4-4,4.4-.68,1.97-.53,4.17.41,6.02,1.26,2.49,3.74,4.03,6.47,4.03,1.37,0,2.72-.4,3.89-1.17.21-.14.46-.21.71-.21.42,0,.8.2,1.05.56.21.3.29.68.22,1.05-.06.35-.25.65-.53.84-1.33.89-2.89,1.44-4.53,1.59l-.15.03h-1.34Z" />
      <path d="M8.47,14.23c-.33,0-.64-.13-.87-.37l-2.37-2.44c-.25-.25-.38-.59-.37-.95,0-.37.16-.72.42-.97.24-.23.55-.36.87-.36.35,0,.69.15.96.42l1.37,1.42,4.23-4.37c.24-.25.56-.38.9-.38s.69.15.93.4c.52.54.5,1.37-.04,1.92l-5.09,5.26c-.26.27-.61.42-.96.42Z" />
    </svg>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  // Caller decides whether to render this at all (only when
  // api.canGoBack is true) so the Next button can stretch full-
  // width on step 1 instead of leaving an invisible 42px gap where
  // a back affordance would otherwise sit.
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Back"
      className="vlounge-back-btn"
      style={{
        border: 'none',
        width: 42,
        height: 42,
        minWidth: 32,
        padding: 0,
        borderRadius: '50%',
        cursor: 'pointer',
        background: QUIZ.PROGRESS_BACK_BG,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        color: QUIZ.ACCENT,
        // Hover/active styles live in CSS so they only fire on hover-
        // capable devices. See quizTokens.ts vlounge-back-btn rules
        // for the rationale (iOS first-tap-is-hover trap).
        transition: `all 0.2s ${QUIZ.EASE_CARD}`,
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
  const className = [
    'vlounge-next-btn',
    shimmer && !disabled ? 'vlounge-pay-shimmer' : null,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={className}
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
        // Hover styles live in CSS (see vlounge-next-btn rules in
        // quizTokens.ts) so they only kick in on devices that
        // actually support hover. The previous JS onMouseEnter /
        // onMouseLeave handlers caused the iOS "first tap triggers
        // hover, second tap fires click" hang — which is why the
        // Book appointment button felt broken on phones.
        transition: `all 0.2s ${QUIZ.EASE_CARD}`,
        opacity: disabled ? 0.4 : 1,
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
