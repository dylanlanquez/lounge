import {
  Ban,
  Coins,
  CreditCard,
  Layers,
  ReceiptText,
} from 'lucide-react';
import {
  Card,
  EmptyState,
  LineChart,
  Skeleton,
  StatCard,
} from '../../components/index.ts';
import { theme } from '../../theme/index.ts';
import { type DateRange, dateRangeLabel } from '../../lib/dateRange.ts';
import {
  type FinancialsOverviewData,
  useFinancialsOverview,
} from '../../lib/queries/financials.ts';
import { formatNumber, formatPence, formatPounds } from '../../lib/queries/carts.ts';

interface Props {
  range: DateRange;
}

export function OverviewTab({ range }: Props) {
  const { data, loading, error } = useFinancialsOverview(range);

  if (error) {
    return (
      <Card padding="lg">
        <p style={{ margin: 0, color: theme.color.alert }}>
          Could not load financials overview for {dateRangeLabel(range)}: {error}
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
  if (data.payments_count === 0 && data.voided_count === 0 && data.failed_count === 0) {
    return (
      <Card padding="lg">
        <EmptyState
          icon={<ReceiptText size={20} />}
          title="No payments in this period"
          description="No till activity. Try a wider date range."
        />
      </Card>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <Kpis data={data} />
      <DailyRevenueCard data={data} />
      <MethodMixCard data={data} />
    </div>
  );
}

function Kpis({ data }: { data: FinancialsOverviewData }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: theme.space[3],
      }}
    >
      <StatCard
        label="Revenue"
        value={formatPence(data.total_revenue_pence)}
        delta={`${formatNumber(data.payments_count)} payment${data.payments_count === 1 ? '' : 's'}`}
        tone="accent"
        icon={<Coins size={14} />}
      />
      <StatCard
        label="Average ticket"
        value={
          data.payments_count === 0
            ? '—'
            : formatPence(Math.round(data.total_revenue_pence / data.payments_count))
        }
        delta="per succeeded payment"
        icon={<CreditCard size={14} />}
      />
      <StatCard
        label="Voids"
        value={formatNumber(data.voided_count)}
        delta={data.voided_count === 0 ? 'No voids' : `worth ${formatPence(data.voided_pence)}`}
        tone={data.voided_count > 0 ? 'warn' : 'normal'}
        icon={<Ban size={14} />}
      />
      <StatCard
        label="Failed payments"
        value={formatNumber(data.failed_count)}
        delta="surface in the Sales log"
        tone={data.failed_count > 0 ? 'alert' : 'normal'}
        icon={<Layers size={14} />}
      />
    </div>
  );
}

function DailyRevenueCard({ data }: { data: FinancialsOverviewData }) {
  return (
    <Card padding="lg">
      <LineChart
        title="Daily revenue"
        subtitle="Sum of succeeded payments per calendar day. Legend shows the period total."
        xLabels={data.daily.map((d) => formatShort(d.date))}
        series={[
          {
            id: 'revenue',
            label: 'Revenue',
            colour: theme.color.accent,
            values: data.daily.map((d) => d.pence / 100),
            // Currency formatter — y-axis ticks AND the legend total
            // both render as "£525.00" because every series shares
            // the same formatValue reference.
            formatValue: formatPounds,
          },
        ]}
        legendMode="total"
        ariaSummary={`Daily revenue from ${data.daily[0]?.date ?? ''} to ${data.daily[data.daily.length - 1]?.date ?? ''}.`}
      />
    </Card>
  );
}

function MethodMixCard({ data }: { data: FinancialsOverviewData }) {
  if (data.method_mix.length === 0) return null;
  const total = data.method_mix.reduce((s, m) => s + m.pence, 0);
  return (
    <Card padding="lg">
      <h3 style={{ margin: 0, fontSize: theme.type.size.md, fontWeight: theme.type.weight.semibold }}>
        Payment method mix
      </h3>
      <p
        style={{
          margin: `${theme.space[1]}px 0 ${theme.space[4]}px`,
          fontSize: theme.type.size.xs,
          color: theme.color.inkMuted,
        }}
      >
        Money in by method. Cash / card / BNPL all aggregate here.
      </p>
      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: theme.space[3],
        }}
      >
        {data.method_mix.map((m) => {
          const pct = total > 0 ? (m.pence / total) * 100 : 0;
          return (
            <li key={m.method} style={{ minWidth: 0 }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: theme.space[3],
                  marginBottom: theme.space[2],
                }}
              >
                <span style={{ fontSize: theme.type.size.sm, fontWeight: theme.type.weight.semibold }}>
                  {humanise(m.method)}
                </span>
                <span style={{ fontSize: theme.type.size.sm, fontVariantNumeric: 'tabular-nums' }}>
                  {formatPence(m.pence)} · {pct.toFixed(0)}%
                </span>
              </div>
              <div
                style={{
                  height: 8,
                  background: theme.color.bg,
                  borderRadius: theme.radius.pill,
                  overflow: 'hidden',
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
              <p style={{ margin: `${theme.space[2]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
                {formatNumber(m.count)} payment{m.count === 1 ? '' : 's'}
              </p>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function humanise(method: string): string {
  switch (method) {
    case 'cash':
      return 'Cash';
    case 'card_terminal':
      return 'Card';
    case 'gift_card':
      return 'Gift card';
    case 'account_credit':
      return 'Account credit';
    default:
      return method;
  }
}

function formatShort(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
