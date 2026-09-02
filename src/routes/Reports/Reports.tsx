import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
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
import { useCurrentAccount } from '../../lib/queries/currentAccount.tsx';
import { useIsMobile } from '../../lib/useIsMobile.ts';
import { defaultDateRange, type DateRange } from '../../lib/dateRange.ts';
import { BarChart3 } from 'lucide-react';
import { OverviewTab } from './OverviewTab.tsx';
import { BookingsVsWalkInsTab } from './BookingsVsWalkInsTab.tsx';
import { DemographicsTab } from './DemographicsTab.tsx';
import { MarketingTab } from './MarketingTab.tsx';
import { ServiceMixTab } from './ServiceMixTab.tsx';
import { LifetimeValueTab } from './LifetimeValueTab.tsx';
import { OnlineOrdersTab } from './OnlineOrdersTab.tsx';
import { VirtualImpressionsTab } from './VirtualImpressionsTab.tsx';
import { OverviewTab as FinancialOverviewTab } from '../Financials/OverviewTab.tsx';
import { SalesTab } from '../Financials/SalesTab.tsx';
import { RetailSalesTab } from '../Financials/RetailSalesTab.tsx';
import { DiscountsTab } from '../Financials/DiscountsTab.tsx';
import { VoidsTab } from '../Financials/VoidsTab.tsx';
import { AnomaliesTab } from '../Financials/AnomaliesTab.tsx';
import { CashDrawerTab } from '../Financials/CashDrawerTab.tsx';

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
  | 'online_orders'
  | 'virtual_impressions'
  // ── Financial (gated by can_view_financials) ────────────────────
  | 'fin_overview'
  | 'sales'
  | 'retail_sales'
  | 'cash_drawer'
  | 'discounts'
  | 'voids'
  | 'anomalies';

// Every tab carries a one-line answer to "what am I looking at?".
// Fifteen tabs in a single flat strip meant staff had to open a report
// to find out whether it was the one they wanted, and several tabs
// count overlapping things under near-identical names (three separate
// tabs each show a figure called "unique patients", measured against
// three different denominators). The blurb is where that gets said out
// loud, so the nav stops being a guessing game.
//
// `seeAlso` names the sibling tab that covers adjacent ground. The
// tabs are deliberately NOT merged: staff have these URLs bookmarked
// and each report answers a different question. Pointing at the
// neighbour is the honest fix for the overlap.
interface TabDef {
  value: Tab;
  label: string;
  blurb: string;
  seeAlso?: string;
}

// Three groups, ordered the way staff actually ask questions: what
// happened in the clinic, who the patients were, and what it earned.
type TabGroup = 'operations' | 'patients' | 'money';

const GROUP_LABEL: Record<TabGroup, string> = {
  operations: 'Operations',
  patients: 'Patients',
  money: 'Money',
};

const OPERATIONS_TABS: TabDef[] = [
  {
    value: 'overview',
    label: 'Overview',
    blurb:
      'The daily headline. Every visit opened in this period, split by walk-in and scheduled, with the money taken against them.',
    seeAlso:
      'For the booking funnel, no-show rate, and hour-by-hour walk-in demand, use Bookings vs walk-ins.',
  },
  {
    value: 'bookings_vs_walkins',
    label: 'Bookings vs walk-ins',
    blurb:
      'How people reach the clinic. Booked appointments against walk-ins over time, the drop-off at each booking stage, and which hours walk-ins arrive.',
    seeAlso:
      'The headline walk-in and scheduled counts also appear on Overview. They are the same figures, counted the same way.',
  },
  {
    value: 'service_mix',
    label: 'Service mix',
    blurb:
      'What was actually sold. Catalogue lines by volume and revenue, grouped by category, for the whole period.',
    seeAlso: 'Overview shows an abbreviated top-services list from this same data.',
  },
  {
    value: 'online_orders',
    label: 'Online orders',
    blurb:
      'Appointments that arrived with a venneir.com Shopify order attached, and the credit already paid online against them.',
    seeAlso:
      'Unique patients here counts only patients with an online order, not every patient seen. Demographics counts the full set.',
  },
  {
    value: 'virtual_impressions',
    label: 'Virtual impressions',
    blurb:
      'Every virtual impression call: how long the patient stayed against the booked slot, whether they answered, and who was in the room.',
  },
];

