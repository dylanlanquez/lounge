import { CalendarRange, Crown, Repeat, Users } from 'lucide-react';
import {
  BarChart,
  Card,
  EmptyState,
  Skeleton,
  StatCard,
} from '../../components/index.ts';
import { theme } from '../../theme/index.ts';
import { type DateRange, dateRangeLabel } from '../../lib/dateRange.ts';
import {
  type LifetimeValueData,
  useReportsLifetimeValue,
} from '../../lib/queries/reports.ts';
import { formatPence } from '../../lib/queries/carts.ts';

interface Props {
  range: DateRange;
}

// Lifetime value — the cohort = patients who visited in the date
// range; the analysis = their *all-time* spend, visit count, and
// inter-visit cadence. Answers "what's the patient base for this
// period actually worth, and how often does someone come back?".

export function LifetimeValueTab({ range }: Props) {
  const { data, loading, error } = useReportsLifetimeValue(range);

  if (error) {
    return (
      <Card padding="lg">
        <p style={{ margin: 0, color: theme.color.alert }}>
          Could not load lifetime value for {dateRangeLabel(range)}: {error}
        </p>
      </Card>
    );
  }
  if (loading || !data) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
        <Skeleton height={120} />
        <Skeleton height={300} />
      </div>
    );
  }
  if (data.cohort_size === 0) {
    return (
      <Card padding="lg">
        <EmptyState
          icon={<Crown size={20} />}
          title="No patients in this period"
          description="Lifetime value reads from this period's cohort. Try a wider range."
        />
      </Card>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <Kpis data={data} />
      <RepeatDistributionCard data={data} />
      <TopSpendersCard data={data} />
    </div>
  );
}

function Kpis({ data }: { data: LifetimeValueData }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: theme.space[3],
      }}
    >
      <StatCard
        label="Cohort size"
        value={data.cohort_size.toLocaleString('en-GB')}
        delta="patients seen in period"
        icon={<Users size={14} />}
      />
      <StatCard
        label="All-time revenue"
        value={formatPence(data.cohort_revenue_pence)}
        delta={
          data.cohort_size > 0
            ? `${formatPence(Math.round(data.cohort_revenue_pence / data.cohort_size))} per patient`
            : '—'
        }
        tone="accent"
      />
      <StatCard
        label="Median time between visits"
        value={
          data.median_days_between_visits === null
            ? '—'
            : `${formatGap(data.median_days_between_visits)}`
        }
        delta={data.median_days_between_visits === null ? 'No repeat visits yet' : 'across patients with 2+ visits'}
        icon={<CalendarRange size={14} />}
      />
      <StatCard
        label="Repeat rate"
        value={`${repeatPct(data).toFixed(0)}%`}
        delta="patients with 2+ visits all-time"
        icon={<Repeat size={14} />}
      />
    </div>
  );
}

function RepeatDistributionCard({ data }: { data: LifetimeValueData }) {
  return (
    <Card padding="lg">
      <BarChart
        title="Visit count distribution"
        subtitle="How many of this period's patients have visited 1, 2-3, 4-6, or 7+ times in their history?"
        bars={data.repeat_distribution.map((b) => ({
          id: b.bucket,
          label: b.bucket,
          value: b.patients,
          colour: theme.color.accent,
        }))}
        ariaSummary="Bar chart showing the distribution of how many times patients have visited."
      />
    </Card>
  );
}

function TopSpendersCard({ data }: { data: LifetimeValueData }) {
  if (data.top_spenders.length === 0) {
    return (
      <Card padding="lg">
        <h3 style={{ margin: 0, fontSize: theme.type.size.md, fontWeight: theme.type.weight.semibold }}>
          Top spenders
        </h3>
        <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
          No patients have spent yet — paid carts will populate this list.
        </p>
      </Card>
    );
  }
  const max = data.top_spenders[0]?.all_time_spend_pence ?? 0;
  return (
    <Card padding="lg">
      <h3
        style={{
          margin: 0,
          fontSize: theme.type.size.md,
          fontWeight: theme.type.weight.semibold,
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[2],
        }}
      >
        <Crown size={16} aria-hidden /> Top spenders
      </h3>
      <p
        style={{
          margin: `${theme.space[1]}px 0 ${theme.space[4]}px`,
          fontSize: theme.type.size.xs,
          color: theme.color.inkMuted,
        }}
      >
        Top 20 patients in this period's cohort, ranked by all-time paid spend.
      </p>
      <ol
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: theme.space[3],
          counterReset: 'rank',
        }}
      >
        {data.top_spenders.map((p, i) => {
          const pct = max > 0 ? (p.all_time_spend_pence / max) * 100 : 0;
          return (
            <li
              key={p.patient_id}
              style={{
                padding: theme.space[3],
                borderRadius: theme.radius.input,
                border: `1px solid ${theme.color.border}`,
                background: theme.color.bg,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  gap: theme.space[3],
                  marginBottom: theme.space[2],
                }}
              >
                <span style={{ fontSize: theme.type.size.sm, fontWeight: theme.type.weight.semibold }}>
                  {i + 1}. {p.display_name}
                </span>
                <span
                  style={{
                    fontSize: theme.type.size.sm,
                    fontWeight: theme.type.weight.semibold,
                    color: theme.color.ink,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {formatPence(p.all_time_spend_pence)}
                </span>
              </div>
              <div
                style={{
                  height: 6,
                  background: theme.color.surface,
                  borderRadius: theme.radius.pill,
                  overflow: 'hidden',
                  marginBottom: theme.space[2],
                }}
              >
                <div
                  style={{
                    width: `${pct}%`,
                    height: '100%',
                    background: theme.color.accent,
                  }}
                />
              </div>
              <p
                style={{
                  margin: 0,
                  fontSize: theme.type.size.xs,
                  color: theme.color.inkMuted,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {p.visits.toLocaleString('en-GB')} visit{p.visits === 1 ? '' : 's'}
                {p.first_visit && p.last_visit
                  ? ` · ${formatVisitDate(p.first_visit)} → ${formatVisitDate(p.last_visit)}`
                  : ''}
              </p>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

function repeatPct(data: LifetimeValueData): number {
  const repeat = data.repeat_distribution
    .filter((b) => b.bucket !== '1 visit')
    .reduce((s, b) => s + b.patients, 0);
  return data.cohort_size > 0 ? (repeat / data.cohort_size) * 100 : 0;
}

function formatGap(days: number): string {
  if (days < 1) return '< 1 day';
  if (days < 30) return `${Math.round(days)} days`;
  if (days < 365) return `${Math.round(days / 7)} weeks`;
  return `${(days / 365).toFixed(1)} years`;
}

function formatVisitDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
