import { Megaphone, TrendingUp, Users } from 'lucide-react';
import {
  Button,
  Card,
  EmptyState,
  Skeleton,
  StatCard,
} from '../../components/index.ts';
import { theme } from '../../theme/index.ts';
import { type DateRange, dateRangeLabel } from '../../lib/dateRange.ts';
import {
  type ReferralSourceEntry,
  useReportsPatients,
} from '../../lib/queries/reports.ts';
import { formatPence } from '../../lib/queries/carts.ts';
import { csvFilename, downloadCsv, toCsv, type CsvColumn } from '../../lib/csv.ts';

interface Props {
  range: DateRange;
}

export function MarketingTab({ range }: Props) {
  const { data, loading, error } = useReportsPatients(range);

  if (error) {
    return (
      <Card padding="lg">
        <p style={{ margin: 0, color: theme.color.alert }}>
          Could not load marketing report for {dateRangeLabel(range)}: {error}
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
  if (data.referral_sources.length === 0) {
    return (
      <Card padding="lg">
        <EmptyState
          icon={<Megaphone size={20} />}
          title="No patients in this period"
          description="No referral data yet. Try a wider date range."
        />
      </Card>
    );
  }

  const top = data.referral_sources[0];
  const totalRevenue = data.referral_sources.reduce((s, e) => s + e.revenue_pence, 0);

  const exportCsv = () => {
    const columns: CsvColumn<ReferralSourceEntry>[] = [
      { key: 'source', label: 'Source' },
      { key: 'patients', label: 'Unique patients' },
      { key: 'visits', label: 'Visits' },
      { key: 'revenue_pence', label: 'Revenue (£)', format: (v) => (Number(v) / 100).toFixed(2) },
    ];
    const csv = toCsv(data.referral_sources, columns);
    downloadCsv(csvFilename('marketing_attribution', range), csv);
  };

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
          label="Channels active"
          value={data.referral_sources.length.toLocaleString('en-GB')}
          delta={`${data.total_unique_patients.toLocaleString('en-GB')} patients across all`}
          icon={<Megaphone size={14} />}
        />
        <StatCard
          label="Top channel"
          value={top ? top.source : '—'}
          delta={top ? `${top.patients.toLocaleString('en-GB')} patients · ${formatPence(top.revenue_pence)}` : '—'}
          tone="accent"
          icon={<TrendingUp size={14} />}
        />
        <StatCard
          label="Total attributed revenue"
          value={formatPence(totalRevenue)}
          delta="From paid carts in period"
          tone="accent"
        />
        <StatCard
          label="Average revenue per patient"
          value={
            data.total_unique_patients === 0
              ? '—'
              : formatPence(Math.round(totalRevenue / data.total_unique_patients))
          }
          delta="Across every channel"
          icon={<Users size={14} />}
        />
      </div>

      <Card padding="lg">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            gap: theme.space[3],
            flexWrap: 'wrap',
          }}
        >
          <div>
            <h3
              style={{
                margin: 0,
                fontSize: theme.type.size.md,
                fontWeight: theme.type.weight.semibold,
              }}
            >
              How patients found us
            </h3>
            <p
              style={{
                margin: `${theme.space[1]}px 0 0`,
                fontSize: theme.type.size.xs,
                color: theme.color.inkMuted,
              }}
            >
              From the patient registration form. Sorted by revenue. "Unspecified" covers blanks.
            </p>
          </div>
          <Button variant="tertiary" size="sm" onClick={exportCsv}>
            Download CSV
          </Button>
        </div>

        <ul
          style={{
            listStyle: 'none',
            margin: `${theme.space[4]}px 0 0`,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: theme.space[3],
          }}
        >
          {data.referral_sources.map((entry, i) => {
            const max = data.referral_sources[0]?.revenue_pence ?? 0;
            const pct = max > 0 ? (entry.revenue_pence / max) * 100 : 0;
            return (
              <li
                key={entry.source}
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
                    marginBottom: theme.space[2],
                  }}
                >
                  <span style={{ fontSize: theme.type.size.sm, fontWeight: theme.type.weight.semibold }}>
                    {i + 1}. {entry.source}
                  </span>
                  <span
                    style={{
                      fontSize: theme.type.size.sm,
                      color: theme.color.ink,
                      fontWeight: theme.type.weight.semibold,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {formatPence(entry.revenue_pence)}
                  </span>
                </div>
                <div
                  style={{
                    height: 6,
                    background: theme.color.surface,
                    borderRadius: theme.radius.pill,
                    overflow: 'hidden',
                    marginBottom: theme.space[2],
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
                    margin: 0,
                    fontSize: theme.type.size.xs,
                    color: theme.color.inkMuted,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {entry.patients.toLocaleString('en-GB')} unique patient{entry.patients === 1 ? '' : 's'} ·{' '}
                  {entry.visits.toLocaleString('en-GB')} visit{entry.visits === 1 ? '' : 's'}
                  {entry.patients > 0
                    ? ` · ${formatPence(Math.round(entry.revenue_pence / entry.patients))} per patient`
                    : ''}
                </p>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