const PATIENT_TABS: TabDef[] = [
  {
    value: 'demographics',
    label: 'Demographics',
    blurb:
      'Who came in. Unique patients seen in this period, split new against returning, with age brackets and where they travelled from.',
    seeAlso:
      '"Returning" here means the patient had visited before this period. Lifetime value measures repeat behaviour across their whole history.',
  },
  {
    value: 'lifetime_value',
    label: 'Lifetime value',
    blurb:
      'Takes the patients seen in this period and looks at their entire history: total spend to date, how often they come back, and the gap between visits.',
    seeAlso:
      'The cohort is the same set of patients Demographics counts. The figures are all-time, not period-bound.',
  },
  {
    value: 'marketing',
    label: 'Marketing',
    blurb:
      'Where patients say they heard about us, and the revenue attributed to each channel.',
  },
];

// Cash reconciliation lives at /cash-counts (top-level route, kiosk
// nav button) — staff use it every shift, so it stays as its own
// destination. The "Cash drawer" tab here is a read-only sibling: it
// surfaces expected cash + the contributing payment lines without
// the count-now / sign-off flow, so finance can reconcile from
// Reports without leaving the dashboard.
const FINANCIAL_TABS: TabDef[] = [
  {
    value: 'fin_overview',
    label: 'Financial overview',
    blurb:
      'Money in for the period, by payment method and by day, across every till and terminal.',
    seeAlso:
      'Overview shows a revenue figure from the same payments, narrowed to the carts attached to visits.',
  },
  {
    value: 'sales',
    label: 'Sales',
    blurb: 'Every completed sale as a line-by-line list, searchable and openable.',
  },
  {
    value: 'retail_sales',
    label: 'Retail sales',
    blurb:
      'Quick-sale counter takings only: product sold over the counter with no visit attached.',
    seeAlso: 'These sales are included in the Sales tab and in Financial overview totals.',
  },
  {
    value: 'cash_drawer',
    label: 'Cash drawer',
    blurb:
      'Expected cash for the period and the payment lines that make it up. Read-only.',
    seeAlso:
      'To actually count a drawer and sign it off, use Cash counts in the main navigation.',
  },
  {
    value: 'discounts',
    label: 'Discounts',
    blurb: 'Every discount applied, what it was worth, and who authorised it.',
  },
  {
    value: 'voids',
    label: 'Voids',
    blurb: 'Cancelled and voided transactions, with the reason recorded at the time.',
  },
  {
    value: 'anomalies',
    label: 'Anomaly flags',
    blurb:
      'Transactions the system flagged as worth a second look: unusual refunds, repeated voids, and out-of-pattern discounts.',
  },
];

const OPERATIONAL_TABS: TabDef[] = [...OPERATIONS_TABS, ...PATIENT_TABS];

function groupOf(tab: Tab): TabGroup {
  if (OPERATIONS_TABS.some((t) => t.value === tab)) return 'operations';
  if (PATIENT_TABS.some((t) => t.value === tab)) return 'patients';
  return 'money';
}

