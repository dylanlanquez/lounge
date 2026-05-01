import { Crown, Download, ScrollText } from 'lucide-react';
import {
  Button,
  Card,
  EmptyState,
  Skeleton,
  StatCard,
  StatusPill,
} from '../../components/index.ts';
import { theme } from '../../theme/index.ts';
import { type DateRange, dateRangeLabel } from '../../lib/dateRange.ts';
import {
  type DiscountRow,
  type DiscountsData,
  useFinancialsDiscounts,
} from '../../lib/queries/financials.ts';
import { formatNumber, formatPence } from '../../lib/queries/carts.ts';
import { csvFilename, downloadCsv, toCsv, type CsvColumn } from '../../lib/csv.ts';

interface Props {
  range: DateRange;
}

export function DiscountsTab({ range }: Props) {
  const { data, loading, error } = useFinancialsDiscounts(range);

  if (error) {
    return (
      <Card padding="lg">
        <p style={{ margin: 0, color: theme.color.alert }}>
          Could not load discounts for {dateRangeLabel(range)}: {error}
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
  if (data.rows.length === 0) {
    return (
      <Card padding="lg">
        <EmptyState
          icon={<ScrollText size={20} />}
          title="No discounts in this period"
          description="No cart-level discounts were applied. Try a wider date range."
        />
      </Card>
    );
  }

  const exportCsv = () => {
    const columns: CsvColumn<DiscountRow>[] = [
      { key: 'applied_at', label: 'Applied at' },
      { key: 'patient_name', label: 'Patient' },
      { key: 'amount_pence', label: 'Amount (£)', format: (v) => (Number(v) / 100).toFixed(2) },
      { key: 'reason', label: 'Reason' },
      { key: 'approver_name', label: 'Approved by' },
      { key: 'applier_name', label: 'Applied by' },
      { key: 'removed_at', label: 'Removed at' },
      { key: 'removed_reason', label: 'Removed reason' },
    ];
    downloadCsv(csvFilename('financials_discounts', range), toCsv(data.rows, columns));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <Kpis data={data} />
      <ApproverLeaderboard data={data} />
      <DiscountsList data={data} onExport={exportCsv} />
    </div>
  );
}

function Kpis({ data }: { data: DiscountsData }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: theme.space[3],
      }}
    >
      <StatCard
        label="Total discounted"
        value={formatPence(data.total_amount_pence)}
        delta={`${formatNumber(data.rows.length)} discount${data.rows.length === 1 ? '' : 's'}`}
        tone="warn"
      />
      <StatCard
        label="Active"
        value={formatNumber(data.active_count)}
        delta="not removed"
      />
      <StatCard
        label="Removed"
        value={formatNumber(data.removed_count)}
        delta="reverted before payment"
      />
      <StatCard
        label="Approvers"
        value={formatNumber(data.approver_leaderboard.length)}
        delta="distinct managers signed off"
        icon={<Crown size={14} />}
      />
    </div>
  );
}

function ApproverLeaderboard({ data }: { data: DiscountsData }) {
  if (data.approver_leaderboard.length === 0) return null;
  const max = data.approver_leaderboard[0]?.total_pence ?? 0;
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
        <Crown size={16} aria-hidden /> Discount approvers
      </h3>
      <p
        style={{
          margin: `${theme.space[1]}px 0 ${theme.space[4]}px`,
          fontSize: theme.type.size.xs,
          color: theme.color.inkMuted,
        }}
      >
        Per-approver totals so a manager who signs off disproportionately many discounts is visible at a glance. Anti-collusion signal — not an indictment, just a number.
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
        {data.approver_leaderboard.map((entry) => {
          const pct = max > 0 ? (entry.total_pence / max) * 100 : 0;
          return (
            <li key={entry.name} style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: theme.space[3], marginBottom: theme.space[2] }}>
                <span style={{ fontSize: theme.type.size.sm, fontWeight: theme.type.weight.semibold }}>{entry.name}</span>
                <span style={{ fontSize: theme.type.size.sm, fontVariantNumeric: 'tabular-nums' }}>
                  {formatNumber(entry.count)} signed · {formatPence(entry.total_pence)}
                </span>
              </div>
              <div
                style={{
                  height: 6,
                  background: theme.color.bg,
                  borderRadius: theme.radius.pill,
                  overflow: 'hidden',
                }}
              >
                <div style={{ width: `${pct}%`, height: '100%', background: theme.color.accent }} />
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function DiscountsList({ data, onExport }: { data: DiscountsData; onExport: () => void }) {
  return (
    <Card padding="lg">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: theme.space[3],
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h3 style={{ margin: 0, fontSize: theme.type.size.md, fontWeight: theme.type.weight.semibold }}>
            Discount log
          </h3>
          <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
            One row per applied discount. Newest first.
          </p>
        </div>
        <Button variant="tertiary" size="sm" onClick={onExport}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
            <Download size={14} aria-hidden /> Download CSV
          </span>
        </Button>
      </div>
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
        {data.rows.map((d) => (
          <li
            key={d.id}
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
                flexWrap: 'wrap',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: theme.type.size.sm, fontWeight: theme.type.weight.semibold }}>
                  {d.patient_name}
                </p>
                <p
                  style={{
                    margin: `${theme.space[1]}px 0 0`,
                    fontSize: theme.type.size.xs,
                    color: theme.color.inkMuted,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {new Date(d.applied_at).toLocaleString('en-GB', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </p>
              </div>
              <div style={{ textAlign: 'right' }}>
                <p
                  style={{
                    margin: 0,
                    fontSize: theme.type.size.md,
                    fontWeight: theme.type.weight.semibold,
                    color: theme.color.warn,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  −{formatPence(d.amount_pence)}
                </p>
                {d.removed_at ? (
                  <StatusPill tone="cancelled" size="sm">Removed</StatusPill>
                ) : (
                  <StatusPill tone="arrived" size="sm">Active</StatusPill>
                )}
              </div>
            </div>
            <p style={{ margin: `${theme.space[2]}px 0 0`, fontSize: theme.type.size.sm, color: theme.color.ink }}>
              "{d.reason}"
            </p>
            <p style={{ margin: `${theme.space[2]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
              Approved by <strong>{d.approver_name}</strong> · Applied by <strong>{d.applier_name}</strong>
              {d.removed_at && d.removed_reason ? ` · Removed: "${d.removed_reason}"` : ''}
            </p>
          </li>
        ))}
      </ul>
    </Card>
  );
}
