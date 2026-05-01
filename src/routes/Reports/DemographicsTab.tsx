import { useMemo } from 'react';
import { Hash, Lock, Map as MapIcon, Sparkles, UserPlus, Users } from 'lucide-react';
import {
  BarChart,
  Card,
  EmptyState,
  Skeleton,
  StatCard,
  VisitorAddressMap,
  VisitorHeatmap,
} from '../../components/index.ts';
import { theme } from '../../theme/index.ts';
import { type DateRange, dateRangeLabel } from '../../lib/dateRange.ts';
import {
  type PatientReports,
  useReportsPatients,
  useReportsVisitorAddressMap,
  useReportsVisitorMap,
} from '../../lib/queries/reports.ts';
import { usePostcodeGeocodes } from '../../lib/queries/postcodeGeocodes.ts';
import { useAddressGeocodes } from '../../lib/queries/addressGeocodes.ts';
import { useCurrentAccount } from '../../lib/queries/currentAccount.ts';
import { formatNumber, formatPence } from '../../lib/queries/carts.ts';

interface Props {
  range: DateRange;
}

export function DemographicsTab({ range }: Props) {
  const { data, loading, error } = useReportsPatients(range);

  if (error) {
    return (
      <Card padding="lg">
        <p style={{ margin: 0, color: theme.color.alert }}>
          Could not load demographics for {dateRangeLabel(range)}: {error}
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
  if (data.total_unique_patients === 0) {
    return (
      <Card padding="lg">
        <EmptyState
          icon={<Users size={20} />}
          title="No patients in this period"
          description="No visits opened. Try a wider date range."
        />
      </Card>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <Kpis data={data} />
      <VisitorMapCard range={range} />
      <AgeBarsCard data={data} />
      <SexBreakdownCard data={data} />
      <PostcodeCard data={data} />
    </div>
  );
}

// Demographics map — switches between two resolutions based on the
// caller's role:
//
//   • Admin / super admin    → address-resolution map. One pin per
//                              unique patient address with hover
//                              showing LAP refs and items per visit.
//                              Personal data, gated to leadership.
//
//   • Other staff            → outward-postcode heatmap. Coarser,
//                              privacy-safer; no individual addresses
//                              ever surface client-side.
//
// The split happens at this card level rather than inside the map
// component so each variant owns its own data-fetching path. The
// admin variant queries patient line1; the non-admin variant never
// touches that column.
function VisitorMapCard({ range }: { range: DateRange }) {
  const { account } = useCurrentAccount();
  const isAdmin = account?.is_admin === true || account?.is_super_admin === true;
  return isAdmin ? (
    <AdminAddressMap range={range} />
  ) : (
    <OutwardHeatmap range={range} />
  );
}

function OutwardHeatmap({ range }: { range: DateRange }) {
  const map = useReportsVisitorMap(range);
  const outwards = useMemo(() => map.data?.points.map((p) => p.outward) ?? [], [map.data]);
  const geocodes = usePostcodeGeocodes(outwards);

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
        <MapIcon size={16} aria-hidden /> Visitor heatmap
      </h3>
      <p
        style={{
          margin: `${theme.space[1]}px 0 ${theme.space[4]}px`,
          fontSize: theme.type.size.xs,
          color: theme.color.inkMuted,
        }}
      >
        Where customers are coming from. Click a service in the legend to drill into repair variants, appliance types, or arches. Outward postcodes only — no individual addresses on this map.
      </p>
      {map.error || geocodes.error ? (
        <p style={{ margin: 0, color: theme.color.alert, fontSize: theme.type.size.sm }}>
          {map.error ?? geocodes.error}
        </p>
      ) : map.loading || !map.data || geocodes.loading ? (
        <Skeleton height={480} />
      ) : map.data.points.length === 0 ? (
        <EmptyState
          icon={<MapIcon size={20} />}
          title="No mappable visitors"
          description="No patients with a postcode on file in this period."
        />
      ) : (
        <>
          <VisitorHeatmap data={map.data} geocodes={geocodes.data} />
          {map.data.unknown_outward > 0 ? (
            <p style={{ margin: `${theme.space[3]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>
              {formatNumber(map.data.unknown_outward)} additional patient{map.data.unknown_outward === 1 ? '' : 's'} with no postcode on file (not shown).
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}

function AdminAddressMap({ range }: { range: DateRange }) {
  const map = useReportsVisitorAddressMap(range);
  // De-duplicated address inputs to feed the geocode hook. Two visits
  // at the same address resolve to one entry — the hook batches
  // and caches at this level so we never hit Google twice for one
  // address.
  const addresses = useMemo(
    () =>
      map.data?.points.map((p) => ({
        line1: p.line1,
        postcode: p.postcode,
      })) ?? [],
    [map.data],
  );
  const geocodes = useAddressGeocodes(addresses);

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
        <MapIcon size={16} aria-hidden /> Visitor heatmap
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: theme.space[1],
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
            fontWeight: theme.type.weight.medium,
            border: `1px solid ${theme.color.border}`,
            borderRadius: theme.radius.pill,
            padding: `2px ${theme.space[2]}px`,
          }}
        >
          <Lock size={11} aria-hidden /> Admin
        </span>
      </h3>
      <p
        style={{
          margin: `${theme.space[1]}px 0 ${theme.space[4]}px`,
          fontSize: theme.type.size.xs,
          color: theme.color.inkMuted,
        }}
      >
        One pin per unique patient address. Hover a pin for visit dates, LAP refs, and what was booked. Visible to admins only.
      </p>
      {map.error || geocodes.error ? (
        <p style={{ margin: 0, color: theme.color.alert, fontSize: theme.type.size.sm }}>
          {map.error ?? geocodes.error}
        </p>
      ) : map.loading || !map.data || geocodes.loading ? (
        <Skeleton height={480} />
      ) : map.data.points.length === 0 ? (
        <EmptyState
          icon={<MapIcon size={20} />}
          title="No mappable visitors"
          description="No patients with a usable address on file in this period."
        />
      ) : (
        <>
          <VisitorAddressMap data={map.data} geocodes={geocodes.data} />
          {map.data.unmappable_visits > 0 ? (
            <p style={{ margin: `${theme.space[3]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>
              {formatNumber(map.data.unmappable_visits)} visit{map.data.unmappable_visits === 1 ? '' : 's'} with an incomplete address (no street line or invalid postcode) not shown.
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}

function Kpis({ data }: { data: PatientReports }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: theme.space[3],
      }}
    >
      <StatCard
        label="Unique patients"
        value={formatNumber(data.total_unique_patients)}
        delta={`${formatNumber(data.visits_in_period)} visits across them`}
        icon={<Users size={14} />}
      />
      <StatCard
        label="New patients"
        value={formatNumber(data.new_patients)}
        delta={
          data.total_unique_patients === 0
            ? '—'
            : `${Math.round((data.new_patients / data.total_unique_patients) * 100)}% of patients in period`
        }
        tone="accent"
        icon={<UserPlus size={14} />}
      />
      <StatCard
        label="Returning"
        value={formatNumber(data.returning_patients)}
        delta="seen before this period"
        icon={<Sparkles size={14} />}
      />
      <StatCard
        label="Revenue (paid carts)"
        value={formatPence(data.revenue_in_period_pence)}
        delta="Across patients seen in period"
        tone="accent"
      />
    </div>
  );
}

function AgeBarsCard({ data }: { data: PatientReports }) {
  return (
    <Card padding="lg">
      <BarChart
        title="Age distribution"
        subtitle="Bracket counts at the end of the period. Unknown = patient has no DOB recorded."
        bars={data.age_distribution.map((b) => ({
          id: b.bracket,
          label: b.label,
          value: b.count,
          colour: b.bracket === 'unknown' ? theme.color.inkSubtle : theme.color.accent,
        }))}
        ariaSummary="Bar chart of patients by age bracket."
      />
    </Card>
  );
}

function SexBreakdownCard({ data }: { data: PatientReports }) {
  const total = data.sex_distribution.reduce((s, e) => s + e.count, 0);
  if (total === 0) {
    return null;
  }
  return (
    <Card padding="lg">
      <h3 style={{ margin: 0, fontSize: theme.type.size.md, fontWeight: theme.type.weight.semibold }}>
        Sex breakdown
      </h3>
      <p
        style={{
          margin: `${theme.space[1]}px 0 ${theme.space[4]}px`,
          fontSize: theme.type.size.xs,
          color: theme.color.inkMuted,
        }}
      >
        From the patient record. "Unknown / not stated" covers blanks.
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
        {data.sex_distribution.map((entry) => {
          const pct = (entry.count / total) * 100;
          return (
            <li key={entry.key} style={{ minWidth: 0 }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  gap: theme.space[3],
                  marginBottom: theme.space[2],
                }}
              >
                <span style={{ fontSize: theme.type.size.sm, color: theme.color.ink, fontWeight: theme.type.weight.semibold }}>
                  {entry.label}
                </span>
                <span style={{ fontSize: theme.type.size.sm, color: theme.color.ink, fontVariantNumeric: 'tabular-nums' }}>
                  {formatNumber(entry.count)} · {pct.toFixed(0)}%
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
                    background: entry.key === 'unknown' ? theme.color.inkSubtle : theme.color.accent,
                  }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function PostcodeCard({ data }: { data: PatientReports }) {
  if (data.postcode_areas.length === 0) {
    return null;
  }
  const max = data.postcode_areas[0]?.count ?? 0;
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
        <MapIcon size={16} aria-hidden /> Where they came from
      </h3>
      <p
        style={{
          margin: `${theme.space[1]}px 0 ${theme.space[4]}px`,
          fontSize: theme.type.size.xs,
          color: theme.color.inkMuted,
        }}
      >
        Outward postcode (e.g. SW1A) only — privacy-safer and still maps to neighbourhoods. Top 10 + everything else.
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
        {data.postcode_areas.map((p) => {
          const pct = max > 0 ? (p.count / max) * 100 : 0;
          return (
            <li key={p.outward} style={{ minWidth: 0 }}>
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
                  <Hash size={12} style={{ marginRight: theme.space[1], opacity: 0.6 }} />
                  {p.outward}
                </span>
                <span style={{ fontSize: theme.type.size.sm, fontVariantNumeric: 'tabular-nums' }}>
                  {formatNumber(p.count)} patients · {formatPence(p.revenue_pence)}
                </span>
              </div>
              <div
                style={{
                  height: 6,
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
            </li>
          );
        })}
        {data.postcode_other.count > 0 ? (
          <li
            style={{
              padding: theme.space[3],
              borderRadius: theme.radius.input,
              background: theme.color.bg,
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginTop: theme.space[2],
            }}
          >
            <span>Everywhere else</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>
              {formatNumber(data.postcode_other.count)} patients · {formatPence(data.postcode_other.revenue_pence)}
            </span>
          </li>
        ) : null}
      </ul>
    </Card>
  );
}
