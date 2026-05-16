import { useEffect, useMemo, useState } from 'react';
import { Banknote, ChevronDown, ChevronRight, ReceiptText, ScrollText } from 'lucide-react';
import {
  Card,
  DropdownSelect,
  EmptyState,
  Skeleton,
  StatCard,
  StatusPill,
} from '../../components/index.ts';
import { theme } from '../../theme/index.ts';
import { type DateRange, dateRangeLabel } from '../../lib/dateRange.ts';
import { formatNumber, formatPence } from '../../lib/queries/carts.ts';
import { useCurrentAccount } from '../../lib/queries/currentAccount.ts';
import { useLocations } from '../../lib/queries/locations.ts';
import { useCashCountStatement } from '../../lib/queries/cashCounts.ts';
import {
  type CashDrawerLine,
  type PastSettlementRow,
  useCashDrawerSinceLastCount,
  useCashPaymentsInRange,
  usePastSettlements,
} from '../../lib/queries/cashDrawer.ts';

// CashDrawerTab — read-only mirror of the cash-drawer reconciliation
// data inside Admin → Reports. The interactive flow (start a count,
// sign one off) still lives at /cash-counts; this tab exists so
// finance / management can read "what should be in the safe" and
// "every cash line item that contributes" without leaving Reports.
//
// Two sections, in order:
//   1. Since last cash count — anchored on the chosen location's
//      most recent SIGNED count. Sums succeeded cash payments at
//      that location since the count's period_end. Cross-location
//      view isn't shown here: each location has its own count chain,
//      so "expected cash" only makes sense scoped to one.
//   2. All cash sale records — every cash payment whose succeeded_at
//      OR cancelled_at falls in the report's DateRange, scoped by
//      the same location filter. Voided rows are included so the
//      reconciliation story stays honest (took £X, voided £Y, net).
//
// The single location filter at the top drives both sections; an
// "All locations" choice disables the since-last-count section
// (with an explanation) and aggregates the in-range table across
// every location the viewer can see.

interface Props {
  range: DateRange;
}

const ALL_LOCATIONS_KEY = '__all__';

export function CashDrawerTab({ range }: Props) {
  const { account } = useCurrentAccount();
  const { data: locations, loading: locationsLoading } = useLocations();

  // Location selection. Three meaningful states:
  //   undefined → initial, before account + locations resolve. We
  //               render the loading shell instead of a default.
  //   null      → "All locations" (only valid for the in-range section;
  //               the since-last-count section explains why it's
  //               disabled).
  //   string    → a specific location id.
  // Default lands on the viewer's own account.location_id when both
  // are loaded, falling back to the first visible location for
  // accounts (admins) whose location_id is null.
  const [locationId, setLocationId] = useState<string | null | undefined>(
    undefined,
  );

  useEffect(() => {
    if (locationId !== undefined) return;
    if (!locations) return;
    const own = account?.location_id ?? null;
    if (own && locations.some((l) => l.id === own)) {
      setLocationId(own);
      return;
    }
    setLocationId(locations[0]?.id ?? null);
  }, [account, locations, locationId]);

  // For the two data hooks we treat undefined the same as null —
  // before the default lands, the cards just show their empty/loading
  // states. This avoids a wasted fetch with a stale id.
  const queryLocationId = locationId ?? null;

  const sinceLastCount = useCashDrawerSinceLastCount(queryLocationId);
  const inRange = useCashPaymentsInRange(range, queryLocationId);
  const pastSettlements = usePastSettlements(queryLocationId);

  const locationOptions = useMemo(() => {
    const opts = (locations ?? []).map((l) => ({
      value: l.id,
      label: l.name,
    }));
    return [{ value: ALL_LOCATIONS_KEY, label: 'All locations' }, ...opts];
  }, [locations]);

  const handleLocationChange = (value: string) => {
    setLocationId(value === ALL_LOCATIONS_KEY ? null : value);
  };

  const dropdownValue =
    locationId === undefined || locationId === null
      ? ALL_LOCATIONS_KEY
      : locationId;
  const selectedLocationName =
    queryLocationId
      ? (locations?.find((l) => l.id === queryLocationId)?.name ?? null)
      : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      {/* Location filter — always visible. With one location the
          dropdown is short but useful (clear feedback for which
          location's safe is being read). */}
      <Card padding="lg">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: theme.space[3],
            alignItems: 'flex-end',
          }}
        >
          <DropdownSelect<string>
            label="Location"
            value={dropdownValue}
            options={locationOptions}
            onChange={handleLocationChange}
          />
          <div
            style={{
              fontSize: theme.type.size.xs,
              color: theme.color.inkMuted,
              lineHeight: 1.4,
              maxWidth: 360,
            }}
          >
            {locationsLoading
              ? 'Loading locations.'
              : queryLocationId === null
                ? 'Date-range section sums every location you can see. The since-last-count card needs a single location to anchor on.'
                : 'Both sections are scoped to this location only.'}
          </div>
        </div>
      </Card>

      <SinceLastCountSection
        locationId={queryLocationId}
        locationName={selectedLocationName}
        data={sinceLastCount.data}
        loading={sinceLastCount.loading}
        error={sinceLastCount.error}
      />

      <PastSettlementsSection
        locationName={selectedLocationName}
        data={pastSettlements.data}
        loading={pastSettlements.loading}
        error={pastSettlements.error}
      />

      <InRangeSection
        range={range}
        scopedToLocation={selectedLocationName}
        data={inRange.data}
        loading={inRange.loading}
        error={inRange.error}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 1 — Since last cash count
