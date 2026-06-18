import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import { Video } from 'lucide-react';
import {
  Card,
  Checkbox,
  DropdownSelect,
  EmptyState,
  LineChart,
  SegmentedControl,
  Skeleton,
  StatCard,
  StatusPill,
} from '../../components/index.ts';
import type { DropdownSelectOption, StatusTone } from '../../components/index.ts';
import { theme } from '../../theme/index.ts';
import { type DateRange, dateRangeLabel } from '../../lib/dateRange.ts';
import { formatDateLongOrdinal, formatTimeNoZone } from '../../lib/dateFormat.ts';
import {
  type ArchFilter,
  type VirtualImpressionCall,
  buildDailyDurationSeries,
  computeDurationTrend,
  formatCallMinutes,
  formatVsSlot,
  summarizeCalls,
  useReportsVirtualImpressions,
} from '../../lib/queries/virtualImpressions.ts';

// Compact x-axis labels for the trend chart: "17 Jun" from a clinic
// YYYY-MM-DD day key. Built off UTC noon so the label never slips a day.
const shortDayFmt = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
});
function shortDay(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return shortDayFmt.format(new Date(Date.UTC(y!, m! - 1, d!)));
}

type OutcomeFilter = 'all' | 'within' | 'over';

const ARCH_OPTIONS: { value: ArchFilter; label: string }[] = [
  { value: 'all', label: 'All arches' },
  { value: 'upper', label: 'Upper' },
  { value: 'lower', label: 'Lower' },
  { value: 'both', label: 'Both' },
];

const OUTCOME_OPTIONS: { value: OutcomeFilter; label: string }[] = [
  { value: 'all', label: 'Any length' },
  { value: 'within', label: 'Within slot' },
  { value: 'over', label: 'Over slot' },
];

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
  // Render as a quiet secondary bar (the clinician's time): a single
  // muted fill, no slot marker, no median tick.
  muted?: boolean;
  // Shared scale so a patient bar and the host bar beneath it line up
  // and are directly comparable. Falls back to the bar's own scale.
  scaleMax?: number;
  ariaLabel: string;
}

