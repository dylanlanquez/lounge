import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import {
  Card,
  EmptyState,
  SegmentedControl,
} from '../../components/index.ts';
import { BOTTOM_NAV_HEIGHT } from '../../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../../components/KioskStatusBar/KioskStatusBar.tsx';
import { theme } from '../../theme/index.ts';
import { useAuth } from '../../lib/auth.tsx';
import { useCurrentAccount } from '../../lib/queries/currentAccount.ts';
import { useIsMobile } from '../../lib/useIsMobile.ts';
import { Receipt } from 'lucide-react';

// Financials — the money-side surface. Visible only to staff with
// can_view_financials (default false; super admin can grant via the
// Staff editor). Cash reconciliation is gated additionally by
// can_count_cash because performing a count is a higher-trust action
// than viewing past counts.
//
// Same shape as Reports: a route shell with a SegmentedControl
// switching between sub-pages. Each sub-page lands as its own file
// across the follow-up PRs so this module stays readable.

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

  if (authLoading || accountLoading) return null;
  if (!user) return <Navigate to="/sign-in" replace />;
  // Financials gate. The super admin always passes; everyone else
  // needs can_view_financials = true on their lng_staff_members row.
  // Belt-and-braces: the top-bar entry is also hidden when this gate
  // would fail, so non-permitted staff don't see the door.
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
        <h1
          style={{
            margin: 0,
            fontSize: isMobile ? theme.type.size.xl : theme.type.size.xxl,
            fontWeight: theme.type.weight.semibold,
            letterSpacing: theme.type.tracking.tight,
            marginBottom: theme.space[2],
          }}
        >
          Financials
        </h1>
        <p
          style={{
            margin: `0 0 ${theme.space[5]}px`,
            color: theme.color.inkMuted,
            fontSize: theme.type.size.sm,
            maxWidth: 640,
          }}
        >
          Money-side reports + cash reconciliation. Defaults to the super
          admin only; granted to other staff via Admin → Staff. Cash
          reconciliation requires an additional permission flag.
        </p>

        <div style={{ marginBottom: theme.space[5], overflowX: 'auto' }}>
          <SegmentedControl<Tab>
            value={tab}
            onChange={setTab}
            options={TABS.filter((t) =>
              t.value === 'cash_reconciliation' ? account.can_view_financials : true,
            )}
          />
        </div>

        <ComingSoon
          section={TABS.find((t) => t.value === tab)?.label ?? 'Section'}
        />
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
