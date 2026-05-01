import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Ban, Banknote, ScrollText, ShieldAlert } from 'lucide-react';
import {
  Button,
  Card,
  EmptyState,
  Skeleton,
  StatCard,
} from '../../components/index.ts';
import { theme } from '../../theme/index.ts';
import { type DateRange, dateRangeLabel } from '../../lib/dateRange.ts';
import {
  type AnomalyData,
  type AnomalyKind,
  useAnomalies,
} from '../../lib/queries/cashCounts.ts';
import { formatNumber, formatPence } from '../../lib/queries/carts.ts';

interface Props {
  range: DateRange;
}

export function AnomaliesTab({ range }: Props) {
  const { data, loading, error } = useAnomalies(range);
  const navigate = useNavigate();

  if (error) {
    return (
      <Card padding="lg">
        <p style={{ margin: 0, color: theme.color.alert }}>
          Could not load anomalies for {dateRangeLabel(range)}: {error}
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
  if (data.flags.length === 0) {
    return (
      <Card padding="lg">
        <EmptyState
          icon={<ShieldAlert size={20} />}
          title="No anomalies in this period"
          description="No discount %, void window, or cash count overdue flags. Quiet is good."
        />
      </Card>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <Counts data={data} />
      <ThresholdBanner data={data} />
      <FlagList
        data={data}
        onOpenVisit={(id) => navigate(`/visit/${id}`)}
      />
    </div>
  );
}

function Counts({ data }: { data: AnomalyData }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: theme.space[3],
      }}
    >
      <StatCard
        label="Discount % flags"
        value={formatNumber(data.counts.discount_above_threshold)}
        delta={`Above ${data.thresholds.discount_pct}% of subtotal`}
        tone={data.counts.discount_above_threshold > 0 ? 'warn' : 'normal'}
        icon={<ScrollText size={14} />}
      />
      <StatCard
        label="Void window flags"
        value={formatNumber(data.counts.void_in_window)}
        delta={`Voided in ≤${data.thresholds.void_window_minutes}m of capture`}
        tone={data.counts.void_in_window > 0 ? 'alert' : 'normal'}
        icon={<Ban size={14} />}
      />
      <StatCard
        label="Cash count flags"
        value={formatNumber(data.counts.cash_count_overdue)}
        delta={`Threshold ${data.thresholds.cash_count_overdue_days} days`}
        tone={data.counts.cash_count_overdue > 0 ? 'warn' : 'normal'}
        icon={<Banknote size={14} />}
      />
    </div>
  );
}

function ThresholdBanner({ data }: { data: AnomalyData }) {
  return (
    <Card padding="md">
      <p
        style={{
          margin: 0,
          fontSize: theme.type.size.xs,
          color: theme.color.inkMuted,
        }}
      >
        Thresholds (configurable in <code>lng_settings</code>): discount %{' '}
        <strong>{data.thresholds.discount_pct}%</strong>, void window{' '}
        <strong>{data.thresholds.void_window_minutes} min</strong>, cash variance{' '}
        <strong>{formatPence(data.thresholds.cash_variance_pence)}</strong>, cash count overdue{' '}
        <strong>{data.thresholds.cash_count_overdue_days} days</strong>.
      </p>
    </Card>
  );
}

function FlagList({ data, onOpenVisit }: { data: AnomalyData; onOpenVisit: (visitId: string) => void }) {
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
        <AlertTriangle size={16} aria-hidden /> Flagged events
      </h3>
      <p style={{ margin: `${theme.space[1]}px 0 ${theme.space[4]}px`, fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
        Newest first. Click "Open visit" to drill into the underlying record.
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
        {data.flags.map((f, i) => (
          <li
            key={`${f.kind}:${f.reference}:${i}`}
            style={{
              padding: theme.space[3],
              borderRadius: theme.radius.input,
              border: `1px solid ${borderForKind(f.kind)}`,
              background: theme.color.bg,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: theme.space[3],
                alignItems: 'baseline',
                flexWrap: 'wrap',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: theme.type.size.sm, fontWeight: theme.type.weight.semibold }}>
                  {f.title}
                </p>
                <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
                  {f.detail}
                </p>
                {f.occurred_at ? (
                  <p
                    style={{
                      margin: `${theme.space[1]}px 0 0`,
                      fontSize: theme.type.size.xs,
                      color: theme.color.inkSubtle,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {new Date(f.occurred_at).toLocaleString('en-GB', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </p>
                ) : null}
              </div>
              {f.visit_id ? (
                <Button variant="tertiary" size="sm" onClick={() => onOpenVisit(f.visit_id!)}>
                  Open visit
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function borderForKind(kind: AnomalyKind): string {
  switch (kind) {
    case 'void_in_window':
      return theme.color.alert;
    case 'discount_above_threshold':
    case 'cash_count_overdue':
    case 'cash_variance_high':
      return theme.color.warn;
  }
}
