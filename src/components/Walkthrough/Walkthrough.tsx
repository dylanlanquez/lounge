import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Button } from '../Button/Button.tsx';
import { theme } from '../../theme/index.ts';
import { useIsMobile } from '../../lib/useIsMobile.ts';

// A guided, cross-page product tour. Unlike a plain modal walkthrough,
// each step can spotlight a real element on the page (a dimmed backdrop
// with a soft cutout) and can send the user to another route first, so
// the tour can literally point at where things live and walk people
// through the pages they'll use.

export interface WalkthroughStep {
  // Eyebrow + icon shown at the top of the card.
  eyebrow: string;
  icon?: ReactNode;
  title: string;
  body: string;
  // CSS selector (a [data-tour="..."] hook) to spotlight. Omit for a
  // centered, modal-style step.
  target?: string;
  // Route to land on before this step shows. Omit to stay put.
  route?: string;
}

export interface WalkthroughTour {
  key: string;
  steps: WalkthroughStep[];
  // Where to send the user when the tour ends (done or skipped).
  finishRoute?: string;
}

interface StartOptions {
  onClose?: () => void;
}

interface WalkthroughContextValue {
  start: (tour: WalkthroughTour, opts?: StartOptions) => void;
  active: boolean;
}

const WalkthroughContext = createContext<WalkthroughContextValue | null>(null);

export function useWalkthrough(): WalkthroughContextValue {
  const ctx = useContext(WalkthroughContext);
  if (!ctx) throw new Error('useWalkthrough must be used inside <WalkthroughProvider>');
  return ctx;
}

const SPOTLIGHT_PAD = 8;
const CARD_W = 380;
const CARD_GAP = 16;

// Track a target element's on-screen rect while a step is active.
// Polls briefly for the element (it may still be mounting after a route
// change), then keeps the rect fresh on scroll / resize / layout shifts.
function useTargetRect(selector: string | undefined, stepKey: string): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!selector) {
      setRect(null);
      return;
    }
    let cancelled = false;
    let pollTimer = 0;
    let liveTimer = 0;
    let tries = 0;
    let el: Element | null = null;

    const measure = () => {
      if (!el || cancelled) return;
      setRect(el.getBoundingClientRect());
    };

    const onScrollResize = () => measure();

    const find = () => {
      if (cancelled) return;
      el = document.querySelector(selector);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        // Let the smooth scroll settle, then lock onto the element.
        liveTimer = window.setInterval(measure, 200);
        window.addEventListener('scroll', onScrollResize, true);
        window.addEventListener('resize', onScrollResize);
        measure();
        window.setTimeout(measure, 350);
      } else if (tries < 60) {
        tries += 1;
        pollTimer = window.setTimeout(find, 50);
      } else {
        setRect(null); // give up gracefully → step renders centered
      }
    };

    setRect(null);
    find();

    return () => {
      cancelled = true;
      window.clearTimeout(pollTimer);
      window.clearInterval(liveTimer);
      window.removeEventListener('scroll', onScrollResize, true);
      window.removeEventListener('resize', onScrollResize);
    };
  }, [selector, stepKey]);

  return rect;
}

