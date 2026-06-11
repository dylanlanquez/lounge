import { Package } from 'lucide-react';
import { Card } from '../Card/Card.tsx';
import { theme } from '../../theme/index.ts';
import { formatPence } from '../../lib/queries/carts.ts';
import type { AppointmentItemRow } from '../../lib/queries/appointmentItems.ts';

// AppointmentItemsCard — the planned product bag a Checkpoint booking
// attached to an appointment. One row per lng_appointment_items entry,
// showing what flows into the cart when the customer is marked arrived.
// Mirrors AppointmentExtras' visual shape (padded Card, tinted header,
// key/value rows). Renders nothing when the bag is empty.

const ARCH_LABEL: Record<string, string> = {
  upper: 'Upper',
  lower: 'Lower',
  both: 'Upper and Lower',
};

export interface AppointmentItemsCardProps {
  items: ReadonlyArray<AppointmentItemRow>;
}

export function AppointmentItemsCard({ items }: AppointmentItemsCardProps) {
  if (items.length === 0) return null;

  const anyPriced = items.some((it) => it.priceShown);
  const total = items.reduce((sum, it) => {
    if (!it.priceShown) return sum;
    const upgradePence = it.upgrades.reduce((s, u) => s + u.resolvedPricePence, 0) * it.quantity;
    return sum + it.lineTotalPence + upgradePence;
  }, 0);

  return (
    <Card padding="lg">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[3],
          marginBottom: theme.space[4],
        }}
      >
        <span
          aria-hidden
          style={{
            width: 30,
            height: 30,
            borderRadius: theme.radius.pill,
            background: theme.color.accentBg,
            color: theme.color.accent,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <Package size={15} aria-hidden />
        </span>
        <h3
          style={{
            margin: 0,
            fontSize: theme.type.size.md,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          Booked items
        </h3>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
        {items.map((it) => (
          <ItemBlock key={it.id} item={it} />
        ))}
      </div>

      {anyPriced ? (
        <div
          style={{
            marginTop: theme.space[4],
            paddingTop: theme.space[3],
            borderTop: `1px solid ${theme.color.border}`,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
          }}
        >
          <span style={{ fontSize: theme.type.size.sm, fontWeight: theme.type.weight.semibold, color: theme.color.ink }}>
            Items total
          </span>
          <span
            style={{
              fontSize: theme.type.size.base,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {formatPence(total)}
          </span>
        </div>
      ) : null}
    </Card>
  );
}

function ItemBlock({ item }: { item: AppointmentItemRow }) {
  const meta: string[] = [];
  if (item.arch) meta.push(ARCH_LABEL[item.arch] ?? item.arch);
  if (item.shade) meta.push(`Shade ${item.shade}`);
  if (item.thickness) meta.push(`Thickness ${item.thickness}`);
  const linePence = item.priceShown
    ? item.lineTotalPence + item.upgrades.reduce((s, u) => s + u.resolvedPricePence, 0) * item.quantity
    : null;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: theme.space[3] }}>
        <span style={{ fontSize: theme.type.size.sm, color: theme.color.ink, fontWeight: theme.type.weight.medium }}>
          {item.quantity > 1 ? `${item.quantity} × ` : ''}
          {item.name}
        </span>
        {linePence !== null ? (
          <span
            style={{
              fontSize: theme.type.size.sm,
              color: theme.color.ink,
              fontWeight: theme.type.weight.semibold,
              fontVariantNumeric: 'tabular-nums',
              flexShrink: 0,
            }}
          >
            {formatPence(linePence)}
          </span>
        ) : null}
      </div>
      {meta.length > 0 ? (
        <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
          {meta.join(' · ')}
        </p>
      ) : null}
      {item.upgrades.length > 0 ? (
        <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
          {item.upgrades.map((u) => u.name).join(', ')}
        </p>
      ) : null}
    </div>
  );
}
