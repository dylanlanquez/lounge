import { type ReactNode } from 'react';
import { Plus, Package } from 'lucide-react';
import { Card } from '../Card/Card.tsx';
import { DentureIcon } from '../Icons/DentureIcon.tsx';
import { theme } from '../../theme/index.ts';
import type {
  AppointmentRepairItemRow,
  AppointmentUpgradeRow,
} from '../../lib/queries/appointmentDetail.ts';
import { formatPence } from '../../lib/queries/carts.ts';

// AppointmentExtras — surfaces the patient's widget-side picks (paid
// upgrades + denture-repair line items) on every staff-facing
// appointment surface. Mounted on AppointmentDetail (pre-arrival) and
// VisitDetail (post-arrival) so the receptionist sees the same data
// the patient picked at booking — without having to dig into the cart
// or chase the original booking confirmation.
//
// Renders nothing when both arrays are empty. Visual shape mirrors
// the IntakeCard / DepositCard pattern on AppointmentDetail.tsx —
// padded Card, small icon-tinted header, key/value rows beneath.
//
// Empty state is intentionally invisible (no "no upgrades selected"
// placeholder) because most bookings won't have either category.

export interface AppointmentExtrasProps {
  upgrades: ReadonlyArray<AppointmentUpgradeRow>;
  repairItems: ReadonlyArray<AppointmentRepairItemRow>;
  /** Primary-product enrichment captured by the Checkpoint booker.
   *  Surfaced as a "Selected at booking" section so the floor team
   *  sees the quantity + shade the staff member agreed with the
   *  customer. Null/absent on customer-widget + legacy rows. */
  quantity?: number | null;
  shade?: string | null;
}

export function AppointmentExtras({
  upgrades,
  repairItems,
  quantity = null,
  shade = null,
}: AppointmentExtrasProps) {
  // Only treat a quantity > 1 as worth surfacing — a single unit is the
  // implicit default and would just be noise on every booking.
  const hasQuantity = typeof quantity === 'number' && quantity > 1;
  const hasShade = typeof shade === 'string' && shade.trim().length > 0;
  const hasPrimaryDetails = hasQuantity || hasShade;
  if (upgrades.length === 0 && repairItems.length === 0 && !hasPrimaryDetails) return null;

  // Group repair items by arch so the patient's "Upper / Lower / Both"
  // story reads in one place. Order matches the widget's arch tile
  // ordering: upper → lower → both.
  const repairsByArch = new Map<'upper' | 'lower' | 'both', AppointmentRepairItemRow[]>();
  for (const r of repairItems) {
    const list = repairsByArch.get(r.arch) ?? [];
    list.push(r);
    repairsByArch.set(r.arch, list);
  }
  const archOrder: Array<'upper' | 'lower' | 'both'> = ['upper', 'lower', 'both'];

  return (
    <Card padding="lg">
      {hasPrimaryDetails ? (
        <ExtrasSection
          icon={<Package size={15} aria-hidden />}
          title="Selected at booking"
        >
          {hasQuantity ? (
            <ExtrasRow label="Quantity" value={`× ${quantity}`} isFirst />
          ) : null}
          {hasShade ? (
            <ExtrasRow label="Shade" value={(shade as string).trim()} isFirst={!hasQuantity} />
          ) : null}
        </ExtrasSection>
      ) : null}
      {upgrades.length > 0 ? (
        <div style={{ marginTop: hasPrimaryDetails ? theme.space[5] : 0 }}>
        <ExtrasSection
          icon={<Plus size={15} aria-hidden />}
          title="Upgrades selected at booking"
        >
          {upgrades.map((u, i) => (
            <ExtrasRow
              key={u.id}
              label={u.name}
              value={formatPence(u.resolvedPricePence)}
              isFirst={i === 0}
            />
          ))}
        </ExtrasSection>
        </div>
      ) : null}
      {repairItems.length > 0 ? (
        <div
          style={{
            marginTop: upgrades.length > 0 || hasPrimaryDetails ? theme.space[5] : 0,
          }}
        >
          <ExtrasSection
            icon={<DentureIcon size={15} />}
            title="Denture repairs selected at booking"
          >
            {archOrder.map((arch) => {
              const rows = repairsByArch.get(arch);
              if (!rows || rows.length === 0) return null;
              return (
                <div key={arch} style={{ marginTop: theme.space[3] }}>
                  <ArchHeader arch={arch} />
                  {rows.map((r, i) => (
                    <ExtrasRow
                      key={r.id}
                      label={`${r.name}${r.unitLabel === 'per tooth' && r.quantity > 1 ? ` × ${r.quantity} teeth` : ''}`}
                      value={formatPence(r.lineTotalPence)}
                      isFirst={i === 0}
                    />
                  ))}
                </div>
              );
            })}
          </ExtrasSection>
        </div>
      ) : null}
    </Card>
  );
}

function ExtrasSection({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[3],
          marginBottom: theme.space[3],
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
          {icon}
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
          {title}
        </h3>
      </div>
      {children}
    </div>
  );
}

function ArchHeader({ arch }: { arch: 'upper' | 'lower' | 'both' }) {
  const label = arch === 'upper' ? 'Upper' : arch === 'lower' ? 'Lower' : 'Both arches';
  return (
    <p
      style={{
        margin: 0,
        marginTop: theme.space[2],
        marginBottom: theme.space[1],
        fontSize: theme.type.size.sm,
        fontWeight: theme.type.weight.semibold,
        letterSpacing: theme.type.tracking.tight,
        color: theme.color.ink,
      }}
    >
      {label}
    </p>
  );
}

function ExtrasRow({
  label,
  value,
  isFirst,
}: {
  label: ReactNode;
  value: ReactNode;
  isFirst: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: theme.space[3],
        paddingTop: isFirst ? 0 : theme.space[2],
        paddingBottom: theme.space[2],
        borderTop: isFirst ? 'none' : `1px solid ${theme.color.border}`,
      }}
    >
      <span
        style={{
          fontSize: theme.type.size.sm,
          color: theme.color.ink,
          fontWeight: theme.type.weight.medium,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: theme.type.size.sm,
          color: theme.color.ink,
          fontWeight: theme.type.weight.semibold,
          fontVariantNumeric: 'tabular-nums',
          flexShrink: 0,
        }}
      >
        {value}
      </span>
    </div>
  );
}
