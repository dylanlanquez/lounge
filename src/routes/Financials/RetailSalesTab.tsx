import { Download, ShoppingBag } from 'lucide-react';
import { Button, Card, EmptyState, Skeleton, StatCard, StatusPill } from '../../components/index.ts';
import { theme } from '../../theme/index.ts';
import { type DateRange, dateRangeLabel } from '../../lib/dateRange.ts';
import { type RetailSaleRow, useFinancialsRetail } from '../../lib/queries/financials.ts';
import { formatNumber, formatPence } from '../../lib/queries/carts.ts';
import { csvFilename, downloadCsv, toCsv, type CsvColumn } from '../../lib/csv.ts';
import { fmtTzAbbr } from '../../lib/dateFormat.ts';

interface Props {
  range: DateRange;
}

// Reports → Retail sales. Counter (Quick Sale) takings: headline KPIs,
// the products that sold, and a per-sale log. Mirrors the Sales tab's
// layout so the two read as one family.
export function RetailSalesTab({ range }: Props) {
  const { data, loading, error } = useFinancialsRetail(range);

  if (error) {
    return (
      <Card padding="lg">
        <p style={{ margin: 0, color: theme.color.alert }}>
          Could not load retail sales for {dateRangeLabel(range)}: {error}
        </p>
      </Card>
    );
  }

  if (loading || !data) {
    return <Skeleton height={240} />;
  }

  if (data.sales_count === 0) {
    return (
      <Card padding="lg">
        <EmptyState
          icon={<ShoppingBag size={20} />}
          title="No retail sales in this period"
          description="Counter product sales taken through Quick Sale will appear here. Try a wider date range."
        />
      </Card>
    );
  }

  const exportCsv = () => {
    const columns: CsvColumn<RetailSaleRow>[] = [
      { key: 'sale_date', label: 'Date', format: (v) => new Date(String(v)).toISOString() },
      { key: 'customer', label: 'Customer' },
      { key: 'items_summary', label: 'Items' },
      { key: 'total_pence', label: 'Total (£)', format: (v) => (Number(v) / 100).toFixed(2) },
      { key: 'cart_status', label: 'Status' },
      { key: 'payment_methods', label: 'Methods' },
    ];
    downloadCsv(csvFilename('retail_sales', range), toCsv(data.rows, columns));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      {/* KPI strip */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: theme.space[3],
        }}
      >
        <StatCard label="Sales" value={formatNumber(data.sales_count)} delta={`${formatNumber(data.paid_count)} paid in full`} />
        <StatCard label="Revenue" value={formatPence(data.revenue_pence)} tone="accent" />
        <StatCard
          label="Average sale"
          value={data.average_sale_pence == null ? '—' : formatPence(data.average_sale_pence)}
        />
        <StatCard label="Units sold" value={formatNumber(data.units_sold)} />
      </div>

      {/* Top products */}
      {data.top_products.length > 0 ? (
        <Card padding="lg">
          <h3 style={{ margin: 0, fontSize: theme.type.size.md, fontWeight: theme.type.weight.semibold }}>
            Top products
          </h3>
          <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
            By revenue across the period.
          </p>
          <div style={{ marginTop: theme.space[4], overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: theme.type.size.sm }}>
              <thead>
                <tr>
                  <th style={th}>Product</th>
                  <th style={{ ...th, textAlign: 'right' }}>Units</th>
                  <th style={{ ...th, textAlign: 'right' }}>Revenue</th>
                </tr>
              </thead>
              <tbody>
                {data.top_products.map((p) => (
                  <tr key={p.catalogue_id ?? p.name} style={{ borderTop: `1px solid ${theme.color.border}` }}>
                    <td style={td}>{p.name}</td>
                    <td style={tdRight}>{formatNumber(p.units)}</td>
                    <td style={{ ...tdRight, fontWeight: theme.type.weight.semibold }}>{formatPence(p.revenue_pence)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {/* Sales log */}
      <Card padding="lg">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: theme.space[3], flexWrap: 'wrap' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: theme.type.size.md, fontWeight: theme.type.weight.semibold }}>
              Sales log
            </h3>
            <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
              One row per counter sale, newest first.
            </p>
          </div>
          <Button variant="tertiary" size="sm" onClick={exportCsv}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
              <Download size={14} aria-hidden /> Download CSV
            </span>
          </Button>
        </div>
        <div style={{ marginTop: theme.space[4], overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: theme.type.size.sm }}>
            <thead>
              <tr>
                <th style={th}>Date</th>
                <th style={th}>Customer</th>
                <th style={th}>Items</th>
                <th style={{ ...th, textAlign: 'right' }}>Total</th>
                <th style={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.visit_id} style={{ borderTop: `1px solid ${theme.color.border}` }}>
                  <td style={td}>{formatDate(r.sale_date)}</td>
                  <td style={{ ...td, fontWeight: theme.type.weight.semibold }}>{r.customer}</td>
                  <td style={td}>
                    <div>{r.items_summary}</div>
                    {r.payment_methods ? (
                      <div style={{ fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>{r.payment_methods}</div>
                    ) : null}
                  </td>
                  <td style={{ ...tdRight, fontWeight: theme.type.weight.semibold }}>{formatPence(r.total_pence)}</td>
                  <td style={td}>
                    <CartStatusPill status={r.cart_status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

const th = {
  textAlign: 'left' as const,
  fontSize: theme.type.size.xs,
  fontWeight: theme.type.weight.semibold,
  color: theme.color.inkMuted,
  textTransform: 'uppercase' as const,
  letterSpacing: theme.type.tracking.wide,
  padding: `${theme.space[3]}px ${theme.space[4]}px`,
  whiteSpace: 'nowrap' as const,
};

const td = {
  padding: `${theme.space[3]}px ${theme.space[4]}px`,
  fontSize: theme.type.size.sm,
  color: theme.color.ink,
  verticalAlign: 'top' as const,
  lineHeight: 1.5,
};

const tdRight = {
  ...td,
  textAlign: 'right' as const,
  fontVariantNumeric: 'tabular-nums' as const,
  whiteSpace: 'nowrap' as const,
};

function CartStatusPill({ status }: { status: string }) {
  switch (status) {
    case 'paid':
      return <StatusPill tone="arrived" size="sm">Paid</StatusPill>;
    case 'voided':
      return <StatusPill tone="cancelled" size="sm">Voided</StatusPill>;
    case 'open':
      return <StatusPill tone="pending" size="sm">Owed</StatusPill>;
    default:
      return <StatusPill tone="neutral" size="sm">{status}</StatusPill>;
  }
}

function formatDate(iso: string): string {
  const stamp = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
  return `${stamp} ${fmtTzAbbr(iso)}`;
}