export function Reports() {
  const { user, loading: authLoading } = useAuth();
  const { account, loading: accountLoading } = useCurrentAccount();
  const isMobile = useIsMobile(640);
  const navigate = useNavigate();
  // The active tab is encoded in the URL (/reports/:tab) so a refresh,
  // a back-navigation, or a shared link keeps the user on the same
  // report. useState would have lost that on every reload.
  const params = useParams<{ tab?: string }>();
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

  // Resolve the active tab from the URL, gated against the visible
  // tabs. Bare /reports and any unknown or not-permitted :tab fall back
  // to Overview, with the canonical URL restored by the effect below.
  const urlTab = params.tab as Tab | undefined;
  const tab: Tab = useMemo(() => {
    if (!urlTab) return 'overview';
    if (!tabs.some((t) => t.value === urlTab)) return 'overview';
    return urlTab;
  }, [urlTab, tabs]);

  const setTab = useCallback(
    (next: Tab) => {
      navigate(`/reports/${next}`);
    },
    [navigate],
  );

  // The group row derives from the active tab rather than holding its
  // own state, so a direct link to /reports/voids opens with Money
  // already selected instead of defaulting to Operations.
  const group = groupOf(tab);

  const visibleGroups = useMemo<TabGroup[]>(
    () =>
      account?.can_view_financials
        ? ['operations', 'patients', 'money']
        : ['operations', 'patients'],
    [account],
  );

  const groupTabs = useCallback(
    (g: TabGroup): TabDef[] =>
      g === 'operations' ? OPERATIONS_TABS : g === 'patients' ? PATIENT_TABS : FINANCIAL_TABS,
    [],
  );

  const activeDef = useMemo(
    () => [...OPERATIONAL_TABS, ...FINANCIAL_TABS].find((t) => t.value === tab) ?? null,
    [tab],
  );

  // Keep the URL canonical: bare /reports, an unknown tab, or one the
  // account can't see becomes /reports/overview. replace so the
  // malformed URL doesn't stack a back-step the user didn't take.
  useEffect(() => {
    if (!account) return;
    if (!urlTab || !tabs.some((t) => t.value === urlTab)) {
      navigate('/reports/overview', { replace: true });
    }
  }, [account, urlTab, tabs, navigate]);

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
                ? 'Operations covers what happened in the clinic, Patients covers who came in, Money covers what it earned. Every report follows the date range on the right.'
                : 'Operations covers what happened in the clinic, Patients covers who came in. Money-side reports need an additional permission, granted in Admin, Staff. Every report follows the date range on the right.'}
            </p>
          </div>
          <DateRangePicker value={range} onChange={setRange} />
        </div>

        {/* Two-level navigation. The group row narrows fifteen tabs to
            at most five, so the tab strip below stops needing a
            horizontal scroll to reach the report you want. Selecting a
            group jumps to its first tab; the URL still names the tab,
            so every existing bookmark keeps working. */}
        <div style={{ marginTop: theme.space[5], marginBottom: theme.space[4] }}>
          <SegmentedControl<TabGroup>
            size="sm"
            ariaLabel="Report group"
            value={group}
            onChange={(g) => {
              const first = groupTabs(g)[0];
              if (first) setTab(first.value);
            }}
            options={visibleGroups.map((g) => ({ value: g, label: GROUP_LABEL[g] }))}
          />
        </div>

        <div style={{ marginBottom: theme.space[4] }}>
          <SegmentedControl<Tab>
            scrollable
            ariaLabel="Report"
            value={tab}
            onChange={setTab}
            options={groupTabs(group).map((t) => ({ value: t.value, label: t.label }))}
          />
        </div>

        {/* What this report measures. Sits directly above the report so
            the answer arrives before the numbers do. */}
        {activeDef && (
          <div
            style={{
              marginBottom: theme.space[5],
              padding: `${theme.space[3]}px ${theme.space[4]}px`,
              background: theme.color.surface,
              border: `1px solid ${theme.color.border}`,
              borderRadius: theme.radius.card,
            }}
          >
            <p
              style={{
                margin: 0,
                fontSize: theme.type.size.sm,
                color: theme.color.ink,
                lineHeight: theme.type.leading.normal,
              }}
            >
              {activeDef.blurb}
            </p>
            {activeDef.seeAlso && (
              <p
                style={{
                  margin: `${theme.space[2]}px 0 0`,
                  fontSize: theme.type.size.xs,
                  color: theme.color.inkMuted,
                  lineHeight: theme.type.leading.normal,
                }}
              >
                {activeDef.seeAlso}
              </p>
            )}
          </div>
        )}

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
        ) : tab === 'online_orders' ? (
          <OnlineOrdersTab range={range} />
        ) : tab === 'virtual_impressions' ? (
          <VirtualImpressionsTab range={range} />
        ) : tab === 'fin_overview' ? (
          <FinancialOverviewTab range={range} />
        ) : tab === 'sales' ? (
          <SalesTab range={range} />
        ) : tab === 'retail_sales' ? (
          <RetailSalesTab range={range} />
        ) : tab === 'cash_drawer' ? (
          <CashDrawerTab range={range} />
        ) : tab === 'discounts' ? (
          <DiscountsTab range={range} />
        ) : tab === 'voids' ? (
          <VoidsTab range={range} />
        ) : tab === 'anomalies' ? (
          <AnomaliesTab range={range} />
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
