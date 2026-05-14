import { Link } from 'react-router-dom';
import { AlertTriangle, ExternalLink, Package, Repeat, ShoppingBag, Users } from 'lucide-react';
import {
  BarChart,
  Card,
  EmptyState,
  Skeleton,
  StatCard,
} from '../../components/index.ts';
import { ShopifyIcon } from '../../components/Icons/ShopifyIcon.tsx';
import { theme } from '../../theme/index.ts';
import { type DateRange, dateRangeLabel } from '../../lib/dateRange.ts';
import { type OnlineOrdersData, useReportsOnlineOrders } from '../../lib/queries/reports.ts';
import { formatNumber, formatPence } from '../../lib/queries/carts.ts';

// Reports → Online orders.
//
// Spots trends in venneir.com Shopify orders coming into the diary.
// Leadership cares about two questions here:
//
//   1. Which products are driving these bookings? (product breakdown)
//   2. Are patients abusing the channel — repeat redemptions in a
//      short window? (repeat-patients slice)
//
// And every row links to the appointment so a discrepancy ("staff
// claim £X paid online" vs the Shopify total here) can be checked
// in one click.

interface Props {
  range: DateRange;
}

const SHOPIFY_FOREST = '#5E8E3E';

export function OnlineOrdersTab({ range }: Props) {
  const { data, loading, error } = useReportsOnlineOrders(range);

  if (error) {
    return (
      <Card padding="lg">
        <p style={{ margin: 0, color: theme.color.alert }}>
          Could not load online orders for {dateRangeLabel(range)}: {error}
        </p>
      </Card>
    );
  }

  if (loading || !data) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
        <Skeleton height={120} />
        <Skeleton height={260} />
        <Skeleton height={360} />
      </div>
    );
  }

  if (data.total_orders === 0) {
    return (
      <Card padding="lg">
        <EmptyState
          icon={<ShoppingBag size={20} />}
          title="No online orders in this period"
          description="No appointments arrived with a venneir.com Shopify order attached. Try a wider date range."
        />
      </Card>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <Kpis data={data} />
      <ProductBreakdown data={data} />
      {data.repeats.length > 0 ? <RepeatsCard data={data} /> : null}
      <OrdersTable data={data} />
    </div>
  );
}

function Kpis({ data }: { data: OnlineOrdersData }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: theme.space[3],
      }}
    >
      <StatCard
        label="Online orders"
        value={formatNumber(data.total_orders)}
        delta="appointments in range"
        icon={<ShoppingBag size={16} />}
      />
      <StatCard
        label="Credit paid online"
        value={formatPence(data.total_credit_pence)}
        delta="auto-credited at the till"
        tone="accent"
      />
      <StatCard
        label="Unique patients"
        value={formatNumber(data.unique_patients)}
        delta={`${data.total_orders === data.unique_patients ? '1 order each' : 'across all online orders'}`}
        icon={<Users size={16} />}
      />
      <StatCard
        label="Repeat patients"
        value={formatNumber(data.repeat_patients)}
        delta="more than one order in range"
        tone={data.repeat_patients > 0 ? 'warn' : 'normal'}
        icon={<Repeat size={16} />}
      />
    </div>
  );
}

