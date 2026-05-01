import { Layers, Percent, Sparkles } from 'lucide-react';
import {
  Card,
  EmptyState,
  Skeleton,
  StatCard,
} from '../../components/index.ts';
import { theme } from '../../theme/index.ts';
import { type DateRange, dateRangeLabel } from '../../lib/dateRange.ts';
import {
  type ServiceMixData,
  useReportsServices,
} from '../../lib/queries/reports.ts';
import { formatNumber, formatPence } from '../../lib/queries/carts.ts';

interface Props {
  range: DateRange;
}

export function ServiceMixTab({ range }: Props) {
  const { data, loading, error } = useReportsServices(range);

  if (error) {
    return (
      <Card padding="lg">
        <p style={{ margin: 0, color: theme.color.alert }}>
          Could not load service mix for {dateRangeLabel(range)}: {error}
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
  if (data.total_items === 0) {
    return (
      <Card padding="lg">
        <EmptyState
          icon={<Layers size={20} />}
          title="No items in this period"
          description="No catalogue lines were sold. Try a wider date range."
        />
      </Card>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <Kpis data={data} />
      <CategoryDistributionCard data={data} />
      <TopLinesCard data={data} />
    </div>
  );
}

function Kpis({ data }: { data: ServiceMixData }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: theme.space[3],
      }}
    >
      <StatCard
        label="Items sold"
        value={formatNumber(data.total_items)}
        delta={`across ${data.category_distribution.length} categor${
          data.category_distribution.length === 1 ? 'y' : 'ies'
        }`}
        icon={<Layers size={14} />}
      />
      <StatCard
        label="Revenue"
        value={formatPence(data.total_revenue_pence)}
        delta={data.total_items > 0 ? `${formatPence(Math.round(data.total_revenue_pence / data.total_items))} per item` : '—'}
        tone="accent"
      />
      <StatCard
        label="Top category"
        value={data.category_distribution[0]?.category ?? '—'}
        delta={
          data.category_distribution[0]
            ? `${formatPence(data.category_distribution[0].revenue_pence)}`
            : '—'
        }
        icon={<Sparkles size={14} />}
      />
    </div>
  );
}

function CategoryDistributionCard({ data }: { data: ServiceMixData }) {
  const max = data.category_distribution[0]?.revenue_pence ?? 0;
  const total = data.category_distribution.reduce((s, c) => s + c.revenue_pence, 0);
  return (
    <Card padding="lg">
      <h3 style={{ margin: 0, fontSize: theme.type.size.md, fontWeight: theme.type.weight.semibold }}>
        Revenue by category
      </h3>
      <p
        style={{
          margin: `${theme.space[1]}px 0 ${theme.space[4]}px`,
          fontSize: theme.type.size.xs,
          color: theme.color.inkMuted,
        }}
      >
        Catalogue category preferred; falls back to humanised service_type, then "Other" for ad-hoc lines.
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
        {data.category_distribution.map((c) => {
          const pct = max > 0 ? (c.revenue_pence / max) * 100 : 0;
          const sharePct = total > 0 ? (c.revenue_pence / total) * 100 : 0;
          return (
            <li key={c.category} style={{ minWidth: 0 }}>
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
                  {c.category}
                </span>
                <span style={{ fontSize: theme.type.size.sm, fontVariantNumeric: 'tabular-nums' }}>
                  {formatPence(c.revenue_pence)} · {sharePct.toFixed(0)}%
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
              <p
                style={{
                  margin: `${theme.space[2]}px 0 0`,
                  fontSize: theme.type.size.xs,
                  color: theme.color.inkMuted,
                }}
              >
                {formatNumber(c.count)} item{c.count === 1 ? '' : 's'}
              </p>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function TopLinesCard({ data }: { data: ServiceMixData }) {
  return (
    <Card padding="lg">
      <h3 style={{ margin: 0, fontSize: theme.type.size.md, fontWeight: theme.type.weight.semibold }}>
        Top services
      </h3>
      <p
        style={{
          margin: `${theme.space[1]}px 0 ${theme.space[4]}px`,
          fontSize: theme.type.size.xs,
          color: theme.color.inkMuted,
        }}
      >
        Top 10 catalogue lines by revenue. The discount column shows the share of carts where this line had a line-level OR cart-level discount applied.
      </p>
      <div
        role="table"
        aria-label="Top services table"
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr auto auto auto auto',
          gap: theme.space[3],
          alignItems: 'center',
          rowGap: theme.space[3],
        }}
      >
        <span style={headerStyle}>Service</span>
        <span style={{ ...headerStyle, textAlign: 'right' }}>Sold</span>
        <span style={{ ...headerStyle, textAlign: 'right' }}>Avg price</span>
        <span style={{ ...headerStyle, textAlign: 'right' }}>Revenue</span>
        <span style={{ ...headerStyle, textAlign: 'right' }}>Discount %</span>
        {data.top_lines.map((line, i) => (
          <RowFragment key={`${line.catalogue_id ?? 'ad-hoc'}:${line.name}:${i}`} index={i + 1}>
            <span style={cellStyle}>{line.name}</span>
            <span style={{ ...cellStyle, textAlign: 'right' }}>
              {formatNumber(line.count)}
            </span>
            <span style={{ ...cellStyle, textAlign: 'right' }}>
              {formatPence(line.avg_price_pence)}
            </span>
            <span style={{ ...cellStyle, textAlign: 'right', fontWeight: theme.type.weight.semibold }}>
              {formatPence(line.revenue_pence)}
            </span>
            <span
              style={{
                ...cellStyle,
                textAlign: 'right',
                color: line.discount_share > 0.5 ? theme.color.warn : theme.color.inkMuted,
              }}
            >
              <Percent size={11} aria-hidden style={{ verticalAlign: 'middle', opacity: 0.5 }} />{' '}
              {(line.discount_share * 100).toFixed(0)}%
            </span>
          </RowFragment>
        ))}
      </div>
    </Card>
  );
}

const headerStyle = {
  fontSize: theme.type.size.xs,
  textTransform: 'uppercase' as const,
  letterSpacing: theme.type.tracking.wide,
  fontWeight: theme.type.weight.semibold,
  color: theme.color.inkMuted,
  paddingBottom: theme.space[2],
  borderBottom: `1px solid ${theme.color.border}`,
};

const cellStyle = {
  fontSize: theme.type.size.sm,
  color: theme.color.ink,
  fontVariantNumeric: 'tabular-nums' as const,
};

// React.Fragment with a key — used so each row in the grid has a
// stable key while still placing five separate children in adjacent
// grid cells. Index parameter unused at the moment but kept for
// future row numbering.
function RowFragment({ children }: { index: number; children: React.ReactNode }) {
  return <>{children}</>;
}
