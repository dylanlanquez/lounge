import { Suspense, useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth.tsx';
import {
  CurrentAccountProvider,
  useCurrentAccount,
} from './lib/queries/currentAccount.tsx';
import { useMfaStatus } from './lib/mfa.ts';
import { theme } from './theme/index.ts';
import { Button } from './components/Button/Button.tsx';
import { BottomNav } from './components/BottomNav/BottomNav.tsx';
import { KioskStatusBar } from './components/KioskStatusBar/KioskStatusBar.tsx';
import { ErrorBoundary } from './components/ErrorBoundary/ErrorBoundary.tsx';
import { lazyWithRetry } from './lib/lazyWithRetry.ts';

// Every route is loaded via lazyWithRetry rather than React.lazy
// directly so a hung or transiently-failing chunk fetch (flaky kiosk
// Wi-Fi, a brief Vercel propagation gap right after a deploy, a
// stale-bundle edge case) becomes an automatic recovery instead of
// trapping the receptionist on the Loading… fallback. See
// src/lib/lazyWithRetry.ts for the timeout + retry semantics.
const SignIn = lazyWithRetry(() => import('./routes/SignIn.tsx').then((m) => ({ default: m.SignIn })), 'SignIn');
const Welcome = lazyWithRetry(() => import('./routes/Welcome.tsx').then((m) => ({ default: m.Welcome })), 'Welcome');
const Enroll2fa = lazyWithRetry(() => import('./routes/Enroll2fa.tsx').then((m) => ({ default: m.Enroll2fa })), 'Enroll2fa');
const Verify2fa = lazyWithRetry(() => import('./routes/Verify2fa.tsx').then((m) => ({ default: m.Verify2fa })), 'Verify2fa');
const Schedule = lazyWithRetry(() => import('./routes/Schedule.tsx').then((m) => ({ default: m.Schedule })), 'Schedule');
const MyAvailability = lazyWithRetry(() => import('./routes/MyAvailability.tsx').then((m) => ({ default: m.MyAvailability })), 'MyAvailability');
const NewWalkIn = lazyWithRetry(() => import('./routes/NewWalkIn.tsx').then((m) => ({ default: m.NewWalkIn })), 'NewWalkIn');
const QuickSale = lazyWithRetry(() => import('./routes/QuickSale.tsx').then((m) => ({ default: m.QuickSale })), 'QuickSale');
const SaleDetail = lazyWithRetry(() => import('./routes/SaleDetail.tsx').then((m) => ({ default: m.SaleDetail })), 'SaleDetail');
const VisitDetail = lazyWithRetry(() => import('./routes/VisitDetail.tsx').then((m) => ({ default: m.VisitDetail })), 'VisitDetail');
const Pay = lazyWithRetry(() => import('./routes/Pay.tsx').then((m) => ({ default: m.Pay })), 'Pay');
const PatientProfile = lazyWithRetry(() => import('./routes/PatientProfile.tsx').then((m) => ({ default: m.PatientProfile })), 'PatientProfile');
const Patients = lazyWithRetry(() => import('./routes/Patients.tsx').then((m) => ({ default: m.Patients })), 'Patients');
const Ledger = lazyWithRetry(() => import('./routes/Ledger.tsx').then((m) => ({ default: m.Ledger })), 'Ledger');
const AppointmentDetail = lazyWithRetry(() => import('./routes/AppointmentDetail.tsx').then((m) => ({ default: m.AppointmentDetail })), 'AppointmentDetail');
const InClinic = lazyWithRetry(() => import('./routes/InClinic.tsx').then((m) => ({ default: m.InClinic })), 'InClinic');
const Admin = lazyWithRetry(() => import('./routes/Admin.tsx').then((m) => ({ default: m.Admin })), 'Admin');
const Reports = lazyWithRetry(() => import('./routes/Reports/Reports.tsx').then((m) => ({ default: m.Reports })), 'Reports');
const CashCounts = lazyWithRetry(() => import('./routes/CashCounts.tsx').then((m) => ({ default: m.CashCounts })), 'CashCounts');
// /widget/* on lounge.venneir.com is redirected at the Vercel
// layer to book.venneir.com (see vercel.json), so the staff
// bundle no longer needs the customer widget code at all.
const Arrival = lazyWithRetry(() => import('./routes/Arrival.tsx').then((m) => ({ default: m.Arrival })), 'Arrival');
const GoogleMeetCallback = lazyWithRetry(() => import('./routes/GoogleMeetCallback.tsx').then((m) => ({ default: m.GoogleMeetCallback })), 'GoogleMeetCallback');
const ConnectMeetHost = lazyWithRetry(() => import('./routes/ConnectMeetHost.tsx').then((m) => ({ default: m.ConnectMeetHost })), 'ConnectMeetHost');
const NotFound = lazyWithRetry(() => import('./routes/NotFound.tsx').then((m) => ({ default: m.NotFound })), 'NotFound');

function RouteFallback() {
  // Escape hatch — when the fallback has been on screen for 10s it
  // almost certainly means a chunk fetch is hung (flaky Wi-Fi, partial
  // CDN propagation right after a deploy, an iPad that's been open
  // long enough for index.html and chunks to drift apart) and the
  // staff member is stuck staring at "Loading…" with no recovery path.
  // After 10s we surface a Reload button so they can fix it themselves
  // without having to find the home button + reopen Safari. lazy
  // imports also hit their own 8s timeout in lazyWithRetry.ts; the
  // escape hatch is the final safety net if both retries also stall.
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setStalled(true), 10_000);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <div
      style={{
        minHeight: '100dvh',
        background: theme.color.bg,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.space[4],
        color: theme.color.inkMuted,
        fontSize: theme.type.size.sm,
        padding: theme.space[6],
        textAlign: 'center',
      }}
    >
      <span>Loading…</span>
      {stalled ? (
        <>
          <span style={{ color: theme.color.inkSubtle, fontSize: theme.type.size.xs, maxWidth: 320 }}>
            This is taking longer than usual. Reloading usually clears it.
          </span>
          <Button variant="primary" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </>
      ) : null}
    </div>
  );
}

