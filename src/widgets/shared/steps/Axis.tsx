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
import { OptionCard, OptionGrid, OptionTitle } from '../OptionCard.tsx';
import {
  ArchTilePicker,
  type ArchKey,
  type ArchTileOption,
} from '../ArchTilePicker.tsx';

// AxisStep — one axis question at a time (arch, product, repair
// variant). Same option-card visual pattern as Location and Service
// for consistency across the flow.
//
// Selection updates state via api.setAxisPin; the footer Next button
// is the sole navigation control (no auto-advance).

const AXIS_HELPER: Record<AxisKey, string> = {
  // repair_variant intentionally has NO helper paragraph — the
  // title ("What needs fixing?") is unambiguous and the options
  // themselves are the answer. The no-helper marginTop branch
  // below keeps the title → grid spacing consistent.
  repair_variant: '',
  product_key:
    "Pick the option that fits — we'll confirm any details when you arrive.",
  // Arch step also skips the helper — title is descriptive enough
  // and the option cards carry no sub-copy.
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
  // it; product / repair-variant keep theirs). When present, the
  // helper sits as a first flex child with a 32px gap to the
  // option grid below — that internal rhythm is independent of
  // the title-to-content gap, which StepBody owns (single source
  // of truth via STEP_TITLE_BOTTOM_SPACE). No marginTop hack: the
  // arch step (no helper) now relies on StepBody's flex gap for
  // its title-to-grid spacing, matching every other step.
  const helper = AXIS_HELPER[axis.key];
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: helper ? 32 : 0,
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
        axis.key === 'arch' ? <ArchSkeleton /> : <SkeletonGrid />
      ) : options.length === 0 ? (
        <EmptyCard />
      ) : axis.key === 'arch' ? (
        // Arch axis renders with the dedicated ArchTilePicker —
        // centred title + per-product subtitle, no radio indicator,
        // so every service's arch question reads identically (and
        // matches the denture-repair flow which has used this tile
        // shape since launch). The picker enforces a 3-option grid
        // and the upper/lower/both enum, both of which the arch
        // axis always satisfies.
        <ArchTilePicker
          options={archOptionsForService(
            options,
            api.state.service?.serviceType ?? '',
            api.state.axes.product_key,
          )}
          selectedValue={currentValue as ArchKey | null}
          accent={accent}
          onSelect={(v) => {
            const match = options.find((o) => o.key === v);
            api.setAxisPin(axis.key, v, match?.archMatch);
          }}
        />
      ) : (
        <OptionGrid>
          {options.map((opt) => {
            const selected = currentValue === opt.key;
            return (
              <OptionCard
                key={opt.key}
                selected={selected}
                anySelected={!!currentValue}
                onSelect={() =>
                  api.setAxisPin(axis.key, opt.key, opt.archMatch)
                }
                accent={accent}
                ariaLabel={opt.label}
              >
                <OptionTitle>{opt.label}</OptionTitle>
              </OptionCard>
            );
          })}
        </OptionGrid>
      )}
    </div>
  );
}

// Build the per-option title + subtitle map the ArchTilePicker
// renders. Order mirrors the DB-loaded `options` so a future
// change to the arch axis enum lands here automatically; titles
// and subtitles come from service-specific copy below.
function archOptionsForService(
  options: ReadonlyArray<AxisValueOption>,
  serviceType: string,
  productKey: string | undefined,
): ArchTileOption[] {
  return options
    .map((opt) => {
      const value = opt.key as ArchKey;
      if (value !== 'upper' && value !== 'lower' && value !== 'both') return null;
      return {
        value,
        title: labelForArchOption(value, serviceType),
        subtitle: describeArchOption(value, serviceType, productKey) ?? '',
      } satisfies ArchTileOption;
    })
    .filter((opt): opt is ArchTileOption => opt !== null);
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

// Per-option subtitle on the arch step. Click-in veneers reads in
// terms of cosmetic coverage; same-day appliances read in terms of
// the specific appliance the patient needs. Copy is verbatim from
// Dylan's spec (retainer-style "I only need an upper retainer" for
// retainers + missing-tooth retainer; "I need an upper X only" for
// night guard / day guard / whitening tray). Returns null when no
// tailored line exists so the tile falls back to title-only.
function describeArchOption(
  optKey: string,
  serviceType: string,
  productKey: string | undefined,
): string | null {
  if (serviceType === 'click_in_veneers') {
    if (optKey === 'upper') return 'I only want to cover my top teeth';
    if (optKey === 'lower') return 'I only want to cover my bottom teeth';
    if (optKey === 'both') return 'I want to cover my top & bottom teeth';
    return null;
  }
  if (serviceType === 'same_day_appliance') {
    return applianceArchSubtitle(productKey, optKey);
  }
  return null;
}

// Verbatim per-product subtitle copy. Inlined per product (rather
// than a `${noun}` template) because Dylan's spec uses different
// word orders intentionally — retainer reads "I only need an upper
// retainer", night guard reads "I need an upper night guard only".
// A single template would have to pick one phrasing and override
// the other; keeping each product's copy literal preserves both.
function applianceArchSubtitle(
  productKey: string | undefined,
  optKey: string,
): string | null {
  switch (productKey) {
    case 'retainer':
      if (optKey === 'upper') return 'I only need an upper retainer';
      if (optKey === 'lower') return 'I only need a lower retainer';
      if (optKey === 'both') return 'I need both upper & lower retainers';
      return null;
    case 'night_guard':
      if (optKey === 'upper') return 'I need an upper night guard only';
      if (optKey === 'lower') return 'I need a lower night guard only';
      if (optKey === 'both') return 'I need both upper & lower night guards';
      return null;
    case 'day_guard':
      if (optKey === 'upper') return 'I need an upper day guard only';
      if (optKey === 'lower') return 'I need a lower day guard only';
      if (optKey === 'both') return 'I need both upper & lower day guards';
      return null;
    case 'whitening_tray':
      if (optKey === 'upper') return 'I need an upper whitening tray only';
      if (optKey === 'lower') return 'I need a lower whitening tray only';
      if (optKey === 'both') return 'I need both upper & lower whitening trays';
      return null;
    case 'missing_tooth':
      // Missing-tooth retainer follows the retainer register
      // ("I only need …") since it IS a retainer variant.
      if (optKey === 'upper') return 'I only need an upper missing tooth retainer';
      if (optKey === 'lower') return 'I only need a lower missing tooth retainer';
      if (optKey === 'both') return 'I need both upper & lower missing tooth retainers';
      return null;
    default:
      return null;
  }
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

// Loading shimmer for the arch axis specifically — same grid shape
// as ArchTilePicker (220px min cells, 16 gap, 800 max) so the
// placeholder layout doesn't jump when the live options resolve.
function ArchSkeleton() {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 16,
        margin: '0 auto',
        maxWidth: 800,
        width: '100%',
      }}
    >
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          aria-hidden
          style={{
            width: '100%',
            minHeight: 86,
            background: QUIZ.SURFACE,
            border: `1px solid ${QUIZ.BORDER}`,
            borderRadius: QUIZ.R_CARD,
            opacity: 0.6,
            animation: `vlounge-fadeInUp 0.3s ${QUIZ.EASE_BOUNCE} backwards`,
          }}
        />
      ))}
    </div>
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
      <div
        style={{
          marginTop: 8,
          fontSize: 14,
          color: QUIZ.MUTED_2,
        }}
      >
        Refresh the page, or call us if it sticks. ({message})
      </div>
    </div>
  );
}