function SlotTrack({
  slotMinutes,
  valueMinutes,
  medianMinutes,
  height,
  animate = false,
  muted = false,
  scaleMax: scaleMaxOverride,
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
  const scaleMax =
    scaleMaxOverride ?? (Math.max(slotMinutes, value) || slotMinutes || 1);
  const greenPct = (Math.min(value, slotMinutes) / scaleMax) * 100;
  const amberPct = (Math.max(0, value - slotMinutes) / scaleMax) * 100;
  const mutedPct = (value / scaleMax) * 100;
  const slotMarkerPct = (slotMinutes / scaleMax) * 100;
  const medianPct =
    medianMinutes != null ? (medianMinutes / scaleMax) * 100 : null;
  const noAnswer = valueMinutes === null;

  const transition = grown && !reduced
    ? `width ${theme.motion.duration.slow}ms ${theme.motion.easing.spring}`
    : 'none';

  const segment = (color: string, pct: number, opacity = 1): CSSProperties => ({
    height: '100%',
    width: grown ? `${pct}%` : '0%',
    background: color,
    opacity,
    borderRadius: theme.radius.pill,
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
        background: noAnswer || muted ? 'transparent' : theme.color.accentBg,
        border: noAnswer
          ? `1px dashed ${theme.color.border}`
          : muted
            ? 'none'
            : `1px solid ${theme.color.border}`,
        overflow: 'hidden',
        display: 'flex',
      }}
    >
      {muted && !noAnswer && (
        <div style={segment(theme.color.accent, mutedPct, 0.4)} />
      )}
      {!muted && !noAnswer && (
        <div style={segment(theme.color.accent, greenPct)} />
      )}
      {!muted && !noAnswer && amberPct > 0 && (
        <div style={segment(theme.color.warn, amberPct)} />
      )}
      {/* Booked-slot marker — only meaningful when the call ran over,
          otherwise it sits at the far end and just reads as the cap. */}
      {!muted && !noAnswer && amberPct > 0 && (
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
      {!muted && medianPct != null && !noAnswer && (
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

function archLabel(arch: string | null): string | null {
  switch (arch) {
    case 'upper':
      return 'Upper';
    case 'lower':
      return 'Lower';
    case 'both':
      return 'Both arches';
    default:
      return null;
  }
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
  const slot = call.slotMinutes || slotMinutes;
  // Patient and host bars share one scale so they read as the same call.
  const sharedScale =
    Math.max(slot, call.patientMinutes ?? 0, call.hostMinutes ?? 0) || slot;
  const arch = archLabel(call.arch);
  const hostFirst = call.hostName ? call.hostName.split(' ')[0] : null;

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
          {arch ? ` · ${arch}` : ''}
        </p>
      </div>

      <div
        style={{
          flex: '1.4 1 0',
          minWidth: 120,
          display: 'flex',
          flexDirection: 'column',
          gap: 5,
        }}
      >
        <SlotTrack
          slotMinutes={slot}
          valueMinutes={call.patientMinutes}
          scaleMax={sharedScale}
          height={10}
          ariaLabel={
            measured
              ? `Patient on the call ${formatCallMinutes(call.patientMinutes)}, ${formatVsSlot(call.vsSlotMinutes)} against a ${slot} minute slot`
              : 'Patient did not join the call'
          }
        />
        {call.hostMinutes !== null && (
          <SlotTrack
            muted
            slotMinutes={slot}
            valueMinutes={call.hostMinutes}
            scaleMax={sharedScale}
            height={5}
            ariaLabel={`Clinician on the call ${formatCallMinutes(call.hostMinutes)}`}
          />
        )}
      </div>

      <div
        style={{
          flex: '0 0 auto',
          width: 132,
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
        {call.hostMinutes !== null && (
          <span
            style={{
              marginTop: 2,
              fontSize: theme.type.size.sm,
              color: theme.color.inkSubtle,
            }}
          >
            {hostFirst ? `${hostFirst} ${formatCallMinutes(call.hostMinutes)}` : `Host ${formatCallMinutes(call.hostMinutes)}`}
          </span>
        )}
      </div>
    </div>
  );
}

function FilterBar({
  arch,
  onArch,
  host,
  hostOptions,
  onHost,
  outcome,
  onOutcome,
  hideNoAnswers,
  onHideNoAnswers,
}: {
  arch: ArchFilter;
  onArch: (a: ArchFilter) => void;
  host: string;
  hostOptions: DropdownSelectOption<string>[];
  onHost: (h: string) => void;
  outcome: OutcomeFilter;
  onOutcome: (o: OutcomeFilter) => void;
  hideNoAnswers: boolean;
  onHideNoAnswers: (v: boolean) => void;
}) {
  return (
    <Card padding="md">
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: theme.space[3],
        }}
      >
        <SegmentedControl<ArchFilter>
          scrollable
          value={arch}
          onChange={onArch}
          options={ARCH_OPTIONS}
        />
        <SegmentedControl<OutcomeFilter>
          scrollable
          value={outcome}
          onChange={onOutcome}
          options={OUTCOME_OPTIONS}
        />
        <div style={{ minWidth: 180 }}>
          <DropdownSelect<string>
            value={host}
            options={hostOptions}
            onChange={onHost}
          />
        </div>
        <Checkbox
          checked={hideNoAnswers}
          onChange={onHideNoAnswers}
          label="Hide no answers"
        />
      </div>
    </Card>
  );
}

export function VirtualImpressionsTab({ range }: Props) {
  const { data, loading, error } = useReportsVirtualImpressions(range);
  const [arch, setArch] = useState<ArchFilter>('all');
  const [host, setHost] = useState<string>('all');
  const [outcome, setOutcome] = useState<OutcomeFilter>('all');
  const [hideNoAnswers, setHideNoAnswers] = useState(false);

  const hostOptions = useMemo<DropdownSelectOption<string>[]>(() => {
    const names = data
      ? Array.from(
          new Set(
            data.calls
              .map((c) => c.hostName)
              .filter((n): n is string => !!n),
          ),
        ).sort()
      : [];
    return [
      { value: 'all', label: 'All hosts' },
      ...names.map((n) => ({ value: n, label: n })),
    ];
  }, [data]);

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.calls.filter((c) => {
      if (arch !== 'all' && c.arch !== arch) return false;
      if (host !== 'all' && c.hostName !== host) return false;
      if (hideNoAnswers && c.patientMinutes === null) return false;
      if (outcome === 'within') {
        return c.patientMinutes !== null && c.patientMinutes <= c.slotMinutes;
      }
      if (outcome === 'over') {
        return c.patientMinutes !== null && c.patientMinutes > c.slotMinutes;
      }
      return true;
    });
  }, [data, arch, host, outcome, hideNoAnswers]);

  const slotMinutes = data?.slotMinutes ?? 30;
  const summary = useMemo(() => summarizeCalls(filtered), [filtered]);
  const trend = useMemo(() => computeDurationTrend(filtered), [filtered]);
  const dailySeries = useMemo(
    () => buildDailyDurationSeries(filtered, range.start, range.end),
    [filtered, range.start, range.end],
  );

  const heroSentence = useMemo(() => {
    if (summary.avgPatientMinutes === null) return null;
    const avg = formatCallMinutes(summary.avgPatientMinutes);
    const diff = summary.avgPatientMinutes - slotMinutes;
    const rel =
      Math.abs(diff) < 1
        ? `right on the ${slotMinutes} minute slot`
        : diff < 0
          ? `a little under the ${slotMinutes} minute slot`
          : `over the ${slotMinutes} minute slot`;
    const calls = `${summary.patientJoined} ${summary.patientJoined === 1 ? 'call' : 'calls'}`;
    return `Across ${calls} where the patient joined, they were on the video for ${avg} on average, ${rel}.`;
  }, [summary, slotMinutes]);

  const trendSentence = useMemo(() => {
    if (trend.perWeekMinutes === null) {
      return 'Not enough calls in this view yet to show a direction.';
    }
    const n = Math.abs(Math.round(trend.perWeekMinutes));
    if (trend.direction === 'flat' || n === 0) {
      return 'Call length is holding steady across this period.';
    }
    return trend.direction === 'up'
      ? `Calls are trending about ${n} min longer each week.`
      : `Calls are trending about ${n} min shorter each week.`;
  }, [trend]);

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
        <Skeleton height={64} />
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

  const filterBar = (
    <FilterBar
      arch={arch}
      onArch={setArch}
      host={host}
      hostOptions={hostOptions}
      onHost={setHost}
      outcome={outcome}
      onOutcome={setOutcome}
      hideNoAnswers={hideNoAnswers}
      onHideNoAnswers={setHideNoAnswers}
    />
  );

  if (filtered.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
        {filterBar}
        <Card padding="lg">
          <EmptyState
            icon={<Video size={20} />}
            title="No calls match these filters"
            description="Nothing in this range fits the current filters. Widen the arch, host, or length filters above to see calls again."
          />
        </Card>
      </div>
    );
  }

  const measuredAvg = summary.avgPatientMinutes !== null;
  const xLabels = dailySeries.map((d) => shortDay(d.date));
  const hasChartData = dailySeries.some((d) => Number.isFinite(d.avgMinutes));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      {filterBar}

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
                {measuredAvg ? formatCallMinutes(summary.avgPatientMinutes) : '—'}
              </span>
              {summary.medianPatientMinutes !== null && (
                <span style={{ fontSize: theme.type.size.md, color: theme.color.inkMuted }}>
                  {formatCallMinutes(summary.medianPatientMinutes)} median
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
                slotMinutes={slotMinutes}
                valueMinutes={summary.avgPatientMinutes}
                medianMinutes={summary.medianPatientMinutes}
                height={18}
                animate
                ariaLabel={`Average patient time ${formatCallMinutes(summary.avgPatientMinutes)} against a ${slotMinutes} minute booked slot`}
              />
              <p
                style={{
                  margin: 0,
                  marginTop: `-${theme.space[2]}px`,
                  fontSize: theme.type.size.sm,
                  color: theme.color.inkSubtle,
                }}
              >
                The full bar is your {slotMinutes} minute booked slot. Green is the time the patient was on the call.
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
                  <LegendSwatch color={theme.color.accent} /> Average {formatCallMinutes(summary.avgPatientMinutes)}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: theme.space[2] }}>
                  <LegendSwatch color={theme.color.ink} /> Median {formatCallMinutes(summary.medianPatientMinutes)}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: theme.space[2] }}>
                  <LegendSwatch color={theme.color.warn} /> Over the {slotMinutes} min slot
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
        <StatCard label="Calls held" value={String(summary.callsHeld)} />
        <StatCard label="Shortest" value={formatCallMinutes(summary.minPatientMinutes)} />
        <StatCard
          label="Longest"
          value={formatCallMinutes(summary.maxPatientMinutes)}
          tone={
            summary.maxPatientMinutes !== null && summary.maxPatientMinutes > slotMinutes
              ? 'warn'
              : 'normal'
          }
        />
        <StatCard
          label="Patient joined"
          value={
            summary.attendanceRate !== null
              ? `${Math.round(summary.attendanceRate * 100)}%`
              : '—'
          }
          delta={`${summary.patientJoined} of ${summary.callsHeld}`}
          tone="accent"
        />
        <StatCard
          label="Ran over slot"
          value={String(summary.ranOverSlot)}
          tone={summary.ranOverSlot > 0 ? 'warn' : 'normal'}
        />
      </div>

      {/* Trend over time. */}
      {hasChartData && (
        <Card padding="lg">
          <LineChart
            title="Call length over time"
            subtitle={trendSentence}
            xLabels={xLabels}
            series={[
              {
                id: 'avg',
                label: 'Average call length',
                colour: theme.color.accent,
                values: dailySeries.map((d) => d.avgMinutes),
                formatValue: (n) => `${Math.round(n)} min`,
              },
            ]}
            legendMode="avg"
            ariaSummary={`Daily average virtual impression call length over ${dateRangeLabel(range)}. ${trendSentence}`}
          />
        </Card>
      )}

      {/* Every call, on its own. */}
      <Card padding="lg">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            gap: theme.space[3],
            marginBottom: theme.space[1],
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
            {filtered.length} {filtered.length === 1 ? 'call' : 'calls'} in {dateRangeLabel(range)}
          </span>
        </div>
        <p
          style={{
            margin: 0,
            marginBottom: theme.space[2],
            fontSize: theme.type.size.sm,
            color: theme.color.inkSubtle,
          }}
        >
          The faint bar under each call is the clinician's time on the same call.
        </p>
        <div>
          {filtered.map((call) => (
            <CallRow key={call.id} call={call} slotMinutes={slotMinutes} />
          ))}
        </div>
      </Card>
    </div>
  );
}