function StepCard({
  step,
  index,
  total,
  rect,
  isMobile,
  onBack,
  onNext,
  onSkip,
}: {
  step: WalkthroughStep;
  index: number;
  total: number;
  rect: DOMRect | null;
  isMobile: boolean;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
}) {
  const isLast = index === total - 1;
  const width = isMobile ? undefined : CARD_W;

  // Position: centered when there's no target (or on mobile, where a
  // bottom sheet reads cleaner); otherwise tuck the card just below the
  // spotlight, flipping above when there isn't room, clamped to screen.
  let positionStyle: React.CSSProperties;
  if (!rect || isMobile) {
    positionStyle = {
      position: 'fixed',
      left: isMobile ? theme.space[4] : '50%',
      right: isMobile ? theme.space[4] : 'auto',
      bottom: isMobile ? `calc(${theme.space[6]}px + env(safe-area-inset-bottom, 0px))` : 'auto',
      top: isMobile ? 'auto' : '50%',
      transform: isMobile ? 'none' : 'translate(-50%, -50%)',
    };
  } else {
    const estHeight = 260;
    const below = rect.bottom + CARD_GAP;
    const placeBelow = below + estHeight < window.innerHeight;
    const top = placeBelow ? below : Math.max(CARD_GAP, rect.top - CARD_GAP - estHeight);
    const rawLeft = rect.left + rect.width / 2 - CARD_W / 2;
    const left = Math.min(
      Math.max(CARD_GAP, rawLeft),
      window.innerWidth - CARD_W - CARD_GAP,
    );
    positionStyle = { position: 'fixed', top, left };
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={step.title}
      style={{
        ...positionStyle,
        width,
        maxWidth: isMobile ? undefined : CARD_W,
        background: theme.color.surface,
        borderRadius: theme.radius.card,
        boxShadow: theme.shadow.overlay,
        padding: theme.space[5],
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[3],
        animation: `lng-dialog-in ${theme.motion.duration.base}ms ${theme.motion.easing.spring}`,
        pointerEvents: 'auto',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2] }}>
        {step.icon && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              borderRadius: theme.radius.pill,
              background: theme.color.accentBg,
              color: theme.color.accent,
              flexShrink: 0,
            }}
          >
            {step.icon}
          </span>
        )}
        <span
          style={{
            fontSize: theme.type.size.xs,
            fontWeight: theme.type.weight.semibold,
            letterSpacing: theme.type.tracking.wide,
            textTransform: 'uppercase',
            color: theme.color.inkSubtle,
          }}
        >
          {step.eyebrow}
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
        <h2
          style={{
            margin: 0,
            fontSize: theme.type.size.lg,
            fontWeight: theme.type.weight.semibold,
            letterSpacing: theme.type.tracking.tight,
            color: theme.color.ink,
          }}
        >
          {step.title}
        </h2>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.base,
            lineHeight: theme.type.leading.normal,
            color: theme.color.inkMuted,
          }}
        >
          {step.body}
        </p>
      </div>

      {/* Progress dots */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: theme.space[1] }}>
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            aria-hidden
            style={{
              width: i === index ? 20 : 7,
              height: 7,
              borderRadius: theme.radius.pill,
              background: i === index ? theme.color.accent : theme.color.border,
              transition: `width ${theme.motion.duration.base}ms ${theme.motion.easing.standard}`,
            }}
          />
        ))}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: theme.space[2],
          marginTop: theme.space[2],
        }}
      >
        <button
          type="button"
          onClick={onSkip}
          style={{
            border: 'none',
            background: 'none',
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: theme.type.size.sm,
            color: theme.color.inkSubtle,
            padding: theme.space[2],
            marginLeft: `-${theme.space[2]}px`,
          }}
        >
          Skip
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2] }}>
          {index > 0 && (
            <Button variant="secondary" size="sm" onClick={onBack}>
              Back
            </Button>
          )}
          <Button variant="primary" size="sm" onClick={onNext}>
            {isLast ? 'Done' : 'Next'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function WalkthroughOverlay({
  tour,
  index,
  onBack,
  onNext,
  onSkip,
}: {
  tour: WalkthroughTour;
  index: number;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
}) {
  const isMobile = useIsMobile(640);
  const step = tour.steps[index]!;
  const rect = useTargetRect(step.target, `${tour.key}:${index}`);

  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2000,
        pointerEvents: 'auto',
      }}
    >
      {/* Dimmed backdrop with a soft cutout around the target. */}
      <svg
        width="100%"
        height="100%"
        style={{ position: 'fixed', inset: 0, display: 'block' }}
        aria-hidden
      >
        <defs>
          <mask id="lng-walkthrough-mask">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            {rect && (
              <rect
                x={rect.left - SPOTLIGHT_PAD}
                y={rect.top - SPOTLIGHT_PAD}
                width={rect.width + SPOTLIGHT_PAD * 2}
                height={rect.height + SPOTLIGHT_PAD * 2}
                rx={theme.radius.card}
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect
          x="0"
          y="0"
          width="100%"
          height="100%"
          fill={theme.color.overlay}
          mask="url(#lng-walkthrough-mask)"
        />
        {rect && (
          <rect
            x={rect.left - SPOTLIGHT_PAD}
            y={rect.top - SPOTLIGHT_PAD}
            width={rect.width + SPOTLIGHT_PAD * 2}
            height={rect.height + SPOTLIGHT_PAD * 2}
            rx={theme.radius.card}
            fill="none"
            stroke={theme.color.surface}
            strokeWidth={2}
          />
        )}
      </svg>

      <StepCard
        step={step}
        index={index}
        total={tour.steps.length}
        rect={rect}
        isMobile={isMobile}
        onBack={onBack}
        onNext={onNext}
        onSkip={onSkip}
      />
    </div>,
    document.body,
  );
}

export function WalkthroughProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [tour, setTour] = useState<WalkthroughTour | null>(null);
  const [index, setIndex] = useState(0);
  const onCloseRef = useRef<(() => void) | undefined>(undefined);

  const goToStep = useCallback(
    (next: number) => {
      if (!tour) return;
      const step = tour.steps[next];
      if (step?.route) navigate(step.route);
      setIndex(next);
    },
    [tour, navigate],
  );

  const start = useCallback(
    (next: WalkthroughTour, opts?: StartOptions) => {
      onCloseRef.current = opts?.onClose;
      setTour(next);
      setIndex(0);
      const first = next.steps[0];
      if (first?.route) navigate(first.route);
    },
    [navigate],
  );

  const finish = useCallback(() => {
    const finishRoute = tour?.finishRoute;
    onCloseRef.current?.();
    onCloseRef.current = undefined;
    setTour(null);
    setIndex(0);
    if (finishRoute) navigate(finishRoute);
  }, [tour, navigate]);

  const onNext = useCallback(() => {
    if (!tour) return;
    if (index >= tour.steps.length - 1) finish();
    else goToStep(index + 1);
  }, [tour, index, finish, goToStep]);

  const onBack = useCallback(() => {
    if (index > 0) goToStep(index - 1);
  }, [index, goToStep]);

  // Escape skips the tour.
  useEffect(() => {
    if (!tour) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tour, finish]);

  const value = useMemo<WalkthroughContextValue>(
    () => ({ start, active: tour !== null }),
    [start, tour],
  );

  return (
    <WalkthroughContext.Provider value={value}>
      {children}
      {tour && (
        <WalkthroughOverlay
          tour={tour}
          index={index}
          onBack={onBack}
          onNext={onNext}
          onSkip={finish}
        />
      )}
    </WalkthroughContext.Provider>
  );
}
