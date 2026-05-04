import { useMemo, useState } from 'react';
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
import { ServiceMixTab } from './ServiceMixTab.tsx';
import { LifetimeValueTab } from './LifetimeValueTab.tsx';
import { OverviewTab as FinancialOverviewTab } from '../Financials/OverviewTab.tsx';
import { SalesTab } from '../Financials/SalesTab.tsx';
import { DiscountsTab } from '../Financials/DiscountsTab.tsx';
import { VoidsTab } from '../Financials/VoidsTab.tsx';
import { AnomaliesTab } from '../Financials/AnomaliesTab.tsx';
import { CashReconciliationTab } from '../Financials/CashReconciliationTab.tsx';

// Reports — combined operational + financial dashboards.
//
// Operational tabs are visible to anyone with can_view_reports
// (default true for every Lounge staff member). Financial tabs are
// gated behind can_view_financials and only appear if the signed-in
// account has the flag set in Admin → Staff. The single page hosts
// both so the user has one destination for "show me the numbers."
//
// Sub-pages live in their own files for readability and to keep this
// route from growing into another 2000-line beast like Admin. Each
// tab is a self-contained component that takes the shared DateRange
// as a prop and owns its own data fetch + filters + charts.

type Tab =
  // ── Operational (everyone with can_view_reports) ────────────────
  | 'overview'
  | 'bookings_vs_walkins'
  | 'demographics'
  | 'marketing'
  | 'service_mix'
  | 'lifetime_value'
  // ── Financial (gated by can_view_financials) ────────────────────
  | 'fin_overview'
  | 'sales'
  | 'discounts'
  | 'voids'
  | 'anomalies'
  | 'cash_reconciliation';

const OPERATIONAL_TABS: { value: Tab; label: string }[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'bookings_vs_walkins', label: 'Bookings vs walk-ins' },
  { value: 'demographics', label: 'Demographics' },
  { value: 'marketing', label: 'Marketing' },
  { value: 'service_mix', label: 'Service mix' },
  { value: 'lifetime_value', label: 'Lifetime value' },
];

const FINANCIAL_TABS: { value: Tab; label: string }[] = [
  { value: 'fin_overview', label: 'Financial overview' },
  { value: 'sales', label: 'Sales' },
  { value: 'discounts', label: 'Discounts' },
  { value: 'voids', label: 'Voids' },
  { value: 'anomalies', label: 'Anomaly flags' },
  { value: 'cash_reconciliation', label: 'Cash reconciliation' },
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

  // Build the visible tab list based on permissions. Operational
  // tabs are always present; financial tabs only appear when the
  // signed-in account has can_view_financials.
  const tabs = useMemo(() => {
    if (!account) return OPERATIONAL_TABS;
    return account.can_view_financials
      ? [...OPERATIONAL_TABS, ...FINANCIAL_TABS]
      : OPERATIONAL_TABS;
  }, [account]);

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
              {account.can_view_financials
                ? 'Operational and money-side reports together. Tabs after Lifetime value are gated behind your financials permission.'
                : 'Live operational reports. Every signed-in staff member sees these. Money-side reports require an additional permission, granted in Admin → Staff.'}
            </p>
          </div>
          <DateRangePicker value={range} onChange={setRange} />
        </div>

        <div style={{ marginTop: theme.space[5], marginBottom: theme.space[5] }}>
          <SegmentedControl<Tab> scrollable value={tab} onChange={setTab} options={tabs} />
        </div>

        {tab === 'overview' ? (
          <OverviewTab range={range} />
        ) : tab === 'bookings_vs_walkins' ? (
          <BookingsVsWalkInsTab range={range} />
        ) : tab === 'demographics' ? (
          <DemographicsTab range={range} />
        ) : tab === 'marketing' ? (
          <MarketingTab range={range} />
        ) : tab === 'service_mix' ? (
          <ServiceMixTab range={range} />
        ) : tab === 'lifetime_value' ? (
          <LifetimeValueTab range={range} />
        ) : tab === 'fin_overview' ? (
          <FinancialOverviewTab range={range} />
        ) : tab === 'sales' ? (
          <SalesTab range={range} />
        ) : tab === 'discounts' ? (
          <DiscountsTab range={range} />
        ) : tab === 'voids' ? (
          <VoidsTab range={range} />
        ) : tab === 'anomalies' ? (
          <AnomaliesTab range={range} />
        ) : tab === 'cash_reconciliation' ? (
          <CashReconciliationTab />
        ) : (
          <ComingSoon section={tabs.find((t) => t.value === tab)?.label ?? 'Section'} />
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
