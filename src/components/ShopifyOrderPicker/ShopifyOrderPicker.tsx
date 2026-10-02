import { useMemo } from 'react';
import { Checkbox, Section } from '../index.ts';
import { theme } from '../../theme/index.ts';
import { formatPence } from '../../lib/queries/carts.ts';
import {
  usePatientShopifyOrders,
  type PatientShopifyOrderRow,
} from '../../lib/queries/patientProfile.ts';
import {
  orderTotalToPence,
  type ShopifyOrderToLink,
} from '../../lib/queries/appointmentShopifyOrderLinks.ts';

// Multi-select list of a patient's Shopify orders. Used by the voice-call
// booking flow ("which orders is this call about?") and by the same card on
// the appointment page so the picks can be changed after booking.
//
// These picks are reference links only, never a credit against a bill — the
// copy says so, because the identically-shaped "Online order" section on
// same-day bookings DOES credit, and the two must not be confused.
//
// Renders nothing at all when the patient has no orders: a voice call about
// a patient who never bought anything should show no trace of this.

export interface ShopifyOrderPickerProps {
  patientId: string | null | undefined;
  // Shopify order ids currently ticked.
  selectedIds: string[];
  // Hands back both the ids and the snapshot rows for those ids, so the
  // caller can persist name/total/currency without re-fetching the list.
  onChange: (ids: string[], orders: ShopifyOrderToLink[]) => void;
  disabled?: boolean;
  // Orders already linked elsewhere that should render ticked and locked —
  // used on the appointment page so a pick that is mid-save can't be
  // double-toggled. Empty by default.
  lockedIds?: string[];
  // When set, the list is wrapped in a Section with this heading. The
  // heading lives inside the picker (rather than at the call site) so a
  // patient with no orders renders nothing at all — heading included.
  title?: string;
  info?: string;
}

export function orderStatusLabel(o: PatientShopifyOrderRow): string {
  if (o.cancelled_at) return 'Cancelled';
  const financial = (o.financial_status ?? '').toLowerCase();
  if (financial === 'refunded') return 'Refunded';
  if (financial === 'partially_refunded') return 'Partly refunded';
  if (financial === 'paid') {
    return (o.fulfillment_status ?? '').toLowerCase() === 'fulfilled' ? 'Paid, fulfilled' : 'Paid';
  }
  if (financial) return financial.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  return 'Unknown status';
}

function orderDateLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function ShopifyOrderPicker({
  patientId,
  selectedIds,
  onChange,
  disabled = false,
  lockedIds = [],
  title,
  info,
}: ShopifyOrderPickerProps) {
  const { data: orders, loading, error } = usePatientShopifyOrders(patientId);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const locked = useMemo(() => new Set(lockedIds), [lockedIds]);

  if (!patientId) return null;
  if (loading) {
    return (
      <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkSubtle }}>
        Loading orders…
      </p>
    );
  }
  if (error) {
    return (
      <p role="alert" style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.alert }}>
        Couldn't load this patient's orders: {error}
      </p>
    );
  }
  if (orders.length === 0) return null;

  const toggle = (id: string, next: boolean) => {
    const ids = next
      ? selected.has(id)
        ? selectedIds
        : [...selectedIds, id]
      : selectedIds.filter((x) => x !== id);
    const picked = new Set(ids);
    onChange(
      ids,
      orders
        .filter((o) => picked.has(o.id))
        .map((o) => ({
          id: o.id,
          name: o.name ?? `Order ${o.id}`,
          totalPricePence: orderTotalToPence(o.total_price),
          currency: o.currency,
        })),
    );
  };

  const list = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
      {orders.map((o) => {
        const pence = orderTotalToPence(o.total_price);
        const isLocked = locked.has(o.id);
        return (
          <label
            key={o.id}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: theme.space[3],
              padding: theme.space[3],
              border: `1px solid ${selected.has(o.id) ? theme.color.ink : theme.color.border}`,
              borderRadius: theme.radius.card,
              background: theme.color.surface,
              cursor: disabled || isLocked ? 'default' : 'pointer',
            }}
          >
            <Checkbox
              checked={selected.has(o.id)}
              onChange={(v) => toggle(o.id, v)}
              disabled={disabled || isLocked}
              ariaLabel={`Attach order ${o.name ?? o.id}`}
              size={20}
            />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <span
                style={{
                  fontSize: theme.type.size.sm,
                  fontWeight: theme.type.weight.semibold,
                  color: theme.color.ink,
                }}
              >
                {o.name ?? `Order ${o.id}`}
                {pence !== null ? ` · ${formatPence(pence)}` : ''}
              </span>
              <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>
                {orderDateLabel(o.created_at)} · {orderStatusLabel(o)}
              </span>
              {o.items.length > 0 ? (
                <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>
                  {o.items
                    .map((i) => `${i.quantity ?? 1} × ${i.title ?? 'Item'}`)
                    .join(', ')}
                </span>
              ) : null}
            </span>
          </label>
        );
      })}
    </div>
  );

  if (!title) return list;
  return (
    <Section title={title} info={info}>
      {list}
    </Section>
  );
}
