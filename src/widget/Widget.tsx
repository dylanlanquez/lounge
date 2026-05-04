import { useState, type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { theme } from '../theme/index.ts';
import { useIsMobile } from '../lib/useIsMobile.ts';
import {
  type BookingStateApi,
  formatPrice,
  stepTitle,
  useBookingState,
} from './state.ts';
import { useWidgetCopy } from './copy.ts';
import { LocationStep } from './steps/Location.tsx';
import { ServiceStep } from './steps/Service.tsx';
import { AxisStep } from './steps/Axis.tsx';
import { UpgradesStep } from './steps/Upgrades.tsx';
import { TimeStep } from './steps/Time.tsx';
import { DetailsStep } from './steps/Details.tsx';
import { PaymentStep } from './steps/Payment.tsx';
import { SuccessScreen } from './steps/Success.tsx';
import { Summary } from './Summary.tsx';
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
  const api = useBookingState();
  const { copy } = useWidgetCopy();
  const isMobile = useIsMobile(TWO_COLUMN_BREAKPOINT);
  const [submitted, setSubmitted] = useSubmitted();

  if (submitted) {
    return <SuccessScreen state={api.state} />;
  }

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
          <StepContent api={api} onSubmit={() => setSubmitted(true)} />
        </section>

        {isMobile ? (
          <MobileSummaryDock api={api} />
        ) : (
          <aside style={{ position: 'sticky', top: theme.space[5] }}>
            <Summary
              state={api.state}
              upgrades={api.upgrades}
              showCta={api.stepKey === 'details'}
              onCtaClick={api.goNext}
              isPaymentNext={(api.activeSteps[api.currentIdx + 1] ?? null) === 'payment'}
            />
            <PoweredByLounge label={copy.footerPoweredBy} />
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
  onSubmit,
}: {
  api: BookingStateApi;
  onSubmit: () => void;
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
      return <LocationStep api={api} />;
    case 'service':
      return <ServiceStep api={api} />;
    case 'upgrades':
      return <UpgradesStep api={api} upgrades={api.upgrades} />;
    case 'time':
      return <TimeStep api={api} />;
    case 'details':
      return <DetailsStep api={api} />;
    case 'payment':
      return <PaymentStep api={api} onSubmit={onSubmit} />;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mobile summary dock — sticky bottom bar that expands on tap
// ─────────────────────────────────────────────────────────────────────────────

function MobileSummaryDock({ api }: { api: BookingStateApi }) {
  const total = api.state.service ? api.state.service.depositPence : 0;
  const showSummary =
    api.stepKey === 'time' ||
    api.stepKey === 'details' ||
    api.stepKey === 'payment';
  // Step 5 hosts the primary CTA; on mobile it lives in the dock so
  // it sits above the keyboard.
  const showDetailsCta = api.stepKey === 'details';
  const isPaymentNext = (api.activeSteps[api.currentIdx + 1] ?? null) === 'payment';

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
              {total > 0 ? 'Deposit today' : 'Total today'}
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
              onClick={api.goNext}
              style={primaryCtaStyle}
            >
              {isPaymentNext ? 'Continue to payment' : 'Book appointment'}
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

function useSubmitted(): [boolean, (next: boolean) => void] {
  const [submitted, setSubmitted] = useState(false);
  return [submitted, setSubmitted];
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

function PoweredByLounge({ label }: { label: string }) {
  if (!label) return null;
  return (
    <p
      style={{
        margin: `${theme.space[5]}px 0 0`,
        fontSize: 11,
        color: theme.color.inkSubtle,
        textAlign: 'center',
        textTransform: 'uppercase',
        letterSpacing: theme.type.tracking.wide,
      }}
    >
      {label}
    </p>
  );
}
