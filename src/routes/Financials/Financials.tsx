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
import { type DateRange, defaultDateRange } from '../../lib/dateRange.ts';
import { Receipt } from 'lucide-react';
import { OverviewTab } from './OverviewTab.tsx';
import { SalesTab } from './SalesTab.tsx';
import { DiscountsTab } from './DiscountsTab.tsx';
import { VoidsTab } from './VoidsTab.tsx';
import { AnomaliesTab } from './AnomaliesTab.tsx';
import { CashReconciliationTab } from './CashReconciliationTab.tsx';

type Tab =
  | 'overview'
  | 'sales'
  | 'discounts'
  | 'voids'
  | 'anomalies'
  | 'cash_reconciliation';

const TABS: { value: Tab; label: string }[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'sales', label: 'Sales' },
  { value: 'discounts', label: 'Discounts' },
  { value: 'voids', label: 'Voids' },
  { value: 'anomalies', label: 'Anomaly flags' },
  { value: 'cash_reconciliation', label: 'Cash reconciliation' },
];

export function Financials() {
  const { user, loading: authLoading } = useAuth();
  const { account, loading: accountLoading } = useCurrentAccount();
  const isMobile = useIsMobile(640);
  const [tab, setTab] = useState<Tab>('overview');
  const [range, setRange] = useState<DateRange>(() => defaultDateRange());

  if (authLoading || accountLoading) return null;
  if (!user) return <Navigate to="/sign-in" replace />;
  if (!account || !account.can_view_financials) {
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
              Financials
            </h1>
            <p
              style={{
                margin: `${theme.space[2]}px 0 0`,
                color: theme.color.inkMuted,
                fontSize: theme.type.size.sm,
                maxWidth: 640,
              }}
            >
              Money-side reports + cash reconciliation. Defaults to the super
              admin only; granted to other staff via Admin → Staff. Cash
              reconciliation requires an additional permission flag.
            </p>
          </div>
          <DateRangePicker value={range} onChange={setRange} />
        </div>

        <div style={{ marginTop: theme.space[5], marginBottom: theme.space[5], overflowX: 'auto' }}>
          <SegmentedControl<Tab>
            value={tab}
            onChange={setTab}
            options={TABS.filter((t) =>
              t.value === 'cash_reconciliation' ? account.can_view_financials : true,
            )}
          />
        </div>

        {tab === 'overview' ? (
          <OverviewTab range={range} />
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
        icon={<Receipt size={20} />}
        title={`${section} — coming next`}
        description="The Financials section is being built page by page. Each money-side report — Sales, Discounts, Voids, Anomalies, Cash reconciliation — lands in its own dedicated PR so each one can be tested in isolation. The shell, gates, and shared filters are wired now."
      />
    </Card>
  );
}
