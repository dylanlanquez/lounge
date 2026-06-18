import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import { Video } from 'lucide-react';
import { Card, EmptyState, Skeleton, StatCard, StatusPill } from '../../components/index.ts';
import type { StatusTone } from '../../components/index.ts';
import { theme } from '../../theme/index.ts';
import { type DateRange, dateRangeLabel } from '../../lib/dateRange.ts';
import { formatDateLongOrdinal, formatTimeNoZone } from '../../lib/dateFormat.ts';
import {
  type VirtualImpressionCall,
  formatCallMinutes,
  formatVsSlot,
  useReportsVirtualImpressions,
} from '../../lib/queries/virtualImpressions.ts';

interface Props {
  range: DateRange;
}

// One reduced-motion read for the whole tab. The hero track is the only
// animated element; everything else is static so a long call list never
// janks.
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

// ── Signature element: the slot track ───────────────────────────────
//
// A rounded track whose full width is the booked slot. A green fill
// shows how much of the slot the patient's call used; anything past the
// slot marker spills into amber so an over-run is impossible to miss.
// The same shape carries the hero average and every per-call row, so
// the page teaches its one metaphor once and then repeats it.

interface SlotTrackProps {
  slotMinutes: number;
  valueMinutes: number | null;
  medianMinutes?: number | null;
  height: number;
  animate?: boolean;
  ariaLabel: string;
}

function SlotTrack({
  slotMinutes,
  valueMinutes,
  medianMinutes,
  height,
  animate = false,
  ariaLabel,
}: SlotTrackProps) {
  const reduced = usePrefersReducedMotion();
  const [grown, setGrown] = useState(!animate || reduced);
  useEffect(() => {
    if (!animate || reduced) {
      setGrown(true);
      return;
    }
    const id = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(id);
  }, [animate, reduced]);

  const value = valueMinutes ?? 0;
  const scaleMax = Math.max(slotMinutes, value) || slotMinutes || 1;
  const greenPct = (Math.min(value, slotMinutes) / scaleMax) * 100;
  const amberPct = (Math.max(0, value - slotMinutes) / scaleMax) * 100;
  const slotMarkerPct = (slotMinutes / scaleMax) * 100;
  const medianPct =
    medianMinutes != null ? (medianMinutes / scaleMax) * 100 : null;
  const noAnswer = valueMinutes === null;

  const transition = grown && !reduced
    ? `width ${theme.motion.duration.slow}ms ${theme.motion.easing.spring}`
    : 'none';

  const segment = (color: string, pct: number, radius: number): CSSProperties => ({
    height: '100%',
    width: grown ? `${pct}%` : '0%',
    background: color,
    borderRadius: radius,
    transition,
  });

  return (
    <div
      role="img"
      aria-label={ariaLabel}
      style={{
        position: 'relative',
        height,
        borderRadius: theme.radius.pill,
        background: noAnswer ? 'transparent' : theme.color.accentBg,
        border: noAnswer
          ? `1px dashed ${theme.color.border}`
          : `1px solid ${theme.color.border}`,
        overflow: 'hidden',
        display: 'flex',
      }}
    >
      {!noAnswer && (
        <div style={segment(theme.color.accent, greenPct, theme.radius.pill)} />
      )}
      {!noAnswer && amberPct > 0 && (
        <div style={segment(theme.color.warn, amberPct, theme.radius.pill)} />
      )}
      {/* Booked-slot marker — only meaningful when the call ran over,
          otherwise it sits at the far end and just reads as the cap. */}
      {!noAnswer && amberPct > 0 && (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            left: `${slotMarkerPct}%`,
            top: 0,
            bottom: 0,
            width: 2,
            background: theme.color.surface,
            opacity: 0.9,
          }}
        />
      )}
      {/* Median tick — hero only. */}
      {medianPct != null && !noAnswer && (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            left: `${medianPct}%`,
            top: -3,
            bottom: -3,
            width: 2,
            background: theme.color.ink,
            borderRadius: theme.radius.pill,
          }}
        />
      )}
    </div>
  );
}