export function App() {
  return (
    <AuthProvider>
      {/* CurrentAccountProvider sits inside AuthProvider (it reads
          useAuth) and outside every consumer (KioskStatusBar, all
          routes, RequireStaff, BottomNav). One fetch per session —
          every useCurrentAccount() call below reads from this shared
          context, eliminating the 40-way fetch fan-out + the
          first-paint race against permission gates that produced the
          flicker on CS-only surfaces. */}
      <CurrentAccountProvider>
        <KioskStatusBar />
        <ScrollToTop />
        <RoutedErrorBoundary />
        <BottomNav />
      </CurrentAccountProvider>
    </AuthProvider>
  );
}

// Resets the document scroll to the top whenever the URL pathname
// changes. Without this React Router preserves whatever scroll
// position the previous route was at — so navigating from the
// bottom of the patient list to a patient profile lands halfway
// down the profile, the patients pagination next-button keeps you
// at the same y-position on a fresh result set, etc.
//
// The page scroll lives on #root (body is pinned to viewport so
// the iOS rubber-band can't drag the fixed bars), so we scroll
// that element rather than window.
//
// useLayoutEffect (not useEffect) so the scroll fires before the
// browser paints the new route — no visible jump from old position
// to top.
function ScrollToTop() {
  const { pathname } = useLocation();
  useLayoutEffect(() => {
    document.getElementById('root')?.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

// Gates every route except /sign-in and /no-access on Lounge staff
// membership. The check is two-step: must be signed in, AND must have
// an active row in lng_staff_members (or be the super admin). Non-
// staff Meridian users land on /no-access — they shouldn't see the
// till at all, even briefly.
function RequireStaff({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const { account, loading: accountLoading, connectivityError, retry } = useCurrentAccount();
  const mfa = useMfaStatus();
  if (authLoading || accountLoading) return <RouteFallback />;
  if (!user) return <Navigate to="/sign-in" replace />;
  // Connectivity gate: when the account fetch failed because Supabase
  // was unreachable (Cloudflare 5xx between the iPad and the
  // Supabase origin — happens intermittently on certain edge nodes),
  // show a recovery surface with a retry instead of routing to
  // /no-access. Without this, an upstream blip would falsely tell
  // staff they're not on the staff list. The retry re-runs the
  // account fetch under the same React tree so router state and any
  // open sheets survive.
  if (!account && connectivityError) {
    return <ConnectivityErrorSurface onRetry={retry} />;
  }
  if (!account || !account.is_lng_staff) return <Navigate to="/no-access" replace />;

  // 2FA gate. If the staff row has require_2fa = true and the live
  // session is not yet AAL2, route through one of the MFA surfaces:
  //   • factor enrolled → /verify-2fa (just the challenge form)
  //   • no factor yet   → /enroll-2fa (QR + first verify)
  // Super admin is exempt (currentAccount.require_2fa is forced false
  // for the super admin to avoid a bootstrap chicken-and-egg).
  if (account.require_2fa && mfa.aal !== 'aal2') {
    if (mfa.loading) return <RouteFallback />;
    return mfa.hasVerifiedFactor
      ? <Navigate to="/verify-2fa" replace />
      : <Navigate to="/enroll-2fa" replace />;
  }
  return <>{children}</>;
}

// Surface shown when the auth_account_id / accounts lookup failed
// because Supabase was unreachable (Cloudflare 5xx, network offline,
// DNS, request abort). The previous behaviour silently routed staff
// to /no-access — which was a lie: they hadn't lost access, the
// servers were just briefly unreachable. This surface tells the
// truth, offers a retry that re-runs the fetch in place (no full
// page reload, so any open sheet / partially-typed form survives),
// and a sign-out escape hatch for the rare case where the device's
// stored session is genuinely the problem.
//
// Auto-retries every 4s in the background so transient outages
// resolve without the receptionist having to interact at all —
// they'll see the surface appear briefly and disappear when the
// next retry succeeds. The manual button is for the case where
// the user wants to act immediately.
function ConnectivityErrorSurface({ onRetry }: { onRetry: () => void }) {
  const { signOut } = useAuth();
  useEffect(() => {
    const t = window.setInterval(onRetry, 4000);
    return () => window.clearInterval(t);
  }, [onRetry]);
  return (
    <main
      role="alert"
      style={{
        minHeight: '100dvh',
        background: theme.color.bg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: theme.space[6],
      }}
    >
      <div
        style={{
          maxWidth: 480,
          width: '100%',
          background: theme.color.surface,
          border: `1px solid ${theme.color.border}`,
          borderRadius: theme.radius.card,
          padding: theme.space[6],
          boxShadow: theme.shadow.card,
          display: 'flex',
          flexDirection: 'column',
          gap: theme.space[4],
          textAlign: 'center',
        }}
      >
        <h1
          style={{
            margin: 0,
            fontSize: theme.type.size.xl,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          Can’t reach Lounge servers
        </h1>
        <p style={{ margin: 0, color: theme.color.inkMuted, fontSize: theme.type.size.sm, lineHeight: 1.5 }}>
          The connection between this device and Lounge has dropped. We’re retrying every few seconds. If it doesn’t come back, try switching to a different Wi-Fi or your phone’s hotspot.
        </p>
        <div style={{ display: 'flex', gap: theme.space[2], justifyContent: 'center', flexWrap: 'wrap' }}>
          <Button variant="primary" onClick={onRetry}>
            Try again now
          </Button>
          <Button variant="secondary" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </div>
    </main>
  );
}

function NoAccess() {
  const { signOut, user } = useAuth();
  return (
    <main
      style={{
        minHeight: '100dvh',
        background: theme.color.bg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: theme.space[6],
      }}
    >
      <div style={{ maxWidth: 480, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
        <h1 style={{ margin: 0, fontSize: theme.type.size.xxl, fontWeight: theme.type.weight.semibold }}>
          No access to Lounge
        </h1>
        <p style={{ margin: 0, color: theme.color.inkMuted, fontSize: theme.type.size.md, lineHeight: 1.5 }}>
          {user?.email
            ? `${user.email} is signed in, but isn't on the Lounge staff list.`
            : "You're signed in but not on the Lounge staff list."}
          {' '}Ask the clinic admin to add you, or sign out and try a different account.
        </p>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <Button variant="primary" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </div>
    </main>
  );
}

// Re-key the boundary on pathname so navigating to a fresh route always
// drops back to a clean tree even if the previous one was stuck on an
// error. The Suspense fallback also lives inside the boundary so a
// chunk-load failure surfaces the same "something broke" surface
// instead of a blank loading screen.
function RoutedErrorBoundary() {
  const location = useLocation();
  return (
    <ErrorBoundary key={location.pathname}>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<RequireStaff><Navigate to="/schedule" replace /></RequireStaff>} />
          <Route path="/sign-in" element={<SignIn />} />
          <Route path="/welcome" element={<Welcome />} />
          <Route path="/enroll-2fa" element={<Enroll2fa />} />
          <Route path="/verify-2fa" element={<Verify2fa />} />
          <Route path="/no-access" element={<NoAccess />} />
          <Route path="/schedule" element={<RequireStaff><Schedule /></RequireStaff>} />
          <Route path="/my-availability" element={<RequireStaff><MyAvailability /></RequireStaff>} />
          <Route path="/walk-in/new" element={<RequireStaff><NewWalkIn /></RequireStaff>} />
          <Route path="/quick-sale" element={<RequireStaff><QuickSale /></RequireStaff>} />
          <Route path="/sale/:id" element={<RequireStaff><SaleDetail /></RequireStaff>} />
          <Route path="/visit/:id" element={<RequireStaff><VisitDetail /></RequireStaff>} />
          <Route path="/visit/:id/pay" element={<RequireStaff><Pay /></RequireStaff>} />
          <Route path="/patient/:id" element={<RequireStaff><PatientProfile /></RequireStaff>} />
          <Route path="/patients" element={<RequireStaff><Patients /></RequireStaff>} />
          <Route path="/ledger" element={<RequireStaff><Ledger /></RequireStaff>} />
          <Route path="/appointment/:id" element={<RequireStaff><AppointmentDetail /></RequireStaff>} />
          {/* Old path from before the rename — keep redirecting so any deep links staff bookmarked still land somewhere sensible. */}
          <Route path="/appointments" element={<Navigate to="/ledger" replace />} />
          <Route path="/in-clinic" element={<RequireStaff><InClinic /></RequireStaff>} />
          {/* Admin tab lives at /admin/:tab so a refresh, a back-
              navigation, or a shared link keeps the operator on the
              same tab. The bare /admin URL resolves to the operator's
              first visible tab inside Admin (depends on their grants),
              and an unknown :tab segment falls back to the same
              first-visible tab via the same gate. */}
          <Route path="/admin" element={<RequireStaff><Admin /></RequireStaff>} />
          <Route path="/admin/:tab" element={<RequireStaff><Admin /></RequireStaff>} />
          <Route path="/reports" element={<RequireStaff><Reports /></RequireStaff>} />
          <Route path="/cash-counts" element={<RequireStaff><CashCounts /></RequireStaff>} />
          {/* Customer-facing widget (book + manage) lives on
              book.venneir.com — separate Vercel project, separate
              bundle, no staff code. Old /widget/* URLs on
              lounge.venneir.com redirect there at the edge. */}
          {/* /financials merged into /reports — keep the alias so old
              bookmarks and existing TopBar shortcuts still land. */}
          <Route path="/financials" element={<Navigate to="/reports" replace />} />
          <Route path="/auth/google/callback" element={<GoogleMeetCallback />} />
          {/* Public, no RequireStaff: a remote person opens this from a
              connect link an admin sent them, with no Lounge account. */}
          <Route path="/connect-meet-host" element={<ConnectMeetHost />} />
          <Route path="/arrival/appointment/:id" element={<RequireStaff><Arrival /></RequireStaff>} />
          <Route path="/arrival/walk-in/:id" element={<RequireStaff><Arrival /></RequireStaff>} />
          {/* old aliases */}
          <Route path="/today" element={<Navigate to="/schedule" replace />} />
          <Route path="/dashboard" element={<Navigate to="/schedule" replace />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
