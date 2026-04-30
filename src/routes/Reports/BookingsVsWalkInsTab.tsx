import {
  BarChart,
  Card,
  EmptyState,
  Funnel,
  LineChart,
  Skeleton,
  StatCard,
} from '../../components/index.ts';
import { theme } from '../../theme/index.ts';
import { type DateRange, dateRangeLabel } from '../../lib/dateRange.ts';
import {
  type BookingsVsWalkInsData,
  useReportsBookingsVsWalkIns,
} from '../../lib/queries/reports.ts';
import { formatPence } from '../../lib/queries/carts.ts';
import { Calendar, UserPlus, UserX } from 'lucide-react';

interface Props {
  range: DateRange;
}

export function BookingsVsWalkInsTab({ range }: Props) {
  const { data, loading, error } = useReportsBookingsVsWalkIns(range);

  if (error) {
    return (
      <Card padding="lg">
        <p style={{ margin: 0, color: theme.color.alert }}>
          Could not load report for {dateRangeLabel(range)}: {error}
        </p>
      </Card>
    );
  }
  if (loading || !data) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
        <Skeleton height={120} />
        <Skeleton height={300} />
        <Skeleton height={200} />
      </div>
    );
  }

  if (data.total_booked === 0 && data.total_walk_in === 0) {
    return (
      <Card padding="lg">
        <EmptyState
          icon={<Calendar size={20} />}
          title="No activity in this period"
          description="No appointments or walk-ins. Try a wider date range."
        />
      </Card>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <Kpis data={data} />
      <DailySeriesCard data={data} />
      <FunnelCard data={data} />
      <HourDistributionCard data={data} />
      <AvgTicketCard data={data} />
    </div>
  );
}

function Kpis({ data }: { data: BookingsVsWalkInsData }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: theme.space[3],
      }}
    >
      <StatCard
        label="Booked"
        value={data.total_booked.toLocaleString('en-GB')}
        delta={`${data.no_show_count} no-show${data.no_show_count === 1 ? '' : 's'}`}
        icon={<Calendar size={14} />}
      />
      <StatCard
        label="Walk-ins"
        value={data.total_walk_in.toLocaleString('en-GB')}
        delta={data.total_booked + data.total_walk_in === 0
          ? 'No visits'
          : `${Math.round((data.total_walk_in / (data.total_booked + data.total_walk_in)) * 100)}% of activity`}
        icon={<UserPlus size={14} />}
      />
      <StatCard
        label="No-show rate"
        value={data.total_booked === 0 ? '—' : `${(data.no_show_rate * 100).toFixed(1)}%`}
        delta={data.total_booked === 0 ? 'No bookings' : `out of ${data.total_booked.toLocaleString('en-GB')} booked`}
        tone={data.no_show_rate > 0.15 ? 'warn' : 'normal'}
        icon={<UserX size={14} />}
      />
      <StatCard
        label="Booking conversion"
        value={
          data.total_booked === 0
            ? '—'
            : `${(((data.funnel.find((f) => f.id === 'complete')?.count ?? 0) / data.total_booked) * 100).toFixed(0)}%`
        }
        delta="booked → completed"
      />
    </div>
  );
}

function DailySeriesCard({ data }: { data: BookingsVsWalkInsData }) {
  const xLabels = data.daily.map((d) => formatShort(d.date));
  return (
    <Card padding="lg">
      <LineChart
        title="Volume over time"
        subtitle="Daily count of new bookings vs walk-ins."
        xLabels={xLabels}
        ariaSummary={`Line chart showing daily bookings and walk-ins from ${data.daily[0]?.date ?? ''} to ${
          data.daily[data.daily.length - 1]?.date ?? ''
        }.`}
        series={[
          {
            id: 'booked',
            label: 'Booked',
            colour: theme.color.accent,
            values: data.daily.map((d) => d.booked),
          },
          {
            id: 'walk_in',
            label: 'Walk-in',
            colour: theme.color.warn,
            values: data.daily.map((d) => d.walk_in),
          },
        ]}
      />
    </Card>
  );
}

function FunnelCard({ data }: { data: BookingsVsWalkInsData }) {
  return (
    <Card padding="lg">
      <Funnel
        title="Booking funnel"
        subtitle="Each stage is a strict subset of the previous. Drop-off rates show the conversion between adjacent stages."
        stages={data.funnel}
        ariaSummary="Vertical funnel from booked to arrived to in chair to completed appointments."
      />
    </Card>
  );
}

function HourDistributionCard({ data }: { data: BookingsVsWalkInsData }) {
  // Trim leading + trailing all-zero hours so the x-axis only shows
  // the active part of the day. Keeps the chart readable in clinics
  // open 9-5 without forcing a full 24-bar view.
  const trimmed = trimZeroBookends(data.walk_in_hour_distribution);
  return (
    <Card padding="lg">
      <BarChart
        title="Walk-ins by hour of day"
        subtitle="Local time. Helps with staffing — peak hour is the bar at the top of the chart."
        bars={trimmed.map((h) => ({
          id: `hour-${h.hour}`,
          label: `${h.hour}:00`,
          value: h.count,
          colour: theme.color.warn,
        }))}
        ariaSummary="Bar chart of walk-in arrivals by local hour of day."
      />
    </Card>
  );
}

function AvgTicketCard({ data }: { data: BookingsVsWalkInsData }) {
  return (
    <Card padding="lg">
      <h3 style={{ margin: 0, fontSize: theme.type.size.md, fontWeight: theme.type.weight.semibold }}>
        Average ticket by arrival type
      </h3>
      <p
        style={{
          margin: `${theme.space[1]}px 0 ${theme.space[4]}px`,
          fontSize: theme.type.size.xs,
          color: theme.color.inkMuted,
        }}
      >
        Mean total of paid carts. Open or voided carts excluded.
      </p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: theme.space[3],
        }}
      >
        <StatCard
          label="Walk-in avg ticket"
          value={data.walk_in_avg_ticket_pence === null ? '—' : formatPence(data.walk_in_avg_ticket_pence)}
          delta={data.walk_in_avg_ticket_pence === null ? 'No paid walk-in carts' : 'per paid walk-in cart'}
          tone="accent"
          icon={<UserPlus size={14} />}
        />
        <StatCard
          label="Scheduled avg ticket"
          value={data.scheduled_avg_ticket_pence === null ? '—' : formatPence(data.scheduled_avg_ticket_pence)}
          delta={data.scheduled_avg_ticket_pence === null ? 'No paid scheduled carts' : 'per paid scheduled cart'}
          tone="accent"
          icon={<Calendar size={14} />}
        />
      </div>
    </Card>
  );
}

function formatShort(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
  });
}

function trimZeroBookends<T extends { count: number }>(arr: T[]): T[] {
  let start = 0;
  while (start < arr.length && (arr[start]?.count ?? 0) === 0) start += 1;
  let end = arr.length - 1;
  while (end > start && (arr[end]?.count ?? 0) === 0) end -= 1;
  if (start === arr.length) return arr; // all zero — show the whole 24h block
  return arr.slice(start, end + 1);
}