function ProductBreakdown({
  data,
}: {
  data: OnlineOrdersData;
}) {
  const top = data.by_product.slice(0, 8);
  return (
    <Card padding="lg">
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], marginBottom: theme.space[2] }}>
        <Package size={16} aria-hidden style={{ color: theme.color.inkMuted }} />
        <h3 style={{ margin: 0, fontSize: theme.type.size.md, fontWeight: theme.type.weight.semibold }}>
          Products driving online orders
        </h3>
      </div>
      <p style={{ margin: `0 0 ${theme.space[4]}px`, fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
        Count of online-order appointments by product. Top entries show where the diary is filling up.
      </p>
      <BarChart
        ariaSummary="Count of online-order appointments grouped by product, ranked from highest."
        bars={top.map((b) => ({
          id: b.key,
          label: b.label,
          value: b.count,
          colour: SHOPIFY_FOREST,
        }))}
      />
      {data.by_product.length > top.length ? (
        <p style={{ margin: `${theme.space[3]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
          {formatNumber(data.by_product.length - top.length)} more product
          {data.by_product.length - top.length === 1 ? '' : 's'} not shown.
        </p>
      ) : null}
    </Card>
  );
}

function RepeatsCard({
  data,
}: {
  data: OnlineOrdersData;
}) {
  return (
    <Card padding="lg">
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], marginBottom: theme.space[2] }}>
        <AlertTriangle size={16} aria-hidden style={{ color: theme.color.warn }} />
        <h3 style={{ margin: 0, fontSize: theme.type.size.md, fontWeight: theme.type.weight.semibold }}>
          Repeat patients
        </h3>
      </div>
      <p style={{ margin: `0 0 ${theme.space[3]}px`, fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
        Patients with more than one online-order appointment in this period. Worth a closer look — multiple
        redemptions in a short window is the most likely abuse pattern.
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: theme.type.size.sm }}>
          <thead>
            <tr>
              <th style={th}>Patient</th>
              <th style={{ ...th, textAlign: 'right' }}>Orders</th>
              <th style={{ ...th, textAlign: 'right' }}>Total credit</th>
            </tr>
          </thead>
          <tbody>
            {data.repeats.map((r) => (
              <tr key={r.patient_id} style={{ borderTop: `1px solid ${theme.color.border}` }}>
                <td style={td}>
                  <Link
                    to={`/patient/${r.patient_id}`}
                    style={{ color: theme.color.ink, textDecoration: 'none', fontWeight: theme.type.weight.semibold }}
                  >
                    {r.patient_name}
                  </Link>
                  {r.patient_internal_ref ? (
                    <div
                      style={{
                        fontSize: theme.type.size.xs,
                        color: theme.color.inkMuted,
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {r.patient_internal_ref}
                    </div>
                  ) : null}
                </td>
                <td style={{ ...tdRight, color: theme.color.warn, fontWeight: theme.type.weight.semibold }}>
                  {formatNumber(r.order_count)}
                </td>
                <td style={tdRight}>{formatPence(r.total_credit_pence)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function OrdersTable({
  data,
}: {
  data: OnlineOrdersData;
}) {
  return (
    <Card padding="lg">
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], marginBottom: theme.space[2] }}>
        <ShopifyIcon size={16} title="Shopify" />
        <h3 style={{ margin: 0, fontSize: theme.type.size.md, fontWeight: theme.type.weight.semibold }}>
          All online orders
        </h3>
      </div>
      <p style={{ margin: `0 0 ${theme.space[4]}px`, fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
        One row per online-order appointment, newest first. The Shopify column links straight to the order
        in admin so a credit can be verified independently of what staff or the patient say was paid.
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: theme.type.size.sm }}>
          <thead>
            <tr>
              <th style={th}>Date</th>
              <th style={th}>Patient</th>
              <th style={th}>Product</th>
              <th style={th}>Shopify order</th>
              <th style={{ ...th, textAlign: 'right' }}>Credit</th>
              <th style={th}>Status</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.appointment_id} style={{ borderTop: `1px solid ${theme.color.border}` }}>
                <td style={td}>
                  <Link
                    to={`/appointment/${r.appointment_id}`}
                    style={{ color: theme.color.ink, textDecoration: 'none', fontWeight: theme.type.weight.medium }}
                  >
                    {formatStartDate(r.start_at)}
                  </Link>
                  {r.appointment_ref ? (
                    <div
                      style={{
                        fontSize: theme.type.size.xs,
                        color: theme.color.inkMuted,
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {r.appointment_ref}
                    </div>
                  ) : null}
                </td>
                <td style={td}>
                  <Link
                    to={`/patient/${r.patient_id}`}
                    style={{ color: theme.color.ink, textDecoration: 'none', fontWeight: theme.type.weight.semibold }}
                  >
                    {r.patient_name}
                  </Link>
                  {r.patient_internal_ref ? (
                    <div
                      style={{
                        fontSize: theme.type.size.xs,
                        color: theme.color.inkMuted,
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {r.patient_internal_ref}
                    </div>
                  ) : null}
                </td>
                <td style={td}>{r.product_label}</td>
                <td style={td}>
                  <a
                    href={`https://admin.shopify.com/store/venneir/orders/${r.shopify_order_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      color: SHOPIFY_FOREST,
                      fontWeight: theme.type.weight.semibold,
                      textDecoration: 'none',
                    }}
                  >
                    {r.shopify_order_name}
                    <ExternalLink size={12} aria-hidden />
                  </a>
                </td>
                <td style={tdRight}>{formatPence(r.credit_pence)}</td>
                <td style={td}>{humaniseStatus(r.status)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function formatStartDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function humaniseStatus(s: string): string {
  return s.replaceAll('_', ' ').replace(/\b\w/g, (m) => m.toUpperCase());
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
