import { Ban, Download, RotateCcw } from 'lucide-react';
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
  type RefundRow,
  type RefundsData,
  type VoidRow,
  type VoidsData,
  useFinancialsRefunds,
  useFinancialsVoids,
} from '../../lib/queries/financials.ts';
import { formatNumber, formatPence } from '../../lib/queries/carts.ts';
import { csvFilename, downloadCsv, toCsv, type CsvColumn } from '../../lib/csv.ts';

interface Props {
  range: DateRange;
}

const SAME_DAY_WINDOW_MINUTES = 60;

export function VoidsTab({ range }: Props) {
  const { data, loading, error } = useFinancialsVoids(range, SAME_DAY_WINDOW_MINUTES);
  const refunds = useFinancialsRefunds(range);

  if (error) {
    return (
      <Card padding="lg">
        <p style={{ margin: 0, color: theme.color.alert }}>
          Could not load voids for {dateRangeLabel(range)}: {error}
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

  const hasVoids = data.rows.length > 0;
  const hasRefunds = (refunds.data?.rows.length ?? 0) > 0;

  const exportVoidsCsv = () => {
    const columns: CsvColumn<VoidRow>[] = [
      { key: 'cancelled_at', label: 'Cancelled at' },
      { key: 'patient_name', label: 'Patient' },
      { key: 'method', label: 'Method' },
      { key: 'amount_pence', label: 'Amount (£)', format: (v) => (Number(v) / 100).toFixed(2) },
      { key: 'reason', label: 'Reason' },
      { key: 'minutes_to_void', label: 'Minutes after capture', format: (v) => (v === null || v === undefined ? '' : String(v)) },
      { key: 'taken_by_name', label: 'Originally taken by' },
    ];
    downloadCsv(csvFilename('financials_voids', range), toCsv(data.rows, columns));
  };

  const exportRefundsCsv = () => {
    if (!refunds.data) return;
    const columns: CsvColumn<RefundRow>[] = [
      { key: 'refunded_at', label: 'Refunded at' },
      { key: 'source_kind', label: 'Source' },
      { key: 'method', label: 'Method' },
      { key: 'amount_pence', label: 'Amount (£)', format: (v) => (Number(v) / 100).toFixed(2) },
      { key: 'reason_category', label: 'Category' },
      { key: 'reason_note', label: 'Reason' },
    ];
    downloadCsv(
      csvFilename('financials_refunds', range),
      toCsv(refunds.data.rows, columns),
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <Kpis data={data} refunds={refunds.data} refundsLoading={refunds.loading} />
      {hasVoids ? <VoidsList data={data} onExport={exportVoidsCsv} /> : null}
      {refunds.data && hasRefunds ? (
        <RefundsList data={refunds.data} onExport={exportRefundsCsv} />
      ) : null}
      {!hasVoids && !hasRefunds && !refunds.loading ? (
        <Card padding="lg">
          <EmptyState
            icon={<Ban size={20} />}
            title="No voids or refunds in this period"
            description="No money has gone back to a patient. Try a wider date range."
          />
        </Card>
      ) : null}
    </div>
  );
}

function Kpis({
  data,
  refunds,
  refundsLoading,
}: {
  data: VoidsData;
  refunds: RefundsData | null;
  refundsLoading: boolean;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: theme.space[3],
      }}
    >
      <StatCard label="Total voids" value={formatNumber(data.count)} icon={<Ban size={14} />} />
      <StatCard
        label="Total voided"
        value={formatPence(data.total_amount_pence)}
        delta="full payments cancelled"
        tone={data.total_amount_pence > 0 ? 'warn' : 'normal'}
      />
      <StatCard
        label={`Voided in ≤${SAME_DAY_WINDOW_MINUTES}m`}
        value={formatNumber(data.same_day_count)}
        delta="captured then immediately voided"
        tone={data.same_day_count > 0 ? 'alert' : 'normal'}
      />
      <StatCard
        label="Refunds issued"
        value={refundsLoading ? '…' : formatNumber(refunds?.count ?? 0)}
        icon={<RotateCcw size={14} />}
      />
      <StatCard
        label="Total refunded"
        value={refundsLoading ? '…' : formatPence(refunds?.total_amount_pence ?? 0)}
        delta="partial + deposit refunds"
        tone={(refunds?.total_amount_pence ?? 0) > 0 ? 'warn' : 'normal'}
      />
    </div>
  );
}

function VoidsList({ data, onExport }: { data: VoidsData; onExport: () => void }) {
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
            Void log
          </h3>
          <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
            Newest first. Quick voids (within {SAME_DAY_WINDOW_MINUTES}m of capture) flag amber.
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
        {data.rows.map((v) => {
          const isQuick = v.minutes_to_void !== null && v.minutes_to_void <= SAME_DAY_WINDOW_MINUTES;
          return (
            <li
              key={v.id}
              style={{
                padding: theme.space[3],
                borderRadius: theme.radius.input,
                border: `1px solid ${isQuick ? theme.color.warn : theme.color.border}`,
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
                    {v.patient_name}
                  </p>
                  <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.inkMuted, fontVariantNumeric: 'tabular-nums' }}>
                    {new Date(v.cancelled_at).toLocaleString('en-GB', {
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
                      color: theme.color.alert,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    −{formatPence(v.amount_pence)}
                  </p>
                  <StatusPill tone={isQuick ? 'no_show' : 'cancelled'} size="sm">
                    {humaniseMethod(v.method)}{v.minutes_to_void !== null ? ` · ${v.minutes_to_void}m after capture` : ' · pre-capture'}
                  </StatusPill>
                </div>
              </div>
              <p style={{ margin: `${theme.space[2]}px 0 0`, fontSize: theme.type.size.sm, color: theme.color.ink }}>
                "{v.reason}"
              </p>
              <p style={{ margin: `${theme.space[2]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
                Originally taken by <strong>{v.taken_by_name}</strong>
              </p>
            </li>
          );
        })}
      </ul>
    </Card>
  );
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

const REFUND_CATEGORY_LABELS: Record<string, string> = {
  item_removed: 'Item removed',
  visit_cancelled: 'Visit cancelled',
  visit_ended_early: 'Visit ended early',
  service_not_delivered: 'Service not delivered',
  patient_request: 'Patient request',
  cart_correction: 'Cart correction',
  other: 'Other',
};

function RefundsList({
  data,
  onExport,
}: {
  data: RefundsData;
  onExport: () => void;
}) {
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
            Refund log
          </h3>
          <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
            Partial + deposit refunds issued via the till / appointment refund flows. Newest first.
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
        {data.rows.map((r) => (
          <li
            key={r.id}
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
                  {REFUND_CATEGORY_LABELS[r.reason_category] ?? r.reason_category}
                </p>
                <p
                  style={{
                    margin: `${theme.space[1]}px 0 0`,
                    fontSize: theme.type.size.xs,
                    color: theme.color.inkMuted,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {new Date(r.refunded_at).toLocaleString('en-GB', {
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
                    color: theme.color.alert,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  −{formatPence(r.amount_pence)}
                </p>
                <StatusPill tone="cancelled" size="sm">
                  {r.source_kind === 'deposit' ? 'Online deposit' : humaniseMethod(r.method)}
                </StatusPill>
              </div>
            </div>
            {r.reason_note ? (
              <p style={{ margin: `${theme.space[2]}px 0 0`, fontSize: theme.type.size.sm, color: theme.color.ink }}>
                "{r.reason_note}"
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}
