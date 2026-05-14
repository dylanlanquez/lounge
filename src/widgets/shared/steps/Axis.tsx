import { useEffect, useState } from 'react';
import {
  axesForService,
  type AxisDef,
  type AxisKey,
  type AxisValueOption,
  loadAxisValues,
} from '../../../lib/queries/bookingTypeAxes.ts';
import type { BookingServiceType } from '../../../lib/queries/bookingTypes.ts';
import type { BookingStateApi } from '../state.ts';
import { QUIZ } from '../quizTokens.ts';
import {
  OptionCard,
  OptionGrid,
  OptionTitle,
} from '../OptionCard.tsx';

// AxisStep — one axis question at a time (arch, product, repair
// variant). Same option-card visual pattern as Location and Service
// for consistency across the flow.
//
// Selection updates state via api.setAxisPin; the footer Next button
// is the sole navigation control (no auto-advance).

const AXIS_HELPER: Record<AxisKey, string> = {
  repair_variant: "We'll match you to the right specialist.",
  product_key:
    "Pick the option that fits — we'll confirm any details when you arrive.",
  // Arch step intentionally has NO helper paragraph — the step
  // title is descriptive enough ("Which teeth would you like to
  // cover?" / "Which retainer do you need?") and the options
  // themselves carry no sub-copy.
  arch: '',
};

export function AxisStep({
  api,
  axisKey,
  accent = QUIZ.ACCENT,
}: {
  api: BookingStateApi;
  axisKey: AxisKey;
  accent?: string;
}) {
  const service = api.state.service;
  if (!service) return null;
  const axes = axesForService(service.serviceType as BookingServiceType);
  const axis = axes.find((a) => a.key === axisKey) ?? null;
  if (!axis) return null;
  return <AxisOptions api={api} axis={axis} accent={accent} />;
}

function AxisOptions({
  api,
  axis,
  accent,
}: {
  api: BookingStateApi;
  axis: AxisDef;
  accent: string;
}) {
  const [options, setOptions] = useState<AxisValueOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setOptions(null);
    setError(null);
    (async () => {
      try {
        const opts = await loadAxisValues(axis);
        if (!cancelled) setOptions(opts);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : 'Could not load options');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [axis]);

  const currentValue =
    axis.key === 'repair_variant'
      ? api.state.axes.repair_variant
      : axis.key === 'product_key'
        ? api.state.axes.product_key
        : axis.key === 'arch'
          ? api.state.axes.arch
          : undefined;

  // Helper paragraph only when the axis has one (arch axis skips
  // it; product / repair-variant keep theirs). When there's no
  // helper we add a `marginTop` to the wrapper so the option grid
  // sits the same distance under the title as on steps with a
  // helper (32px gap == helper-bottom-to-grid-top), matching the
  // Time / Details / Payment / Service screens.
  const helper = AXIS_HELPER[axis.key];
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: helper ? 32 : 0,
        marginTop: helper ? 0 : 32,
      }}
    >
      {helper ? (
        <p
          style={{
            margin: 0,
            fontSize: 14,
            color: QUIZ.MUTED_2,
            lineHeight: 1.45,
            maxWidth: 600,
            textAlign: 'center',
            marginLeft: 'auto',
            marginRight: 'auto',
          }}
        >
          {helper}
        </p>
      ) : null}

      {error ? (
        <ErrorCard message={error} />
      ) : options === null ? (
        <SkeletonGrid />
      ) : options.length === 0 ? (
        <EmptyCard />
      ) : (
        <OptionGrid>
          {options.map((opt) => {
            const selected = currentValue === opt.key;
            const label = axis.key === 'arch'
              ? labelForArchOption(opt.key, api.state.service?.serviceType ?? '')
              : opt.label;
            return (
              <OptionCard
                key={opt.key}
                selected={selected}
                anySelected={!!currentValue}
                onSelect={() =>
                  api.setAxisPin(axis.key, opt.key, opt.archMatch)
                }
                accent={accent}
                ariaLabel={label}
              >
                <OptionTitle>{label}</OptionTitle>
              </OptionCard>
            );
          })}
        </OptionGrid>
      )}
    </div>
  );
}

// Arch-option label rewrite, scoped per service so the strings
// match the question wording above the grid. Click-in veneers
// asks about "teeth" so the upper/lower/both keys read as
// "Top / Bottom / Top & Bottom"; everything else reads as
// "Top / Bottom / Both" because the question is "Which retainer
// do you need?" — "Top & Bottom" doesn't fit that grammar.
function labelForArchOption(optKey: string, serviceType: string): string {
  if (optKey === 'upper') return 'Top';
  if (optKey === 'lower') return 'Bottom';
  if (optKey === 'both') {
    return serviceType === 'click_in_veneers' ? 'Top & Bottom' : 'Both';
  }
  return optKey;
}

function SkeletonGrid() {
  return (
    <OptionGrid>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          aria-hidden
          style={{
            width: '100%',
            maxWidth: '27rem',
            height: 130,
            background: QUIZ.SURFACE,
            border: `1px solid ${QUIZ.BORDER}`,
            borderRadius: QUIZ.R_CARD,
            opacity: 0.6,
            animation: `vlounge-fadeInUp 0.3s ${QUIZ.EASE_BOUNCE} backwards`,
          }}
        />
      ))}
    </OptionGrid>
  );
}

function EmptyCard() {
  return (
    <div
      style={{
        background: QUIZ.SURFACE,
        border: `1px dashed ${QUIZ.BORDER}`,
        borderRadius: QUIZ.R_CARD,
        padding: 24,
        textAlign: 'center',
        color: QUIZ.MUTED_2,
        fontSize: 14,
        maxWidth: 480,
        margin: '0 auto',
      }}
    >
      No options available for this service. Give us a call so we can sort it
      for you.
    </div>
  );
}

function ErrorCard({ message }: { message: string }) {
  return (
    <div
      style={{
        background: QUIZ.SURFACE,
        border: `1px solid ${QUIZ.ALERT}`,
        borderRadius: QUIZ.R_CARD,
        padding: 20,
        maxWidth: 480,
        margin: '0 auto',
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: 16,
          fontWeight: 600,
          color: QUIZ.ALERT,
        }}
      >
        Couldn't load the options
      </p>
      <p
        style={{
          margin: '8px 0 0',
          fontSize: 14,
          color: QUIZ.MUTED_2,
        }}
      >
        Refresh the page, or call us if it sticks. ({message})
      </p>
    </div>
  );
}
