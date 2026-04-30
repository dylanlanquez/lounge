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
import { BarChart3 } from 'lucide-react';

// Reports — operational dashboards. Visible to anyone with
// can_view_reports (default true for every Lounge staff member).
//
// Sub-pages live in their own files for readability and to keep this
// route file from growing into another 2000-line beast like Admin.
// Each tab is a self-contained component that owns its data fetch +
// filters + chart shape. The shell here just routes between them and
// applies the auth gate.

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

  if (authLoading || accountLoading) return null;
  if (!user) return <Navigate to="/sign-in" replace />;
  // Reports is the operational lens. Every active staff member with
  // can_view_reports gets in (default true). Defense-in-depth gate;
  // the top-bar entry is also hidden to non-permitted users.
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
        <h1
          style={{
            margin: 0,
            fontSize: isMobile ? theme.type.size.xl : theme.type.size.xxl,
            fontWeight: theme.type.weight.semibold,
            letterSpacing: theme.type.tracking.tight,
            marginBottom: theme.space[2],
          }}
        >
          Reports
        </h1>
        <p
          style={{
            margin: `0 0 ${theme.space[5]}px`,
            color: theme.color.inkMuted,
            fontSize: theme.type.size.sm,
            maxWidth: 640,
          }}
        >
          Live operational reports. Every signed-in staff member sees these.
          Money-side reports live in <strong>Financials</strong> — gated separately.
        </p>

        <div style={{ marginBottom: theme.space[5], overflowX: 'auto' }}>
          <SegmentedControl<Tab> value={tab} onChange={setTab} options={TABS} />
        </div>

        {/* Each tab is rendered inline here for now — every page will
            land its own component as the section grows in follow-up
            PRs. Foundation just shows the placeholder so the shape is
            visible and gates / nav can be tested end-to-end. */}
        <ComingSoon section={TABS.find((t) => t.value === tab)?.label ?? 'Section'} />
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
