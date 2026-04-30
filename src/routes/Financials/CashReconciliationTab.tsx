import { Banknote, Clock, FileSignature, Wallet } from 'lucide-react';
import {
  Card,
  EmptyState,
  Skeleton,
  StatCard,
  StatusPill,
} from '../../components/index.ts';
import { theme } from '../../theme/index.ts';
import {
  type CashCountRow,
  type CashPosition,
  useCashCounts,
  useCashPosition,
} from '../../lib/queries/cashCounts.ts';
import { formatPence } from '../../lib/queries/carts.ts';

export function CashReconciliationTab() {
  const counts = useCashCounts();
  const position = useCashPosition();

  if (counts.error || position.error) {
    return (
      <Card padding="lg">
        <p style={{ margin: 0, color: theme.color.alert }}>
          Could not load cash reconciliation data: {counts.error ?? position.error}
        </p>
      </Card>
    );
  }
  if (counts.loading || position.loading || !counts.data || !position.data) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
        <Skeleton height={120} />
        <Skeleton height={300} />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <CurrentPositionCard position={position.data} />
      <PastCountsCard counts={counts.data} />
    </div>
  );
}

function CurrentPositionCard({ position }: { position: CashPosition }) {
  const last = position.last_signed_count;
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
        <Wallet size={16} aria-hidden /> What should be in the safe right now
      </h3>
      <p
        style={{
          margin: `${theme.space[1]}px 0 ${theme.space[4]}px`,
          fontSize: theme.type.size.xs,
          color: theme.color.inkMuted,
        }}
      >
        Sum of cash payments since the last signed count{last ? ` ended ${formatDate(last.period_end)}` : ' (no signed count yet — earliest cash payment is the anchor)'}.
      </p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: theme.space[3],
        }}
      >
        <StatCard
          label="Expected in safe"
          value={formatPence(position.expected_in_safe_pence)}
          delta={`${position.payment_count.toLocaleString('en-GB')} cash payment${position.payment_count === 1 ? '' : 's'}`}
          tone="accent"
          icon={<Banknote size={14} />}
        />
        <StatCard
          label="Earliest in run"
          value={position.earliest_payment_at ? formatShort(position.earliest_payment_at) : '—'}
          delta={position.latest_payment_at ? `Latest ${formatShort(position.latest_payment_at)}` : '—'}
          icon={<Clock size={14} />}
        />
        <StatCard
          label="Last signed count"
          value={last ? formatShort(last.period_end) : 'Never'}
          delta={last && last.actual_pence != null ? `Counted ${formatPence(last.actual_pence)}` : 'Run a count to set the baseline'}
          tone={last ? 'normal' : 'warn'}
          icon={<FileSignature size={14} />}
        />
      </div>
    </Card>
  );
}

function PastCountsCard({ counts }: { counts: CashCountRow[] }) {
  if (counts.length === 0) {
    return (
      <Card padding="lg">
        <EmptyState
          icon={<FileSignature size={20} />}
          title="No counts yet"
          description="The first count will land here once it's signed off. Counting controls land in the next PR."
        />
      </Card>
    );
  }
  return (
    <Card padding="lg">
      <h3
        style={{
          margin: 0,
          fontSize: theme.type.size.md,
          fontWeight: theme.type.weight.semibold,
        }}
      >
        Past counts
      </h3>
      <p
        style={{
          margin: `${theme.space[1]}px 0 ${theme.space[4]}px`,
          fontSize: theme.type.size.xs,
          color: theme.color.inkMuted,
        }}
      >
        Newest first. Each row is one safe count event with counter + signer attribution.
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
        {counts.map((c) => {
          const variancePos = c.variance_pence > 0;
          const varianceNeg = c.variance_pence < 0;
          return (
            <li
              key={c.id}
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
                  marginBottom: theme.space[2],
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <p style={{ margin: 0, fontSize: theme.type.size.sm, fontWeight: theme.type.weight.semibold }}>
                    {formatShort(c.period_start)} → {formatShort(c.period_end)}
                  </p>
                  <p
                    style={{
                      margin: `${theme.space[1]}px 0 0`,
                      fontSize: theme.type.size.xs,
                      color: theme.color.inkMuted,
                    }}
                  >
                    Counted by <strong>{c.counted_by_name}</strong>
                    {c.signed_off_by_name ? ` · Signed by ${c.signed_off_by_name}` : ''}
                  </p>
                </div>
                <CountStatusPill status={c.status} />
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                  gap: theme.space[3],
                  marginTop: theme.space[3],
                }}
              >
                <Mini label="Expected" value={formatPence(c.expected_pence)} />
                <Mini label="Actual" value={c.actual_pence === null ? '—' : formatPence(c.actual_pence)} />
                <Mini
                  label="Variance"
                  value={
                    c.actual_pence === null
                      ? '—'
                      : `${variancePos ? '+' : varianceNeg ? '−' : ''}${formatPence(Math.abs(c.variance_pence))}`
                  }
                  tone={varianceNeg ? 'alert' : variancePos ? 'warn' : 'normal'}
                />
              </div>
              {c.notes ? (
                <p
                  style={{
                    margin: `${theme.space[3]}px 0 0`,
                    fontSize: theme.type.size.sm,
                    color: theme.color.ink,
                  }}
                >
                  "{c.notes}"
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function Mini({ label, value, tone = 'normal' }: { label: string; value: string; tone?: 'normal' | 'warn' | 'alert' }) {
  const colour =
    tone === 'alert'
      ? theme.color.alert
      : tone === 'warn'
        ? theme.color.warn
        : theme.color.ink;
  return (
    <div>
      <p
        style={{
          margin: 0,
          fontSize: theme.type.size.xs,
          color: theme.color.inkMuted,
          textTransform: 'uppercase',
          letterSpacing: theme.type.tracking.wide,
          fontWeight: theme.type.weight.medium,
        }}
      >
        {label}
      </p>
      <p
        style={{
          margin: `${theme.space[1]}px 0 0`,
          fontSize: theme.type.size.sm,
          fontWeight: theme.type.weight.semibold,
          color: colour,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </p>
    </div>
  );
}

function CountStatusPill({ status }: { status: 'pending' | 'signed' | 'disputed' }) {
  switch (status) {
    case 'pending':
      return <StatusPill tone="pending" size="sm">Pending</StatusPill>;
    case 'signed':
      return <StatusPill tone="arrived" size="sm">Signed</StatusPill>;
    case 'disputed':
      return <StatusPill tone="no_show" size="sm">Disputed</StatusPill>;
  }
}

function formatShort(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