function LegendSwatch({ color, dashed }: { color: string; dashed?: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        width: 12,
        height: 12,
        borderRadius: 4,
        background: dashed ? 'transparent' : color,
        border: dashed ? `1.5px dashed ${color}` : 'none',
        flexShrink: 0,
      }}
    />
  );
}

function statusTone(status: string): StatusTone {
  switch (status) {
    case 'no_show':
      return 'no_show';
    case 'cancelled':
    case 'rescheduled':
      return 'cancelled';
    default:
      return 'neutral';
  }
}

function CallRow({ call, slotMinutes }: { call: VirtualImpressionCall; slotMinutes: number }) {
  const measured = call.patientMinutes !== null;
  const over = call.vsSlotMinutes !== null && call.vsSlotMinutes > 0;
  const vsColor = !measured
    ? theme.color.inkSubtle
    : over
      ? theme.color.warn
      : theme.color.inkMuted;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[4],
        padding: `${theme.space[3]}px 0`,
        borderTop: `1px solid ${theme.color.border}`,
      }}
    >
      <div style={{ flex: '1 1 0', minWidth: 0 }}>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.base,
            fontWeight: theme.type.weight.medium,
            color: theme.color.ink,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {call.patientName}
        </p>
        <p
          style={{
            margin: 0,
            marginTop: 2,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
          }}
        >
          {formatDateLongOrdinal(call.startAt)} · {formatTimeNoZone(call.startAt)}
        </p>
      </div>

      <div style={{ flex: '1.4 1 0', minWidth: 120 }}>
        <SlotTrack
          slotMinutes={call.slotMinutes || slotMinutes}
          valueMinutes={call.patientMinutes}
          height={10}
          ariaLabel={
            measured
              ? `Patient on the call ${formatCallMinutes(call.patientMinutes)}, ${formatVsSlot(call.vsSlotMinutes)} against a ${call.slotMinutes} minute slot`
              : 'Patient did not join the call'
          }
        />
      </div>

      <div
        style={{
          flex: '0 0 auto',
          width: 116,
          textAlign: 'right',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 2,
        }}
      >
        {measured ? (
          <>
            <span
              style={{
                fontSize: theme.type.size.md,
                fontWeight: theme.type.weight.semibold,
                color: theme.color.ink,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {formatCallMinutes(call.patientMinutes)}
            </span>
            <span style={{ fontSize: theme.type.size.sm, color: vsColor }}>
              {formatVsSlot(call.vsSlotMinutes)}
            </span>
          </>
        ) : (
          <StatusPill tone={statusTone(call.status)} size="sm">
            No answer
          </StatusPill>
        )}
      </div>
    </div>
  );
}