// ─────────────────────────────────────────────────────────────────────────────

interface SinceLastCountSectionProps {
  locationId: string | null;
  locationName: string | null;
  data: ReturnType<typeof useCashDrawerSinceLastCount>['data'];
  loading: boolean;
  error: string | null;
}

function SinceLastCountSection({
  locationId,
  locationName,
  data,
  loading,
  error,
}: SinceLastCountSectionProps) {
  return (
    <Card padding="lg">
      <SectionHeader
        title="Since last cash count"
        subtitle={
          locationId
            ? `${locationName ?? 'This location'}'s expected cash in the safe, plus every contributing payment.`
            : 'Pick a single location above to see expected cash. Counts chain per location, so this card cannot aggregate.'
        }
      />

      {!locationId ? (
        <EmptyState
          icon={<Banknote size={20} />}
          title="Select a location"
          description="Cash counts run per location, so the since-last-count anchor only makes sense scoped to one. Pick a location from the filter above."
        />
      ) : error ? (
        <ErrorBlock message={error} />
      ) : loading || !data ? (
        <Skeleton height={220} />
      ) : (
        <SinceLastCountBody data={data} />
      )}
    </Card>
  );
}

function SinceLastCountBody({
  data,
}: {
  data: NonNullable<
    ReturnType<typeof useCashDrawerSinceLastCount>['data']
  >;
}) {
  const anchor = data.last_signed_count;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: theme.space[3],
        }}
      >
        <StatCard
          label="Expected in safe"
          value={formatPence(data.expected_in_safe_pence)}
          tone="accent"
          delta={
            data.payment_count === 0
              ? 'no cash since last count'
              : `${formatNumber(data.payment_count)} cash payment${data.payment_count === 1 ? '' : 's'}`
          }
        />
        <StatCard
          label="Anchor"
          value={anchor ? 'Last signed count' : 'No count yet'}
          delta={
            anchor
              ? `since ${formatDateTime(anchor.period_end)}`
              : 'showing every cash payment ever for this location'
          }
        />
        <StatCard
          label="Last count actual"
          value={
            anchor && anchor.actual_pence !== null
              ? formatPence(anchor.actual_pence)
              : '—'
          }
          delta={
            anchor
              ? `signed off ${formatDateTime(anchor.signed_off_at)}`
              : 'run a count to establish a baseline'
          }
        />
      </div>

      {data.lines.length === 0 ? (
        <EmptyState
          icon={<ReceiptText size={20} />}
          title="No cash since the last count"
          description="The safe should still hold exactly what the last signed count recorded."
        />
      ) : (
        <PaymentsTable
          title="Contributing payments"
          subtitle="Cash payments captured at this location since the last signed count, newest first."
          lines={data.lines}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 2 — Past settlements (signed counts)
// ─────────────────────────────────────────────────────────────────────────────
//
// Each row is one signed cash count, ordered newest first. Clicking a
// row expands an inline drawer showing the payment lines that the
// count was built from (immutable snapshot in lng_cash_count_lines).
// Lines are loaded lazily via useCashCountStatement — one fetch at a
// time, keyed on the expandedCountId, so opening a count is cheap
// even when there are hundreds of past settlements visible.

interface PastSettlementsSectionProps {
  locationName: string | null;
  data: PastSettlementRow[] | null;
  loading: boolean;
  error: string | null;
}

function PastSettlementsSection({
  locationName,
  data,
  loading,
  error,
}: PastSettlementsSectionProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const statement = useCashCountStatement(expandedId);

  return (
    <Card padding="lg">
      <SectionHeader
        title="Past settlements"
        subtitle={
          locationName
            ? `Every reconciled cash count at ${locationName}, newest first. Click a row to see the payments included in that settlement.`
            : 'Every reconciled cash count across the locations you can see. Click a row to see the payments included in that settlement.'
        }
      />

      {error ? (
        <ErrorBlock message={error} />
      ) : loading || !data ? (
        <Skeleton height={200} />
      ) : data.length === 0 ? (
        <EmptyState
          icon={<ScrollText size={20} />}
          title="No settlements yet"
          description="Once a cash count is signed off it shows here. The first count establishes the chain."
        />
      ) : (
        <SettlementsList
          rows={data}
          expandedId={expandedId}
          onToggle={(id) =>
            setExpandedId((current) => (current === id ? null : id))
          }
          statementData={statement.data}
          statementLoading={statement.loading}
          statementError={statement.error}
        />
      )}
    </Card>
  );
}

function SettlementsList({
  rows,
  expandedId,
  onToggle,
  statementData,
  statementLoading,
  statementError,
}: {
  rows: PastSettlementRow[];
  expandedId: string | null;
  onToggle: (id: string) => void;
  statementData: ReturnType<typeof useCashCountStatement>['data'];
  statementLoading: boolean;
  statementError: string | null;
}) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: theme.type.size.sm,
        }}
      >
        <thead>
          <tr>
            <th style={{ ...th, width: 28 }} aria-hidden></th>
            <th style={th}>Signed off</th>
            <th style={th}>Counter / signer</th>
            <th style={{ ...th, textAlign: 'right' }}>Expected</th>
            <th style={{ ...th, textAlign: 'right' }}>Actual</th>
            <th style={{ ...th, textAlign: 'right' }}>Variance</th>
            <th style={th}>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const open = expandedId === row.id;
            // Only show statement when it matches the expanded row.
            // useCashCountStatement keeps the previous data around while
            // loading the next one — guard so we don't briefly flash the
            // previous count's lines under the new one.
            const matchedStatement =
              open && statementData?.count.id === row.id ? statementData : null;
            return (
              <FragmentRow
                key={row.id}
                row={row}
                open={open}
                onToggle={() => onToggle(row.id)}
                statement={matchedStatement}
                statementLoading={open && statementLoading && !matchedStatement}
                statementError={open ? statementError : null}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FragmentRow({
  row,
  open,
  onToggle,
  statement,
  statementLoading,
  statementError,
}: {
  row: PastSettlementRow;
  open: boolean;
  onToggle: () => void;
  statement: ReturnType<typeof useCashCountStatement>['data'];
  statementLoading: boolean;
  statementError: string | null;
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        style={{
          borderTop: `1px solid ${theme.color.border}`,
          cursor: 'pointer',
          background: open ? `${theme.color.accent}06` : 'transparent',
          transition: 'background 0.15s ease',
        }}
      >
        <td style={{ ...td, color: theme.color.inkMuted, paddingRight: 0 }}>
          {open ? (
            <ChevronDown size={14} aria-hidden />
          ) : (
            <ChevronRight size={14} aria-hidden />
          )}
        </td>
        <td style={td}>
          <div style={{ fontWeight: theme.type.weight.semibold }}>
            {row.signed_off_at ? formatDateTime(row.signed_off_at) : '—'}
          </div>
          <div
            style={{
              fontSize: theme.type.size.xs,
              color: theme.color.inkMuted,
            }}
          >
            Period to {formatDateTime(row.period_end)}
          </div>
        </td>
        <td style={td}>
          <div>{row.counted_by_name}</div>
          {row.signed_off_by_name ? (
            <div
              style={{
                fontSize: theme.type.size.xs,
                color: theme.color.inkMuted,
              }}
            >
              Signed by {row.signed_off_by_name}
            </div>
          ) : null}
        </td>
        <td style={tdRight}>{formatPence(row.expected_pence)}</td>
        <td style={tdRight}>
          {row.actual_pence !== null ? formatPence(row.actual_pence) : '—'}
        </td>
        <td
          style={{
            ...tdRight,
            color:
              row.variance_pence === 0
                ? theme.color.inkMuted
                : row.variance_pence > 0
                  ? theme.color.warn
                  : theme.color.alert,
            fontWeight:
              row.variance_pence === 0
                ? theme.type.weight.regular
                : theme.type.weight.semibold,
          }}
        >
          {row.variance_pence === 0
            ? '£0.00'
            : `${row.variance_pence > 0 ? '+' : '−'}${formatPence(Math.abs(row.variance_pence))}`}
        </td>
        <td style={td}>
          <SettlementStatusPill status={row.status} />
        </td>
      </tr>
      {open ? (
        <tr style={{ background: `${theme.color.accent}04` }}>
          <td colSpan={7} style={{ padding: 0 }}>
            <div style={{ padding: theme.space[4] }}>
              <ExpandedSettlement
                row={row}
                statement={statement}
                loading={statementLoading}
                error={statementError}
              />
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function ExpandedSettlement({
  row,
  statement,
  loading,
  error,
}: {
  row: PastSettlementRow;
  statement: ReturnType<typeof useCashCountStatement>['data'];
  loading: boolean;
  error: string | null;
}) {
  if (error) return <ErrorBlock message={error} />;
  if (loading || !statement) return <Skeleton height={120} />;

  if (statement.lines.length === 0) {
    return (
      <div
        style={{
          fontSize: theme.type.size.sm,
          color: theme.color.inkMuted,
          padding: theme.space[3],
        }}
      >
        No cash payments were recorded for this settlement.
        {row.notes ? ` Counter's note: ${row.notes}` : ''}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
      {row.notes ? (
        <div
          style={{
            fontSize: theme.type.size.sm,
            color: theme.color.ink,
            background: `${theme.color.accent}08`,
            borderLeft: `3px solid ${theme.color.accent}`,
            padding: theme.space[3],
            borderRadius: theme.radius.input,
            lineHeight: 1.5,
          }}
        >
          <span style={{ fontWeight: theme.type.weight.semibold }}>
            Counter's note —{' '}
          </span>
          {row.notes}
        </div>
      ) : null}
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: theme.type.size.sm,
        }}
      >
        <thead>
          <tr>
            <th style={th}>When</th>
            <th style={th}>Patient</th>
            <th style={th}>Reference</th>
            <th style={{ ...th, textAlign: 'right' }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {statement.lines.map((line) => (
            <tr
              key={line.payment_id}
              style={{ borderTop: `1px solid ${theme.color.border}` }}
            >
              <td style={td}>{formatDateTime(line.taken_at)}</td>
              <td style={td}>
                <div style={{ fontWeight: theme.type.weight.semibold }}>
                  {line.patient_name}
                </div>
              </td>
              <td style={td}>
                {line.appointment_ref ? (
                  <span
                    style={{
                      fontVariantNumeric: 'tabular-nums',
                      color: theme.color.inkMuted,
                    }}
                  >
                    {line.appointment_ref}
                  </span>
                ) : (
                  <span style={{ color: theme.color.inkMuted }}>—</span>
                )}
              </td>
              <td style={{ ...tdRight, fontWeight: theme.type.weight.semibold }}>
                {formatPence(line.amount_pence)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SettlementStatusPill({ status }: { status: 'pending' | 'signed' | 'disputed' }) {
  if (status === 'signed') {
    return (
      <StatusPill tone="arrived" size="sm">
        Signed
      </StatusPill>
    );
  }
  if (status === 'disputed') {
    return (
      <StatusPill tone="cancelled" size="sm">
        Disputed
      </StatusPill>
    );
  }
  return (
    <StatusPill tone="pending" size="sm">
      Pending
    </StatusPill>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 3 — All cash sale records in range
// ─────────────────────────────────────────────────────────────────────────────

interface InRangeSectionProps {
  range: DateRange;
  scopedToLocation: string | null;
  data: ReturnType<typeof useCashPaymentsInRange>['data'];
  loading: boolean;
  error: string | null;
}

function InRangeSection({
  range,
  scopedToLocation,
  data,
  loading,
  error,
}: InRangeSectionProps) {
  return (
    <Card padding="lg">
      <SectionHeader
        title="All cash sale records"
        subtitle={`Every cash capture and void in ${dateRangeLabel(range)}${
          scopedToLocation ? ` at ${scopedToLocation}` : ' across all visible locations'
        }.`}
      />

      {error ? (
        <ErrorBlock message={error} />
      ) : loading || !data ? (
        <Skeleton height={260} />
      ) : (
        <InRangeBody data={data} />
      )}
    </Card>
  );
}

function InRangeBody({
  data,
}: {
  data: NonNullable<ReturnType<typeof useCashPaymentsInRange>['data']>;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: theme.space[3],
        }}
      >
        <StatCard
          label="Cash captured"
          value={formatPence(data.succeeded_pence)}
          tone="accent"
          delta={`${formatNumber(data.succeeded_count)} payment${data.succeeded_count === 1 ? '' : 's'}`}
        />
        <StatCard
          label="Voided / refunded"
          value={`−${formatPence(data.voided_pence)}`}
          tone={data.voided_count > 0 ? 'warn' : 'normal'}
          delta={
            data.voided_count > 0
              ? `${formatNumber(data.voided_count)} reversed`
              : 'none in this period'
          }
        />
        <StatCard
          label="Net cash"
          value={formatPence(data.net_pence)}
          delta="captured minus voids"
        />
      </div>

      {data.lines.length === 0 ? (
        <EmptyState
          icon={<ReceiptText size={20} />}
          title="No cash payments in this range"
          description="Try a wider date range, or switch to a different location."
        />
      ) : (
        <PaymentsTable
          title="Cash log"
          subtitle="Every captured or voided cash payment, newest first."
          lines={data.lines}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared bits
// ─────────────────────────────────────────────────────────────────────────────

function SectionHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  return (
    <div style={{ marginBottom: theme.space[4] }}>
      <h3
        style={{
          margin: 0,
          fontSize: theme.type.size.md,
          fontWeight: theme.type.weight.semibold,
        }}
      >
        {title}
      </h3>
      <p
        style={{
          margin: `${theme.space[1]}px 0 0`,
          fontSize: theme.type.size.xs,
          color: theme.color.inkMuted,
          maxWidth: 640,
          lineHeight: 1.5,
        }}
      >
        {subtitle}
      </p>
    </div>
  );
}

function ErrorBlock({ message }: { message: string }) {
  return (
    <div
      style={{
        padding: theme.space[3],
        borderRadius: theme.radius.input,
        background: `${theme.color.alert}10`,
        border: `1px solid ${theme.color.alert}30`,
        color: theme.color.alert,
        fontSize: theme.type.size.sm,
        lineHeight: 1.5,
      }}
    >
      Could not load this section. {message}
    </div>
  );
}

function PaymentsTable({
  title,
  subtitle,
  lines,
}: {
  title: string;
  subtitle: string;
  lines: CashDrawerLine[];
}) {
  return (
    <div>
      <div style={{ marginBottom: theme.space[3] }}>
        <h4
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
          }}
        >
          {title}
        </h4>
        <p
          style={{
            margin: `${theme.space[1]}px 0 0`,
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
          }}
        >
          {subtitle}
        </p>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: theme.type.size.sm,
          }}
        >
          <thead>
            <tr>
              <th style={th}>When</th>
              <th style={th}>Patient</th>
              <th style={th}>Reference</th>
              <th style={th}>Taken by</th>
              <th style={{ ...th, textAlign: 'right' }}>Amount</th>
              <th style={th}>Status</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr
                key={l.payment_id}
                style={{ borderTop: `1px solid ${theme.color.border}` }}
              >
                <td style={td}>{formatDateTime(l.occurred_at)}</td>
                <td style={td}>
                  <div style={{ fontWeight: theme.type.weight.semibold }}>
                    {l.patient_name}
                  </div>
                </td>
                <td style={td}>
                  {l.appointment_ref ? (
                    <span
                      style={{
                        fontVariantNumeric: 'tabular-nums',
                        color: theme.color.inkMuted,
                      }}
                    >
                      {l.appointment_ref}
                    </span>
                  ) : (
                    <span style={{ color: theme.color.inkMuted }}>—</span>
                  )}
                </td>
                <td style={td}>{l.taken_by_name}</td>
                <td
                  style={{
                    ...tdRight,
                    fontWeight: theme.type.weight.semibold,
                    color:
                      l.status === 'cancelled'
                        ? theme.color.inkMuted
                        : theme.color.ink,
                  }}
                >
                  {l.status === 'cancelled'
                    ? `−${formatPence(l.amount_pence)}`
                    : formatPence(l.amount_pence)}
                </td>
                <td style={td}>
                  <PaymentStatusPill line={l} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PaymentStatusPill({ line }: { line: CashDrawerLine }) {
  if (line.status === 'cancelled') {
    return (
      <StatusPill tone="cancelled" size="sm">
        {line.void_reason ? `Voided, ${line.void_reason}` : 'Voided'}
      </StatusPill>
    );
  }
  return (
    <StatusPill tone="arrived" size="sm">
      Captured
    </StatusPill>
  );
}

function formatDateTime(iso: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
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
