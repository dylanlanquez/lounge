import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import {
  axesForService,
  type AxisDef,
  type AxisKey,
  type AxisValueOption,
  loadAxisValues,
} from '../../lib/queries/bookingTypeAxes.ts';
import type { BookingServiceType } from '../../lib/queries/bookingTypes.ts';
import type { BookingStateApi } from '../state.ts';

// AxisStep — one axis question at a time.
//
// Reads SERVICE_AXES + loadAxisValues() (same registry the staff
// app uses), so what the widget shows for "click_in_veneers" is
// exactly the same option set the operator sees in the new-booking
// sheet. No drift, no per-widget reimplementation.
//
// Patient-friendly framing:
//
//   • Question is plain English ("Which teeth?", not "Arch")
//   • Helper line under the question explains why we're asking
//   • Cards are tap-targets, not radios — same mobile-friendly
//     pattern as the Service / Dentist steps so the flow stays
//     visually consistent.
//
// Conditional logic lives in state.ts's setAxisPin: picking a
// product whose arch_match isn't 'single' auto-fills arch and the
// step engine drops the next axis screen before the patient sees it.

const AXIS_HELPER: Record<AxisKey, string> = {
  repair_variant: "We'll match you to the right specialist.",
  product_key: "Pick the option that fits — we'll confirm any details when you arrive.",
  arch: 'The top teeth, the bottom teeth, or both. Pick whichever applies.',
};

export function AxisStep({
  api,
  axisKey,
}: {
  api: BookingStateApi;
  axisKey: AxisKey;
}) {
  const service = api.state.service;
  if (!service) {
    // Should never happen — the step engine wouldn't surface an axis
    // step without a service in state. Guard anyway so we don't try
    // to render against a null.
    return null;
  }

  const axes = axesForService(service.serviceType as BookingServiceType);
  const axis = axes.find((a) => a.key === axisKey) ?? null;

  if (!axis) {
    return null;
  }

  return (
    <AxisOptions
      api={api}
      axis={axis}
    />
  );
}

function AxisOptions({ api, axis }: { api: BookingStateApi; axis: AxisDef }) {
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
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load options');
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
      <p
        style={{
          margin: 0,
          fontSize: theme.type.size.sm,
          color: theme.color.inkMuted,
          lineHeight: theme.type.leading.snug,
          maxWidth: 560,
        }}
      >
        {AXIS_HELPER[axis.key]}
      </p>

      {error ? (
        <ErrorCard message={error} />
      ) : options === null ? (
        <Skeleton />
      ) : options.length === 0 ? (
        <EmptyCard />
      ) : (
        options.map((opt) => {
          const selected = currentValue === opt.key;
          return (
            <button
              key={opt.key}
              type="button"
              onClick={() => {
                // setAxisPin advances itself based on the post-pin
                // active step list — calling goNext would skip the
                // freshly-introduced step.
                api.setAxisPin(axis.key, opt.key, opt.archMatch);
              }}
              style={{
                appearance: 'none',
                textAlign: 'left',
                fontFamily: 'inherit',
                cursor: 'pointer',
                padding: `${theme.space[4]}px ${theme.space[5]}px`,
                borderRadius: theme.radius.card,
                background: theme.color.surface,
                border: `1px solid ${selected ? theme.color.accent : theme.color.border}`,
                boxShadow: selected ? theme.shadow.card : 'none',
                display: 'flex',
                alignItems: 'center',
                gap: theme.space[4],
                transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
              }}
              onMouseEnter={(e) => {
                if (selected) return;
                e.currentTarget.style.borderColor = theme.color.ink;
              }}
              onMouseLeave={(e) => {
                if (selected) return;
                e.currentTarget.style.borderColor = theme.color.border;
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <p
                  style={{
                    margin: 0,
                    fontSize: theme.type.size.md,
                    fontWeight: theme.type.weight.semibold,
                    color: theme.color.ink,
                    letterSpacing: theme.type.tracking.tight,
                  }}
                >
                  {opt.label}
                </p>
                {/* For the arch axis, surface a one-liner hint that
                    explains what "upper / lower / both" means in
                    practice. Skipped for variant / product where the
                    label already does the work. */}
                {axis.key === 'arch' ? (
                  <p
                    style={{
                      margin: `${theme.space[1]}px 0 0`,
                      fontSize: theme.type.size.sm,
                      color: theme.color.inkMuted,
                      lineHeight: theme.type.leading.snug,
                    }}
                  >
                    {opt.key === 'upper'
                      ? 'The top row of teeth.'
                      : opt.key === 'lower'
                        ? 'The bottom row of teeth.'
                        : 'Both top and bottom together.'}
                  </p>
                ) : null}
              </div>
              <ChevronRight size={18} aria-hidden style={{ color: theme.color.inkMuted, flexShrink: 0 }} />
            </button>
          );
        })
      )}
    </div>
  );
}

function Skeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          aria-hidden
          style={{
            height: 72,
            background: theme.color.surface,
            border: `1px solid ${theme.color.border}`,
            borderRadius: theme.radius.card,
            opacity: 0.6,
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
        background: theme.color.surface,
        border: `1px dashed ${theme.color.border}`,
        borderRadius: theme.radius.card,
        padding: theme.space[5],
        textAlign: 'center',
        color: theme.color.inkMuted,
        fontSize: theme.type.size.sm,
      }}
    >
      No options available for this service. Give us a call so we can sort it for you.
    </div>
  );
}

function ErrorCard({ message }: { message: string }) {
  return (
    <div
      style={{
        background: theme.color.surface,
        border: `1px solid ${theme.color.alert}`,
        borderRadius: theme.radius.card,
        padding: theme.space[5],
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: theme.type.size.md,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.alert,
        }}
      >
        Couldn't load the options
      </p>
      <p
        style={{
          margin: `${theme.space[2]}px 0 0`,
          fontSize: theme.type.size.sm,
          color: theme.color.inkMuted,
        }}
      >
        Refresh the page, or call us if it sticks. ({message})
      </p>
    </div>
  );
}