export function VirtualImpressionsTab({ range }: Props) {
  const { data, loading, error } = useReportsVirtualImpressions(range);

  const heroSentence = useMemo(() => {
    if (!data || data.avgPatientMinutes === null) return null;
    const avg = formatCallMinutes(data.avgPatientMinutes);
    const diff = data.avgPatientMinutes - data.slotMinutes;
    const rel =
      Math.abs(diff) < 1
        ? `right on the ${data.slotMinutes} minute slot`
        : diff < 0
          ? `a little under the ${data.slotMinutes} minute slot`
          : `over the ${data.slotMinutes} minute slot`;
    const calls = `${data.patientJoined} ${data.patientJoined === 1 ? 'call' : 'calls'}`;
    return `Across ${calls} where the patient joined, they were on the video for ${avg} on average, ${rel}.`;
  }, [data]);

  if (error) {
    return (
      <Card padding="lg">
        <p style={{ margin: 0, color: theme.color.alert }}>
          Could not load virtual impressions for {dateRangeLabel(range)}: {error}
        </p>
      </Card>
    );
  }

  if (loading || !data) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
        <Skeleton height={208} />
        <Skeleton height={120} />
        <Skeleton height={320} />
      </div>
    );
  }

  if (data.callsHeld === 0) {
    return (
      <Card padding="lg">
        <EmptyState
          icon={<Video size={20} />}
          title="No video impressions in this period"
          description="No virtual impression calls were held in this range. Try a wider date range, or check back once today's calls have finished."
        />
      </Card>
    );
  }

  const measuredAvg = data.avgPatientMinutes !== null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      {/* Hero — the thesis: actual call time against the booked slot. */}
      <Card padding="lg">
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
            <span
              style={{
                fontSize: theme.type.size.xs,
                fontWeight: theme.type.weight.semibold,
                letterSpacing: theme.type.tracking.wide,
                textTransform: 'uppercase',
                color: theme.color.inkSubtle,
              }}
            >
              Average time on a video impression
            </span>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: theme.space[3] }}>
              <span
                style={{
                  fontSize: theme.type.size.display,
                  fontWeight: theme.type.weight.semibold,
                  letterSpacing: theme.type.tracking.tight,
                  lineHeight: theme.type.leading.tight,
                  color: theme.color.ink,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {measuredAvg ? formatCallMinutes(data.avgPatientMinutes) : '—'}
              </span>
              {data.medianPatientMinutes !== null && (
                <span style={{ fontSize: theme.type.size.md, color: theme.color.inkMuted }}>
                  {formatCallMinutes(data.medianPatientMinutes)} median
                </span>
              )}
            </div>
            {heroSentence && (
              <p
                style={{
                  margin: 0,
                  maxWidth: 560,
                  fontSize: theme.type.size.md,
                  lineHeight: theme.type.leading.normal,
                  color: theme.color.inkMuted,
                }}
              >
                {heroSentence}
              </p>
            )}
          </div>

          {measuredAvg && (
            <>
              <SlotTrack
                slotMinutes={data.slotMinutes}
                valueMinutes={data.avgPatientMinutes}
                medianMinutes={data.medianPatientMinutes}
                height={18}
                animate
                ariaLabel={`Average patient time ${formatCallMinutes(data.avgPatientMinutes)} against a ${data.slotMinutes} minute booked slot`}
              />
              <p
                style={{
                  margin: 0,
                  marginTop: `-${theme.space[2]}px`,
                  fontSize: theme.type.size.sm,
                  color: theme.color.inkSubtle,
                }}
              >
                The full bar is your {data.slotMinutes} minute booked slot. Green is the time the patient was on the call.
              </p>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: theme.space[4],
                  fontSize: theme.type.size.sm,
                  color: theme.color.inkMuted,
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: theme.space[2] }}>
                  <LegendSwatch color={theme.color.accent} /> Average {formatCallMinutes(data.avgPatientMinutes)}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: theme.space[2] }}>
                  <LegendSwatch color={theme.color.ink} /> Median {formatCallMinutes(data.medianPatientMinutes)}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: theme.space[2] }}>
                  <LegendSwatch color={theme.color.warn} /> Over the {data.slotMinutes} min slot
                </span>
              </div>
            </>
          )}
        </div>
      </Card>

      {/* Supporting numbers. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
          gap: theme.space[3],
        }}
      >
        <StatCard label="Calls held" value={String(data.callsHeld)} />
        <StatCard
          label="Shortest"
          value={formatCallMinutes(data.minPatientMinutes)}
        />
        <StatCard
          label="Longest"
          value={formatCallMinutes(data.maxPatientMinutes)}
          tone={
            data.maxPatientMinutes !== null && data.maxPatientMinutes > data.slotMinutes
              ? 'warn'
              : 'normal'
          }
        />
        <StatCard
          label="Patient joined"
          value={
            data.attendanceRate !== null
              ? `${Math.round(data.attendanceRate * 100)}%`
              : '—'
          }
          delta={`${data.patientJoined} of ${data.callsHeld}`}
          tone="accent"
        />
        <StatCard
          label="Ran over slot"
          value={String(data.ranOverSlot)}
          tone={data.ranOverSlot > 0 ? 'warn' : 'normal'}
        />
      </div>

      {/* Every call, on its own. */}
      <Card padding="lg">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            marginBottom: theme.space[2],
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: theme.type.size.lg,
              fontWeight: theme.type.weight.semibold,
              letterSpacing: theme.type.tracking.tight,
              color: theme.color.ink,
            }}
          >
            Every call
          </h2>
          <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
            {data.callsHeld} in {dateRangeLabel(range)}
          </span>
        </div>
        <div>
          {data.calls.map((call) => (
            <CallRow key={call.id} call={call} slotMinutes={data.slotMinutes} />
          ))}
        </div>
      </Card>
    </div>
  );
}
