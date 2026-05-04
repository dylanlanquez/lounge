import { useMemo, useState, type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { theme } from '../theme/index.ts';
import { useIsMobile } from '../lib/useIsMobile.ts';
import {
  type BookingStateApi,
  formatPrice,
  stepTitle,
  useBookingState,
} from './state.ts';
import { useWidgetCopy, type WidgetCopy } from './copy.ts';
import { useWidgetLocations, type WidgetLocation } from './data.ts';
import { LocationStep } from './steps/Location.tsx';
import { ServiceStep } from './steps/Service.tsx';
import { AxisStep } from './steps/Axis.tsx';
import { UpgradesStep } from './steps/Upgrades.tsx';
import { TimeStep } from './steps/Time.tsx';
import { DetailsStep } from './steps/Details.tsx';
import { PaymentStep } from './steps/Payment.tsx';
import { SuccessScreen } from './steps/Success.tsx';
import { Summary } from './Summary.tsx';
import { submitBooking, SubmitError } from './submit.ts';
import {
  loadRememberedIdentity,
} from './state.ts';
import { rememberBookingToken, useRememberedBookings } from './rememberedBookings.ts';
import { WelcomeBack } from './WelcomeBack.tsx';
import { isDetailsValid } from './validation.ts';
import type { AxisKey } from '../lib/queries/bookingTypeAxes.ts';

// Public booking widget — embedded on the practice's website.
//
// Stands alone from the staff app: no kiosk status bar, no bottom
// nav, no auth gate. Reads its data from the widget/data.ts
// constants for now (phase 1). Phase 2 will swap them for live reads
// once the public-read RLS policies are in place.
//
// Layout:
//
//   ┌────────────────────────────────────────────────────────────┐
//   │ ← Step title                              Step 2 of 4 ◐   │
//   ├──────────────────────────────────────┬─────────────────────┤
//   │                                      │                     │
//   │ Step content                         │ Booking summary     │
//   │ (Location / Service / Axis steps /   │ (location, service, │
//   │  Time / Details / Payment)           │  axes chain, time)  │
//   │                                      │                     │
//   └──────────────────────────────────────┴─────────────────────┘
//
// Mobile collapses to a single column, with the summary docked to
// the bottom of the viewport in a sticky container that the patient
// can tap to expand. The summary takes back its full sidebar role
// at >= 880px wide.

const SIDEBAR_WIDTH = 320;
const TWO_COLUMN_BREAKPOINT = 880;

export function Widget() {
  // Live reads of locations + copy. We gate the first render on
  // both, so the page never flashes a "Welcome, pick a location"
  // header for half a second before stepping into a deep-linked
  // service flow (no-flicker rule). The booking-types and slots
  // queries each have their own per-step loading state and don't
  // block the shell.
  const locationsResult = useWidgetLocations();
  const { copy, loading: copyLoading } = useWidgetCopy();
  const isMobile = useIsMobile(TWO_COLUMN_BREAKPOINT);

  if (locationsResult.loading || copyLoading || !locationsResult.data) {
    return <BootScreen error={locationsResult.error} />;
  }

  return (
    <WidgetReady
      locations={locationsResult.data}
      copy={copy}
      isMobile={isMobile}
    />
  );
}

function WidgetReady({
  locations,
  copy,
  isMobile,
}: {
  locations: WidgetLocation[];
  copy: WidgetCopy;
  isMobile: boolean;
}) {
  // ?location=<uuid> deep-link: when an embed pins the widget to a
  // specific clinic, pre-select it and the engine drops Step 1.
  // Read once on mount; we don't react to URL changes mid-session.
  const preSelected = useMemo<WidgetLocation | null>(() => {
    if (typeof window === 'undefined') return null;
    const param = new URLSearchParams(window.location.search).get('location');
    if (!param) return null;
    return locations.find((l) => l.id === param) ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Returning-patient gate: when localStorage holds tokens that
  // resolve to upcoming-active bookings, we show a welcome screen
  // first. The patient picks "Manage" to deep-link into the manage
  // page, or "Book another" to drop into the normal flow. Skipped
  // for ?location= deep-links — those embeds are pinned to a single
  // clinic-page CTA and a welcome screen would feel like a detour.
  const remembered = useRememberedBookings();
  const [mode, setMode] = useState<'welcome' | 'booking'>('welcome');
  const showWelcome =
    mode === 'welcome' && !preSelected && !remembered.loading && remembered.data.length > 0;
  const greetingName = useMemo(() => {
    const stored = loadRememberedIdentity();
    if (stored?.firstName?.trim()) return stored.firstName.trim();
    const fromBooking = remembered.data.find((b) => b.patientFirstName);
    return fromBooking?.patientFirstName ?? null;
  }, [remembered.data]);

  // Hooks below run for both modes — calling useBookingState
  // unconditionally keeps the hook order stable across renders.
  const api = useBookingState(locations, preSelected);
  const [submission, setSubmission] = useState<{
    state: 'idle' | 'submitting' | 'done';
    appointmentRef: string | null;
    error: string | null;
  }>({ state: 'idle', appointmentRef: null, error: null });

  // Single submission entry-point. Called from:
  //   • Summary CTA on Details step when no Payment step follows
  //     (free service — book straight away).
  //   • Mobile dock CTA, same conditions.
  //   • Payment step's onPaid handler after Stripe confirms the
  //     PaymentIntent — paymentIntentId is forwarded so the edge
  //     function can verify the charge before persisting.
  //
  // On 'slot_unavailable' the slot was taken between time pick and
  // submit — bounce back to the time step so the patient picks
  // again. Other errors surface as a banner + leave them where
  // they are.
  const submit = async (paymentIntentId: string | null = null) => {
    if (submission.state === 'submitting') return;
    setSubmission({ state: 'submitting', appointmentRef: null, error: null });
    try {
      const result = await submitBooking(api.state, paymentIntentId);
      // Stash the manage token locally so a returning visit can
      // recall this booking on Step 1 — see WelcomeBack screen.
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
        error: messageForCode(err.code) ?? "Couldn't book your appointment. Please try again.",
      });
    }
  };

  if (submission.state === 'done') {
    return <SuccessScreen state={api.state} appointmentRef={submission.appointmentRef} />;
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

  // The Summary / Dock CTA submits directly when Details is the last
  // step. Otherwise it advances to whatever step (Payment) comes next.
  const isPaymentNext = (api.activeSteps[api.currentIdx + 1] ?? null) === 'payment';
  const onCtaClick = isPaymentNext ? api.goNext : () => submit(null);
  const ctaBusy = !isPaymentNext && submission.state === 'submitting';
  // The Details CTA gates on the same validity rules the inline
  // errors use — single source of truth in widget/validation.ts.
  // Stays disabled until every required field is valid AND terms
  // are agreed.
  const ctaDisabled = api.stepKey === 'details' && !isDetailsValid(api.state.details);

  return (
    <div
      style={{
        // The widget owns the entire viewport when standalone, but
        // also sits naturally inside an iframe at any size. min-height
        // 100dvh keeps it tall in standalone use; the iframe parent
        // controls actual height when embedded.
        minHeight: '100dvh',
        background: theme.color.bg,
        color: theme.color.ink,
        fontFamily: theme.type.family,
        // Hide the browser's smooth-scroll snap if it bleeds in from
        // ancestor styles when embedded. The widget's own scroll is
        // a normal page scroll.
        scrollSnapType: 'none',
      }}
    >
      <Header
        title={stepTitle(api.stepKey, copy)}
        currentIdx={api.currentIdx}
        totalSteps={api.totalSteps}
        canGoBack={api.currentIdx > 0}
        onBack={api.goBack}
      />

      <main
        style={{
          maxWidth: 1080,
          margin: '0 auto',
          padding: isMobile
            ? `${theme.space[4]}px ${theme.space[4]}px ${theme.space[8]}px`
            : `${theme.space[5]}px ${theme.space[6]}px ${theme.space[8]}px`,
          display: 'grid',
          gridTemplateColumns: isMobile ? '1fr' : `1fr ${SIDEBAR_WIDTH}px`,
          gap: isMobile ? theme.space[5] : theme.space[6],
          alignItems: 'start',
        }}
      >
        <section>
          {submission.error ? (
            <ErrorBanner message={submission.error} onDismiss={() => setSubmission((s) => ({ ...s, error: null }))} />
          ) : null}
          <StepContent
            api={api}
            locations={locations}
            onSubmit={submit}
            submitting={submission.state === 'submitting'}
          />
        </section>

        {isMobile ? (
          <MobileSummaryDock
            api={api}
            copy={copy}
            onCtaClick={onCtaClick}
            ctaBusy={ctaBusy}
            ctaDisabled={ctaDisabled}
            isPaymentNext={isPaymentNext}
          />
        ) : (
          <aside style={{ position: 'sticky', top: theme.space[5] }}>
            <Summary
              state={api.state}
              upgrades={api.upgrades}
              resolvedRow={api.resolvedRow}
              breakdown={api.priceBreakdown}
              copy={copy}
              showCta={api.stepKey === 'details'}
              onCtaClick={onCtaClick}
              ctaBusy={ctaBusy}
              ctaDisabled={ctaDisabled}
              isPaymentNext={isPaymentNext}
            />
          </aside>
        )}
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Header — back arrow, title, circular progress
// ─────────────────────────────────────────────────────────────────────────────

function Header({
  title,
  currentIdx,
  totalSteps,
  canGoBack,
  onBack,
}: {
  title: string;
  currentIdx: number;
  totalSteps: number;
  canGoBack: boolean;
  onBack: () => void;
}) {
  return (
    <header
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 10,
        background: theme.color.bg,
        borderBottom: `1px solid ${theme.color.border}`,
      }}
    >
      <div
        style={{
          maxWidth: 1080,
          margin: '0 auto',
          padding: `${theme.space[4]}px ${theme.space[5]}px`,
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[3],
        }}
      >
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          disabled={!canGoBack}
          style={{
            appearance: 'none',
            border: 'none',
            background: 'transparent',
            width: 36,
            height: 36,
            borderRadius: theme.radius.pill,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: canGoBack ? theme.color.ink : theme.color.inkSubtle,
            cursor: canGoBack ? 'pointer' : 'default',
            opacity: canGoBack ? 1 : 0,
            transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, opacity ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            if (!canGoBack) return;
            e.currentTarget.style.background = theme.color.surface;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
          }}
        >
          <ArrowLeft size={18} aria-hidden />
        </button>
        <h1
          aria-live="polite"
          aria-atomic="true"
          style={{
            margin: 0,
            fontSize: theme.type.size.xl,
            fontWeight: theme.type.weight.semibold,
            letterSpacing: theme.type.tracking.tight,
            color: theme.color.ink,
            flex: 1,
            minWidth: 0,
          }}
        >
          {title}
        </h1>
        <ProgressDot currentIdx={currentIdx} totalSteps={totalSteps} />
      </div>
    </header>
  );
}

function ProgressDot({
  currentIdx,
  totalSteps,
}: {
  currentIdx: number;
  totalSteps: number;
}) {
  // Circular progress drawn with two stacked SVG arcs. The lower arc
  // is the muted track; the upper arc fills clockwise from 12 o'clock
  // proportional to (currentIdx + 1) / totalSteps.
  const size = 18;
  const stroke = 3;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = ((currentIdx + 1) / totalSteps) * circumference;
  const stepNumber = currentIdx + 1;
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: theme.space[2],
        flexShrink: 0,
      }}
    >
      <span
        style={{
          fontSize: 11,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.inkMuted,
          textTransform: 'uppercase',
          letterSpacing: theme.type.tracking.wide,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        Step {stepNumber} of {totalSteps}
      </span>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden
        style={{ transform: 'rotate(-90deg)' }}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={theme.color.border}
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={theme.color.accent}
          strokeWidth={stroke}
          strokeDasharray={`${filled} ${circumference}`}
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step router — picks the active step component
// ─────────────────────────────────────────────────────────────────────────────

function StepContent({
  api,
  locations,
  onSubmit,
  submitting,
}: {
  api: BookingStateApi;
  locations: WidgetLocation[];
  onSubmit: (paymentIntentId: string | null) => void;
  submitting: boolean;
}) {
  // Axis steps are dynamic — one per axis declared on the chosen
  // service, encoded as `axis:<key>` strings (axis:product_key,
  // axis:arch, etc). Branch on the prefix and pull the axis key out.
  if (api.stepKey.startsWith('axis:')) {
    const axisKey = api.stepKey.slice(5) as AxisKey;
    return <AxisStep api={api} axisKey={axisKey} />;
  }
  switch (api.stepKey) {
    case 'location':
      return <LocationStep api={api} locations={locations} />;
    case 'service':
      return <ServiceStep api={api} />;
    case 'upgrades':
      return <UpgradesStep api={api} upgrades={api.upgrades} />;
    case 'time':
      return <TimeStep api={api} />;
    case 'details':
      return <DetailsStep api={api} />;
    case 'payment':
      return (
        <PaymentStep api={api} onPaid={(pi) => onSubmit(pi)} submitting={submitting} />
      );
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mobile summary dock — sticky bottom bar that expands on tap
// ─────────────────────────────────────────────────────────────────────────────

function MobileSummaryDock({
  api,
  copy,
  onCtaClick,
  ctaBusy,
  ctaDisabled,
  isPaymentNext,
}: {
  api: BookingStateApi;
  copy: WidgetCopy;
  onCtaClick: () => void;
  ctaBusy: boolean;
  ctaDisabled: boolean;
  isPaymentNext: boolean;
}) {
  const { priceBreakdown } = api;
  const total =
    priceBreakdown.depositPence > 0
      ? priceBreakdown.depositPence
      : priceBreakdown.subtotalPence;
  const showSummary =
    api.stepKey === 'time' ||
    api.stepKey === 'details' ||
    api.stepKey === 'payment';
  // The details step hosts the primary CTA; on mobile it lives in
  // the dock so it sits above the keyboard.
  const showDetailsCta = api.stepKey === 'details';

  if (!showSummary && !showDetailsCta) return null;

  return (
    <div
      style={{
        position: 'sticky',
        bottom: 0,
        zIndex: 20,
        marginTop: theme.space[5],
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}
    >
      <div
        style={{
          background: theme.color.surface,
          borderTop: `1px solid ${theme.color.border}`,
          padding: `${theme.space[3]}px ${theme.space[4]}px`,
          boxShadow: theme.shadow.overlay,
          borderRadius: `${theme.radius.input}px ${theme.radius.input}px 0 0`,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: theme.space[3],
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <p
              style={{
                margin: 0,
                fontSize: 11,
                fontWeight: theme.type.weight.semibold,
                color: theme.color.inkMuted,
                textTransform: 'uppercase',
                letterSpacing: theme.type.tracking.wide,
              }}
            >
              {copy.summaryTotalLabel}
            </p>
            <p
              style={{
                margin: `${theme.space[1]}px 0 0`,
                fontSize: theme.type.size.lg,
                fontWeight: theme.type.weight.semibold,
                color: theme.color.ink,
                fontVariantNumeric: 'tabular-nums',
                letterSpacing: theme.type.tracking.tight,
              }}
            >
              {formatPrice(total)}
            </p>
          </div>
          {showDetailsCta ? (
            <button
              type="button"
              onClick={onCtaClick}
              disabled={ctaBusy || ctaDisabled}
              style={{
                ...primaryCtaStyle,
                opacity: ctaBusy || ctaDisabled ? 0.5 : 1,
                cursor: ctaBusy || ctaDisabled ? 'default' : 'pointer',
              }}
            >
              {ctaBusy ? 'Booking…' : isPaymentNext ? copy.summaryCtaPayment : copy.summaryCtaBook}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function BootScreen({ error }: { error: string | null }) {
  // Shown while locations + copy are loading on first mount. Plain
  // and quiet — most loads complete in <300ms so flashing a big
  // spinner just adds noise.
  return (
    <div
      style={{
        minHeight: '100dvh',
        background: theme.color.bg,
        color: theme.color.inkMuted,
        fontFamily: theme.type.family,
        fontSize: theme.type.size.sm,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: theme.space[5],
      }}
    >
      {error ? (
        <p style={{ margin: 0, color: theme.color.alert, fontWeight: theme.type.weight.semibold }}>
          Couldn't reach the booking system. Please refresh the page.
        </p>
      ) : (
        <span aria-live="polite">Loading…</span>
      )}
    </div>
  );
}

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      role="alert"
      style={{
        marginBottom: theme.space[4],
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        background: 'rgba(184, 58, 42, 0.08)',
        border: `1px solid ${theme.color.alert}`,
        borderRadius: theme.radius.input,
        color: theme.color.alert,
        fontSize: theme.type.size.sm,
        fontWeight: theme.type.weight.semibold,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space[3],
      }}
    >
      <span>{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        style={{
          appearance: 'none',
          border: 'none',
          background: 'transparent',
          color: 'inherit',
          fontSize: theme.type.size.lg,
          fontWeight: theme.type.weight.semibold,
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
      return "Please complete payment before booking.";
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

const primaryCtaStyle = {
  appearance: 'none',
  border: 'none',
  background: theme.color.ink,
  color: theme.color.surface,
  padding: `${theme.space[3]}px ${theme.space[4]}px`,
  borderRadius: theme.radius.pill,
  fontFamily: 'inherit',
  fontSize: theme.type.size.sm,
  fontWeight: theme.type.weight.semibold,
  cursor: 'pointer',
  flexShrink: 0,
} as const;

export function PrimaryCta({
  children,
  onClick,
  disabled,
  fullWidth,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  fullWidth?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        ...primaryCtaStyle,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'default' : 'pointer',
        width: fullWidth ? '100%' : undefined,
        height: 48,
      }}
    >
      {children}
    </button>
  );
}

