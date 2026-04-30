import { useMemo, useState } from 'react';
import { Download, ReceiptText } from 'lucide-react';
import {
  Button,
  Card,
  DropdownSelect,
  EmptyState,
  Skeleton,
  StatCard,
  StatusPill,
} from '../../components/index.ts';
import { theme } from '../../theme/index.ts';
import { type DateRange, dateRangeLabel } from '../../lib/dateRange.ts';
import {
  type SalesFilters,
  type SalesRow,
  useFinancialsSales,
} from '../../lib/queries/financials.ts';
import { formatPence } from '../../lib/queries/carts.ts';
import { csvFilename, downloadCsv, toCsv, type CsvColumn } from '../../lib/csv.ts';

interface Props {
  range: DateRange;
}

export function SalesTab({ range }: Props) {
  const [paymentMethod, setPaymentMethod] = useState<string>('any');
  const [cartStatus, setCartStatus] = useState<string>('any');
  const [arrivalType, setArrivalType] = useState<string>('any');

  const filters = useMemo<SalesFilters>(
    () => ({
      paymentMethod: paymentMethod === 'any' ? null : paymentMethod,
      cartStatus: cartStatus === 'any' ? null : cartStatus,
      arrivalType: arrivalType === 'any' ? null : (arrivalType as 'walk_in' | 'scheduled'),
    }),
    [paymentMethod, cartStatus, arrivalType],
  );

  const { data, loading, error } = useFinancialsSales(range, filters);

  if (error) {
    return (
      <Card padding="lg">
        <p style={{ margin: 0, color: theme.color.alert }}>
          Could not load sales for {dateRangeLabel(range)}: {error}
        </p>
      </Card>
    );
  }

  const exportCsv = () => {
    if (!data) return;
    const columns: CsvColumn<SalesRow>[] = [
      { key: 'visit_date', label: 'Date', format: (v) => new Date(String(v)).toISOString() },
      { key: 'patient_name', label: 'Patient' },
      { key: 'appointment_ref', label: 'Reference' },
      { key: 'arrival_type', label: 'Arrival' },
      { key: 'items_summary', label: 'Items' },
      { key: 'subtotal_pence', label: 'Subtotal (£)', format: (v) => (Number(v) / 100).toFixed(2) },
      { key: 'discount_pence', label: 'Discount (£)', format: (v) => (Number(v) / 100).toFixed(2) },
      { key: 'total_pence', label: 'Total (£)', format: (v) => (Number(v) / 100).toFixed(2) },
      { key: 'amount_paid_pence', label: 'Collected (£)', format: (v) => (Number(v) / 100).toFixed(2) },
      { key: 'cart_status', label: 'Cart status' },
      { key: 'payment_methods', label: 'Methods' },
    ];
    const csv = toCsv(data.rows, columns);
    downloadCsv(csvFilename('financials_sales', range), csv);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <Card padding="lg">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: theme.space[3],
            alignItems: 'flex-end',
          }}
        >
          <DropdownSelect<string>
            label="Payment method"
            value={paymentMethod}
            options={[
              { value: 'any', label: 'Any method' },
              { value: 'cash', label: 'Cash' },
              { value: 'card_terminal', label: 'Card' },
              { value: 'gift_card', label: 'Gift card' },
              { value: 'account_credit', label: 'Account credit' },
            ]}
            onChange={setPaymentMethod}
          />
          <DropdownSelect<string>
            label="Cart status"
            value={cartStatus}
            options={[
              { value: 'any', label: 'Any status' },
              { value: 'paid', label: 'Paid' },
              { value: 'open', label: 'Owed (open)' },
              { value: 'voided', label: 'Voided' },
            ]}
            onChange={setCartStatus}
          />
          <DropdownSelect<string>
            label="Arrival"
            value={arrivalType}
            options={[
              { value: 'any', label: 'Any arrival' },
              { value: 'walk_in', label: 'Walk-in' },
              { value: 'scheduled', label: 'Scheduled' },
            ]}
            onChange={setArrivalType}
          />
        </div>
      </Card>

      {loading || !data ? (
        <Skeleton height={240} />
      ) : data.rows.length === 0 ? (
        <Card padding="lg">
          <EmptyState
            icon={<ReceiptText size={20} />}
            title="No sales for these filters"
            description="Try a different combination of payment method, cart status, or arrival type."
          />
        </Card>
      ) : (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: theme.space[3],
            }}
          >
            <StatCard label="Rows" value={data.rows.length.toLocaleString('en-GB')} delta="matching the filters" />
            <StatCard label="Subtotal" value={formatPence(data.total_subtotal_pence)} />
            <StatCard label="Discount" value={`−${formatPence(data.total_discount_pence)}`} tone={data.total_discount_pence > 0 ? 'warn' : 'normal'} />
            <StatCard label="Collected" value={formatPence(data.total_collected_pence)} tone="accent" />
          </div>
          <Card padding="lg">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: theme.space[3], flexWrap: 'wrap' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: theme.type.size.md, fontWeight: theme.type.weight.semibold }}>
                  Sales log
                </h3>
                <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
                  One row per visit's cart, sorted newest first.
                </p>
              </div>
              <Button variant="tertiary" size="sm" onClick={exportCsv}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
                  <Download size={14} aria-hidden /> Download CSV
                </span>
              </Button>
            </div>
            <div style={{ marginTop: theme.space[4], overflowX: 'auto' }}>
              <table
                style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontSize: theme.type.size.sm,
                }}
              >
                <thead>
                  <tr>
                    <th style={th}>Date</th>
                    <th style={th}>Patient</th>
                    <th style={th}>Items</th>
                    <th style={{ ...th, textAlign: 'right' }}>Subtotal</th>
                    <th style={{ ...th, textAlign: 'right' }}>Discount</th>
                    <th style={{ ...th, textAlign: 'right' }}>Total</th>
                    <th style={th}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.visit_id} style={{ borderTop: `1px solid ${theme.color.border}` }}>
                      <td style={td}>{formatDate(r.visit_date)}</td>
                      <td style={td}>
                        <div style={{ fontWeight: theme.type.weight.semibold }}>{r.patient_name}</div>
                        {r.appointment_ref ? (
                          <div style={{ fontSize: theme.type.size.xs, color: theme.color.inkMuted, fontVariantNumeric: 'tabular-nums' }}>
                            {r.appointment_ref}
                          </div>
                        ) : null}
                      </td>
                      <td style={td}>
                        <div>{r.items_summary}</div>
                        {r.payment_methods ? (
                          <div style={{ fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
                            {r.payment_methods}
                          </div>
                        ) : null}
                      </td>
                      <td style={tdRight}>{formatPence(r.subtotal_pence)}</td>
                      <td style={{ ...tdRight, color: r.discount_pence > 0 ? theme.color.warn : theme.color.inkMuted }}>
                        {r.discount_pence > 0 ? `−${formatPence(r.discount_pence)}` : '—'}
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
        </>
      )}
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
  padding: `${theme.space[2]}px ${theme.space[3]}px`,
};

const td = {
  padding: `${theme.space[3]}px`,
  fontSize: theme.type.size.sm,
  color: theme.color.ink,
  verticalAlign: 'top' as const,
};

const tdRight = {
  ...td,
  textAlign: 'right' as const,
  fontVariantNumeric: 'tabular-nums' as const,
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
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
