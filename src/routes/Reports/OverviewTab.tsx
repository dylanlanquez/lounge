import {
  Calendar,
  Clock,
  Coins,
  CreditCard,
  Sparkles,
  TrendingUp,
  UserPlus,
  Users,
} from 'lucide-react';
import {
  Card,
  EmptyState,
  Skeleton,
  StatCard,
} from '../../components/index.ts';
import { theme } from '../../theme/index.ts';
import { formatNumber, formatPence } from '../../lib/queries/carts.ts';
import {
  type ReportsOverview,
  type TopService,
  useReportsOverview,
} from '../../lib/queries/reports.ts';
import { type DateRange, dateRangeLabel } from '../../lib/dateRange.ts';

interface OverviewTabProps {
  range: DateRange;
}

// Reports → Overview. The first thing a manager sees when opening
// Reports. Everything answers the question "what happened in this
// period?" — visits, money, who was here, what they bought.
//
// Numbers come from useReportsOverview which fans three parallel
// queries against lng_visits, lng_payments, and lng_cart_items
// (joined back to visits) and aggregates client-side. The hook is
// loud about errors — they bubble through to the inline error card
// AND a row in lng_system_failures.

export function OverviewTab({ range }: OverviewTabProps) {
  const { data, loading, error } = useReportsOverview(range);

  if (error) {
    return (
      <Card padding="lg">
        <p style={{ margin: 0, color: theme.color.alert }}>
          Could not load overview for {dateRangeLabel(range)}: {error}
        </p>
      </Card>
    );
  }

  if (loading || !data) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
        <Skeleton height={120} />
        <Skeleton height={200} />
      </div>
    );
  }

  const isEmpty = data.total_visits === 0 && data.payments_count === 0;
  if (isEmpty) {
    return (
      <Card padding="lg">
        <EmptyState
          icon={<Calendar size={20} />}
          title="No activity in this period"
          description="No visits opened and no payments captured. Try a wider date range."
        />
      </Card>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <KpiGrid data={data} />
      <PaymentMixCard data={data} />
      <TopServicesCard services={data.top_services} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// KPI grid — six stat cards covering activity + money in one glance.
// ─────────────────────────────────────────────────────────────────────────────

function KpiGrid({ data }: { data: ReportsOverview }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: theme.space[3],
      }}
    >
      <StatCard
        label="Total visits"
        value={formatNumber(data.total_visits)}
        delta={visitsDelta(data)}
        icon={<Users size={14} />}
      />
      <StatCard
        label="Walk-ins"
        value={formatNumber(data.walk_ins)}
        delta={walkInsDelta(data)}
        icon={<UserPlus size={14} />}
      />
      <StatCard
        label="Scheduled"
        value={formatNumber(data.scheduled)}
        delta={scheduledDelta(data)}
        icon={<Calendar size={14} />}
      />
      <StatCard
        label="Revenue"
        value={formatPence(data.revenue_pence)}
        tone="accent"
        delta={`${formatNumber(data.payments_count)} payments`}
        icon={<Coins size={14} />}
      />
      <StatCard
        label="Average ticket"
        value={data.average_ticket_pence === null ? '—' : formatPence(data.average_ticket_pence)}
        delta={data.average_ticket_pence === null ? 'No paid carts in period' : 'per paid cart'}
        icon={<CreditCard size={14} />}
      />
      <StatCard
        label="Unique patients"
        value={formatNumber(data.unique_patients)}
        delta={uniquePatientsDelta(data)}
        icon={<Sparkles size={14} />}
      />
      {data.best_day ? (
        <StatCard
          label="Busiest day"
          value={formatBestDay(data.best_day.date)}
          delta={`${data.best_day.visits} visits`}
          icon={<TrendingUp size={14} />}
        />
      ) : null}
      <StatCard
        label="Status mix"
        value={statusMixSummary(data.status_mix)}
        delta={data.total_visits === 0 ? 'No visits' : 'across the period'}
        icon={<Clock size={14} />}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Payment mix — money by method, rendered as a horizontal stacked bar
// with a labelled legend underneath.
// ─────────────────────────────────────────────────────────────────────────────

function PaymentMixCard({ data }: { data: ReportsOverview }) {
  const total = Object.values(data.payment_method_mix).reduce((s, v) => s + v, 0);
  if (total === 0) {
    return (
      <Card padding="lg">
        <SectionHeader title="Payment mix" subtitle="No payments captured in this period." />
      </Card>
    );
  }
  const segments = Object.entries(data.payment_method_mix)
    .map(([method, amount]) => ({ method, amount }))
    .sort((a, b) => b.amount - a.amount);
  const colours = methodColourMap(segments.map((s) => s.method));

  return (
    <Card padding="lg">
      <SectionHeader
        title="Payment mix"
        subtitle={`Money in by method, total ${formatPence(total)}`}
      />
      <div
        role="img"
        aria-label="Stacked bar of payment methods by amount"
        style={{
          display: 'flex',
          height: 16,
          width: '100%',
          borderRadius: theme.radius.pill,
          overflow: 'hidden',
          marginTop: theme.space[4],
          background: theme.color.bg,
        }}
      >
        {segments.map((s) => (
          <div
            key={s.method}
            title={`${humaniseMethod(s.method)} — ${formatPence(s.amount)}`}
            style={{
              width: `${(s.amount / total) * 100}%`,
              background: colours[s.method],
              transition: 'width 120ms ease-out',
            }}
          />
        ))}
      </div>
      <ul
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: theme.space[3],
          listStyle: 'none',
          margin: `${theme.space[4]}px 0 0`,
          padding: 0,
        }}
      >
        {segments.map((s) => (
          <li
            key={s.method}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: theme.space[3],
              padding: theme.space[3],
              background: theme.color.bg,
              border: `1px solid ${theme.color.border}`,
              borderRadius: theme.radius.input,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 12,
                height: 12,
                borderRadius: 3,
                background: colours[s.method],
                flexShrink: 0,
              }}
            />
            <div style={{ minWidth: 0, flex: 1 }}>
              <p style={{ margin: 0, fontSize: theme.type.size.sm, fontWeight: theme.type.weight.semibold }}>
                {humaniseMethod(s.method)}
              </p>
              <p
                style={{
                  margin: `${theme.space[1]}px 0 0`,
                  color: theme.color.inkMuted,
                  fontSize: theme.type.size.xs,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {formatPence(s.amount)} · {Math.round((s.amount / total) * 100)}%
              </p>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Top services — top 5 by revenue. Shown with the absolute revenue +
// proportional bar so visual ranking reads at a glance.
// ─────────────────────────────────────────────────────────────────────────────

function TopServicesCard({ services }: { services: TopService[] }) {
  if (services.length === 0) {
    return (
      <Card padding="lg">
        <SectionHeader title="Top services" subtitle="No items recorded in this period." />
      </Card>
    );
  }
  const max = services[0]?.revenue_pence ?? 0;
  return (
    <Card padding="lg">
      <SectionHeader title="Top services" subtitle="Ranked by revenue across paid + unpaid carts." />
      <ul
        style={{
          listStyle: 'none',
          margin: `${theme.space[4]}px 0 0`,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: theme.space[3],
        }}
      >
        {services.map((s, i) => (
          <li key={`${s.catalogue_id ?? 'ad-hoc'}:${s.name}`} style={{ minWidth: 0 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                gap: theme.space[3],
                marginBottom: theme.space[2],
              }}
            >
              <span
                style={{
                  fontSize: theme.type.size.sm,
                  fontWeight: theme.type.weight.semibold,
                  color: theme.color.ink,
                }}
              >
                {i + 1}. {s.name}
              </span>
              <span
                style={{
                  fontSize: theme.type.size.sm,
                  fontWeight: theme.type.weight.semibold,
                  color: theme.color.ink,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {formatPence(s.revenue_pence)}
              </span>
            </div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: theme.space[3],
              }}
            >
              <div
                style={{
                  flex: 1,
                  height: 8,
                  background: theme.color.bg,
                  borderRadius: theme.radius.pill,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: max > 0 ? `${(s.revenue_pence / max) * 100}%` : '0%',
                    height: '100%',
                    background: theme.color.accent,
                  }}
                />
              </div>
              <span
                style={{
                  fontSize: theme.type.size.xs,
                  color: theme.color.inkMuted,
                  fontVariantNumeric: 'tabular-nums',
                  minWidth: 70,
                  textAlign: 'right',
                }}
              >
                {formatNumber(s.count)} sold
              </span>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div>
      <h2 style={{ margin: 0, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold }}>
        {title}
      </h2>
      {subtitle ? (
        <p
          style={{
            margin: `${theme.space[2]}px 0 0`,
            color: theme.color.inkMuted,
            fontSize: theme.type.size.sm,
          }}
        >
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function visitsDelta(data: ReportsOverview): string {
  if (data.total_visits === 0) return 'No visits';
  const wPct = Math.round((data.walk_ins / data.total_visits) * 100);
  const sPct = 100 - wPct;
  return `${wPct}% walk-in · ${sPct}% scheduled`;
}

function walkInsDelta(data: ReportsOverview): string {
  if (data.total_visits === 0) return '0% of visits';
  return `${Math.round((data.walk_ins / data.total_visits) * 100)}% of visits`;
}

function scheduledDelta(data: ReportsOverview): string {
  if (data.total_visits === 0) return '0% of visits';
  return `${Math.round((data.scheduled / data.total_visits) * 100)}% of visits`;
}

function uniquePatientsDelta(data: ReportsOverview): string {
  if (data.total_visits === 0) return 'No patients';
  if (data.unique_patients === data.total_visits) return 'Every visit a different patient';
  const ratio = data.total_visits / data.unique_patients;
  return `Avg ${ratio.toFixed(2)} visits per patient`;
}

function statusMixSummary(mix: Record<string, number>): string {
  if (Object.keys(mix).length === 0) return '—';
  // Show the dominant status with its percent. The full breakdown
  // lives on follow-up pages; here we just want the headline.
  const total = Object.values(mix).reduce((s, v) => s + v, 0);
  const sorted = Object.entries(mix).sort((a, b) => b[1] - a[1]);
  const top = sorted[0];
  if (!top) return '—';
  const pct = Math.round((top[1] / total) * 100);
  return `${humaniseStatus(top[0])} ${pct}%`;
}

function humaniseStatus(status: string): string {
  switch (status) {
    case 'arrived':
      return 'Arrived';
    case 'in_chair':
      return 'In chair';
    case 'complete':
      return 'Complete';
    case 'cancelled':
      return 'Cancelled';
    case 'unsuitable':
      return 'Unsuitable';
    case 'ended_early':
      return 'Ended early';
    case 'free_visit':
      return 'Free';
    default:
      return status;
  }
}

function humaniseMethod(method: string): string {
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

// Stable colour mapping per method. Pulled from the theme rather than
// hardcoded — alert / accent / warn / inkSubtle / ink form a calm
// five-colour palette that reads well on the cream background.
function methodColourMap(methods: string[]): Record<string, string> {
  const palette = [
    theme.color.accent,
    theme.color.warn,
    theme.color.alert,
    theme.color.ink,
    theme.color.inkSubtle,
  ];
  const map: Record<string, string> = {};
  methods.forEach((m, i) => {
    const colour = palette[i % palette.length];
    if (!colour) {
      // Defensive: should be impossible because palette is non-empty,
      // but throw rather than fall back to a default colour silently.
      throw new Error(`No colour available for method index ${i}`);
    }
    map[m] = colour;
  });
  return map;
}

function formatBestDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
  });
}
