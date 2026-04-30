import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import {
  Card,
  DateRangePicker,
  EmptyState,
  SegmentedControl,
} from '../../components/index.ts';
import { BOTTOM_NAV_HEIGHT } from '../../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../../components/KioskStatusBar/KioskStatusBar.tsx';
import { theme } from '../../theme/index.ts';
import { useAuth } from '../../lib/auth.tsx';
import { useCurrentAccount } from '../../lib/queries/currentAccount.ts';
import { useIsMobile } from '../../lib/useIsMobile.ts';
import { defaultDateRange, type DateRange } from '../../lib/dateRange.ts';
import { BarChart3 } from 'lucide-react';
import { OverviewTab } from './OverviewTab.tsx';
import { BookingsVsWalkInsTab } from './BookingsVsWalkInsTab.tsx';
import { DemographicsTab } from './DemographicsTab.tsx';
import { MarketingTab } from './MarketingTab.tsx';

// Reports — operational dashboards. Visible to anyone with
// can_view_reports (default true for every Lounge staff member).
//
// Sub-pages live in their own files for readability and to keep this
// route from growing into another 2000-line beast like Admin. Each
// tab is a self-contained component that takes the shared DateRange
// as a prop and owns its own data fetch + filters + charts.

type Tab =
  | 'overview'
  | 'bookings_vs_walkins'
  | 'demographics'
  | 'marketing'
  | 'service_mix'
  | 'lifetime_value';

const TABS: { value: Tab; label: string }[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'bookings_vs_walkins', label: 'Bookings vs walk-ins' },
  { value: 'demographics', label: 'Demographics' },
  { value: 'marketing', label: 'Marketing' },
  { value: 'service_mix', label: 'Service mix' },
  { value: 'lifetime_value', label: 'Lifetime value' },
];

export function Reports() {
  const { user, loading: authLoading } = useAuth();
  const { account, loading: accountLoading } = useCurrentAccount();
  const isMobile = useIsMobile(640);
  const [tab, setTab] = useState<Tab>('overview');
  // The date range is owned at the route level so switching tabs
  // preserves whatever period the user was looking at. Defaults to
  // the last 30 days — long enough for trends, short enough for a
  // snappy first paint.
  const [range, setRange] = useState<DateRange>(() => defaultDateRange());

  if (authLoading || accountLoading) return null;
  if (!user) return <Navigate to="/sign-in" replace />;
  if (!account || !account.can_view_reports) {
    return <Navigate to="/" replace />;
  }

  return (
    <main
      style={{
        minHeight: '100dvh',
        background: theme.color.bg,
        padding: isMobile ? theme.space[4] : theme.space[6],
        paddingTop: `calc(${KIOSK_STATUS_BAR_HEIGHT}px + ${
          isMobile ? theme.space[4] : theme.space[6]
        }px + env(safe-area-inset-top, 0px))`,
        paddingBottom: `calc(${BOTTOM_NAV_HEIGHT}px + ${
          isMobile ? theme.space[6] : theme.space[8]
        }px + env(safe-area-inset-bottom, 0px))`,
      }}
    >
      <div style={{ maxWidth: theme.layout.pageMaxWidth, margin: '0 auto' }}>
        {/* Header row: title left, date range picker right. Wraps on
            narrow widths so the picker drops below the title. */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: theme.space[3],
            flexWrap: 'wrap',
            marginBottom: theme.space[2],
          }}
        >
          <div>
            <h1
              style={{
                margin: 0,
                fontSize: isMobile ? theme.type.size.xl : theme.type.size.xxl,
                fontWeight: theme.type.weight.semibold,
                letterSpacing: theme.type.tracking.tight,
              }}
            >
              Reports
            </h1>
            <p
              style={{
                margin: `${theme.space[2]}px 0 0`,
                color: theme.color.inkMuted,
                fontSize: theme.type.size.sm,
                maxWidth: 640,
              }}
            >
              Live operational reports. Every signed-in staff member sees these.
              Money-side reports live in <strong>Financials</strong> — gated separately.
            </p>
          </div>
          <DateRangePicker value={range} onChange={setRange} />
        </div>

        <div style={{ marginTop: theme.space[5], marginBottom: theme.space[5], overflowX: 'auto' }}>
          <SegmentedControl<Tab> value={tab} onChange={setTab} options={TABS} />
        </div>

        {tab === 'overview' ? (
          <OverviewTab range={range} />
        ) : tab === 'bookings_vs_walkins' ? (
          <BookingsVsWalkInsTab range={range} />
        ) : tab === 'demographics' ? (
          <DemographicsTab range={range} />
        ) : tab === 'marketing' ? (
          <MarketingTab range={range} />
        ) : (
          <ComingSoon section={TABS.find((t) => t.value === tab)?.label ?? 'Section'} />
        )}
      </div>
    </main>
  );
}

function ComingSoon({ section }: { section: string }) {
  return (
    <Card padding="lg">
      <EmptyState
        icon={<BarChart3 size={20} />}
        title={`${section} — coming next`}
        description="The Reports section is being built page by page. This tab fills in shortly. The navigation, permission gates, and shared filters are wired now so the rollout doesn't disrupt the rest of Lounge."
      />
    </Card>
  );
}
