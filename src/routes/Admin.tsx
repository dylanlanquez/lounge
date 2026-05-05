import { useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { AlertTriangle, ArrowDown, ArrowUp, BarChart3, CalendarCheck, Check, CreditCard, FileSignature, FlaskConical, Mail, Package, Pencil, Plus, RefreshCw, RotateCcw, ShieldAlert, Trash2, Users, X } from 'lucide-react';
import {
  Button,
  Card,
  Checkbox,
  DropdownSelect,
  EmptyState,
  Input,
  SegmentedControl,
  Skeleton,
  StatCard,
  StatusPill,
  Toast,
} from '../components/index.ts';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../components/KioskStatusBar/KioskStatusBar.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useIsMobile } from '../lib/useIsMobile.ts';
import {
  importReadersFromStripe,
  listLoungeLocations,
  listStripeLocations,
  registerReader,
  useTerminalReaders,
  type LoungeLocation,
  type StripeTerminalLocation,
} from '../lib/queries/terminalReaders.ts';
import {
  addStaffMemberByEmail,
  deactivateStaffMember,
  reactivateStaffMember,
  setCanCountCash,
  setCanViewFinancials,
  setCanViewReports,
  setIsAdmin,
  setIsManager,
  setStaffName,
  useStaff,
  type StaffRow,
} from '../lib/queries/staff.ts';
import {
  reconcileTerminalPayment,
  useCardPaymentHealth,
  useStripePaymentsLog,
  type StripePaymentRow,
} from '../lib/queries/terminalPayments.ts';
import { BottomSheet } from '../components/index.ts';
import {
  useReceptionistSessions,
  useUnresolvedFailures,
  usePaymentTotals,
  usePendingReceipts,
  retrySendReceipt,
  useDirtyAppointments,
  resetTestAppointment,
  type SystemFailureRow,
} from '../lib/queries/admin.ts';
import { humaniseStatus } from '../lib/queries/appointments.ts';
import {
  useCalendlyDiagnostic,
  runCalendlyBackfill,
  verifyCalendlyWebhook,
  type VerifyResult,
} from '../lib/queries/calendlyDiagnostic.ts';
import { formatPence, formatPounds } from '../lib/queries/carts.ts';
import {
  type CatalogueRow,
  deleteCatalogueImage,
  setCatalogueActive,
  uploadCatalogueImage,
  upsertCatalogueRow,
  useCatalogueAll,
  type ArchMatch,
} from '../lib/queries/catalogue.ts';
import {
  setCatalogueWaiverRequirements,
  suggestNextVersion,
  upsertWaiverSection,
  useAdminWaiverSections,
  useCatalogueWaiverRequirements,
  useWaiverSections,
  type WaiverSection,
  type WaiverSectionDraft,
} from '../lib/queries/waiver.ts';
import {
  deleteUpgrade,
  setUpgradeActive,
  upsertUpgrade,
  useUpgradesForCatalogue,
  type UpgradeDisplayPosition,
  type UpgradeRow,
} from '../lib/queries/upgrades.ts';
import { supabase } from '../lib/supabase.ts';
import { useCurrentAccount } from '../lib/queries/currentAccount.ts';
import { AdminBookingTypesTab } from './AdminBookingTypesTab.tsx';
import { AdminConflictsTab } from './AdminConflictsTab.tsx';
import { AdminEmailTemplatesTab } from './AdminEmailTemplatesTab.tsx';
import { AdminBrandingTab } from './AdminBrandingTab.tsx';
import { AdminWidgetTab } from './AdminWidgetTab.tsx';

type Tab = 'devices' | 'failures' | 'reports' | 'calendly' | 'services' | 'products' | 'booking_types' | 'conflicts' | 'emails' | 'branding' | 'widget' | 'receipts' | 'testing' | 'waivers' | 'staff' | 'payments';

export function Admin() {
  const { user, loading: authLoading } = useAuth();
  const { account, loading: accountLoading } = useCurrentAccount();
  const isMobile = useIsMobile(640);
  const [tab, setTab] = useState<Tab>('calendly');

  if (authLoading || accountLoading) return null;
  if (!user) return <Navigate to="/sign-in" replace />;
  // Admin gate: account_types must contain 'admin', or be the super
  // admin email. Anything else falls through to the home redirect —
  // non-admin staff can use everything else in Lounge but Admin (and
  // therefore Staff config, Waivers, Stripe payment log etc.) is
  // off-limits.
  if (!account || (!account.is_admin && !account.is_super_admin)) {
    return <Navigate to="/" replace />;
  }

  return (
    <main
      style={{
        minHeight: '100dvh',
        background: theme.color.bg,
        padding: isMobile ? theme.space[4] : theme.space[6],
        paddingTop: `calc(${KIOSK_STATUS_BAR_HEIGHT}px + ${isMobile ? theme.space[4] : theme.space[6]}px + env(safe-area-inset-top, 0px))`,
        paddingBottom: `calc(${BOTTOM_NAV_HEIGHT}px + ${isMobile ? theme.space[6] : theme.space[8]}px + env(safe-area-inset-bottom, 0px))`,
      }}
    >
      <div style={{ maxWidth: theme.layout.pageMaxWidth, margin: '0 auto' }}>
        <h1
          style={{
            margin: 0,
            fontSize: isMobile ? theme.type.size.xl : theme.type.size.xxl,
            fontWeight: theme.type.weight.semibold,
            letterSpacing: theme.type.tracking.tight,
            marginBottom: theme.space[5],
          }}
        >
          Admin
        </h1>

        <div style={{ marginBottom: theme.space[5] }}>
          <SegmentedControl<Tab>
            scrollable
            value={tab}
            onChange={setTab}
            options={[
              { value: 'calendly', label: 'Calendly' },
              { value: 'services', label: 'Services' },
              { value: 'products', label: 'Products' },
              { value: 'booking_types', label: 'Booking types' },
              { value: 'conflicts', label: 'Resources' },
              { value: 'emails', label: 'Emails' },
              { value: 'branding', label: 'Branding' },
              { value: 'widget', label: 'Widget' },
              { value: 'waivers', label: 'Waivers' },
              { value: 'receipts', label: 'Receipts' },
              { value: 'reports', label: 'Reports' },
              { value: 'devices', label: 'Devices' },
              { value: 'payments', label: 'Payments' },
              { value: 'staff', label: 'Staff' },
              { value: 'failures', label: 'Failures' },
              { value: 'testing', label: 'Testing' },
            ]}
          />
        </div>

        {tab === 'calendly' ? (
          <CalendlyTab />
        ) : tab === 'services' ? (
          <CatalogueTab key="services" mode="services" />
        ) : tab === 'products' ? (
          <CatalogueTab key="products" mode="products" />
        ) : tab === 'booking_types' ? (
          <AdminBookingTypesTab />
        ) : tab === 'conflicts' ? (
          <AdminConflictsTab />
        ) : tab === 'emails' ? (
          <AdminEmailTemplatesTab />
        ) : tab === 'branding' ? (
          <AdminBrandingTab />
        ) : tab === 'widget' ? (
          <AdminWidgetTab />
        ) : tab === 'waivers' ? (
          <WaiversTab />
        ) : tab === 'receipts' ? (
          <ReceiptsTab />
        ) : tab === 'reports' ? (
          <ReportsTab />
        ) : tab === 'devices' ? (
          <DevicesTab />
        ) : tab === 'payments' ? (
          <PaymentsTab />
        ) : tab === 'staff' ? (
          <StaffTab />
        ) : tab === 'testing' ? (
          <TestingTab />
        ) : (
          <FailuresTab />
        )}
      </div>
    </main>
  );
}

function CalendlyTab() {
  const d = useCalendlyDiagnostic();
  const [busy, setBusy] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [toast, setToast] = useState<{ tone: 'success' | 'error' | 'info'; title: string; description?: string } | null>(null);

  const onBackfill = async () => {
    setBusy(true);
    setToast(null);
    const res = await runCalendlyBackfill();
    setBusy(false);
    if (!res.ok) {
      setToast({ tone: 'error', title: 'Backfill failed', description: res.error });
      return;
    }
    const skippedNote = res.skipped && res.skipped > 0 ? ` · ${res.skipped} already imported` : '';
    const pages = res.pages ?? [];
    const pageNote = pages.length > 0
      ? ` · ${pages.length} page(s), latest event ${pages[0]?.first ? new Date(pages[0].first).toLocaleDateString('en-GB') : '—'}`
      : '';
    setToast({
      tone: 'success',
      title: `Pulled ${res.received ?? 0} events, applied ${res.applied ?? 0}${skippedNote}.`,
      description: `${pageNote}${
        (res.errors?.length ?? 0) > 0
          ? `. ${res.errors!.length} error(s).`
          : '.'
      } Reload Schedule to see new appointments.`,
    });
    d.refresh();
  };

  const onVerify = async () => {
    setVerifying(true);
    setToast(null);
    const res = await verifyCalendlyWebhook();
    setVerifying(false);
    setVerify(res);
    if (!res.ok) {
      setToast({ tone: 'error', title: 'Verify failed', description: res.error });
      return;
    }
    if ((res.activeMatching ?? 0) > 0) {
      setToast({ tone: 'success', title: 'Webhook subscription is active.' });
    } else if ((res.subscriptionsMatching ?? 0) > 0) {
      setToast({ tone: 'error', title: 'Webhook subscription exists but is not active.', description: 'Re-run scripts/calendly-setup.sh to recreate.' });
    } else {
      setToast({
        tone: 'error',
        title: 'No webhook subscription pointing at this project.',
        description: 'Run scripts/calendly-setup.sh to register one.',
      });
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <Card padding="lg">
        <h2 style={{ margin: 0, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold }}>
          Calendly status
        </h2>
        <p style={{ margin: `${theme.space[2]}px 0 ${theme.space[5]}px`, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
          Webhook handler is live at <code>…/functions/v1/calendly-webhook</code>. New bookings auto-import. Existing bookings need a one-time backfill.
        </p>

        {d.loading ? (
          <Skeleton height={120} />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: theme.space[3] }}>
            <StatCard label="Webhook deliveries" value={String(d.deliveriesTotal)} />
            <StatCard label="Processed" value={String(d.deliveriesProcessed)} />
            <StatCard label="Failed" value={String(d.deliveriesFailed)} tone={d.deliveriesFailed > 0 ? 'alert' : 'normal'} />
            <StatCard label="Calendly appts" value={String(d.lngAppointmentsCalendly)} />
            <StatCard label="Errors (24h)" value={String(d.recentFailures)} tone={d.recentFailures > 0 ? 'alert' : 'normal'} />
            <StatCard
              label="Last delivery"
              value={d.lastDelivery ? new Date(d.lastDelivery).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}
            />
          </div>
        )}

        <div style={{ marginTop: theme.space[5], display: 'flex', gap: theme.space[3], flexWrap: 'wrap' }}>
          <Button variant="primary" loading={busy} onClick={onBackfill}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
              <CalendarCheck size={16} /> Backfill from Calendly API
            </span>
          </Button>
          <Button variant="secondary" loading={verifying} onClick={onVerify}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
              <ShieldAlert size={16} /> Verify webhook subscription
            </span>
          </Button>
          <Button variant="tertiary" onClick={() => d.refresh()}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
              <RefreshCw size={16} /> Refresh
            </span>
          </Button>
        </div>

        {verify && verify.ok ? (
          <div
            style={{
              marginTop: theme.space[5],
              padding: theme.space[4],
              background: theme.color.bg,
              borderRadius: theme.radius.card,
              fontSize: theme.type.size.sm,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], marginBottom: theme.space[3] }}>
              {(verify.activeMatching ?? 0) > 0 ? (
                <StatusPill tone="arrived" size="sm">
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
                    <Check size={12} /> Active
                  </span>
                </StatusPill>
              ) : (
                <StatusPill tone="no_show" size="sm">Not active</StatusPill>
              )}
              <span style={{ color: theme.color.inkMuted }}>
                {verify.activeMatching ?? 0} of {verify.subscriptionsMatching ?? 0} matching subscription(s) active · {verify.subscriptionsTotal ?? 0} total in Calendly
              </span>
            </div>
            <div style={{ color: theme.color.inkSubtle, fontSize: theme.type.size.xs, marginBottom: theme.space[2] }}>
              Expected URL: <code>{verify.expectedUrl}</code>
            </div>
            {(verify.subscriptions ?? []).map((s) => (
              <div
                key={s.uri}
                style={{
                  marginTop: theme.space[2],
                  padding: theme.space[3],
                  background: theme.color.surface,
                  borderRadius: 8,
                  border: `1px solid ${s.matchesProject ? theme.color.accent : theme.color.border}`,
                  fontSize: theme.type.size.xs,
                  fontFamily: 'ui-monospace, monospace',
                  color: theme.color.inkMuted,
                  wordBreak: 'break-all',
                }}
              >
                <div style={{ color: theme.color.ink, marginBottom: theme.space[1] }}>
                  {s.callback_url}
                </div>
                <div>
                  state: {s.state} · events: {(s.events ?? []).join(', ')}
                  {s.created_at ? ` · created ${new Date(s.created_at).toLocaleDateString('en-GB')}` : ''}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        <p style={{ marginTop: theme.space[4], fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>
          Backfill pulls active scheduled_events from past 30 days through next 60 days, identity-resolves invitees against Meridian patients (fill-blanks merge for existing), and inserts appointments. Idempotent on Calendly invitee URI — safe to re-run.
        </p>
      </Card>

      <Card padding="lg">
        <h2 style={{ margin: 0, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold }}>
          If nothing is showing
        </h2>
        <ol style={{ margin: `${theme.space[3]}px 0 0 ${theme.space[5]}px`, padding: 0, color: theme.color.inkMuted, fontSize: theme.type.size.sm, lineHeight: theme.type.leading.relaxed }}>
          <li>Click <strong>Backfill from Calendly API</strong> above. Imports your existing bookings.</li>
          <li>Make a fresh Calendly booking. Webhook should fire within seconds.</li>
          <li>Check <strong>Failures</strong> tab for any calendly-webhook entries.</li>
          <li>If the webhook deliveries count is 0 after a fresh booking, the webhook subscription may be inactive. Re-run <code>scripts/calendly-setup.sh</code>.</li>
        </ol>
      </Card>

      {toast ? (
        <div style={{ position: 'fixed', bottom: theme.space[6], left: '50%', transform: 'translateX(-50%)', zIndex: 100 }}>
          <Toast tone={toast.tone === 'info' ? 'info' : toast.tone === 'error' ? 'error' : 'success'} title={toast.title} description={toast.description} duration={6000} onDismiss={() => setToast(null)} />
        </div>
      ) : null}
    </div>
  );
}

function ReportsTab() {
  const { data, loading } = usePaymentTotals(7);
  const totalAll = data.reduce((s, d) => s + d.payments_total_pence, 0);
  const totalCash = data.reduce((s, d) => s + d.cash_pence, 0);
  const totalCard = data.reduce((s, d) => s + d.card_pence, 0);
  const totalKlarna = data.reduce((s, d) => s + d.klarna_pence, 0);
  const totalClearpay = data.reduce((s, d) => s + d.clearpay_pence, 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: theme.space[3] }}>
        <Tile icon={<BarChart3 size={18} />} label="Last 7 days" value={formatPence(totalAll)} />
        <Tile icon={<CreditCard size={18} />} label="Card" value={formatPence(totalCard)} />
        <Tile label="Cash" value={formatPence(totalCash)} />
        <Tile label="Klarna" value={formatPence(totalKlarna)} />
        <Tile label="Clearpay" value={formatPence(totalClearpay)} />
      </div>

      <Card padding="lg">
        <h2 style={{ margin: 0, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold }}>
          Daily breakdown
        </h2>
        <p style={{ margin: `${theme.space[2]}px 0 ${theme.space[5]}px`, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
          Last 7 days. End-of-day reconciliation (slice 20) will compare these to Stripe Dashboard totals automatically.
        </p>
        {loading ? (
          <Skeleton height={80} />
        ) : data.length === 0 ? (
          <EmptyState title="No payments yet" description="Run a sale to populate this view." />
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
            {data.map((d) => (
              <li
                key={d.date}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: theme.space[3],
                  padding: theme.space[3],
                  background: theme.color.surface,
                  border: `1px solid ${theme.color.border}`,
                  borderRadius: 12,
                }}
              >
                <span style={{ width: 110, fontSize: theme.type.size.sm, color: theme.color.ink }}>{d.date}</span>
                <span style={{ flex: 1, fontSize: theme.type.size.xs, color: theme.color.inkMuted, display: 'flex', gap: theme.space[2], flexWrap: 'wrap' }}>
                  {d.cash_pence > 0 ? <span>cash {formatPence(d.cash_pence)}</span> : null}
                  {d.card_pence > 0 ? <span>card {formatPence(d.card_pence)}</span> : null}
                  {d.klarna_pence > 0 ? <span>klarna {formatPence(d.klarna_pence)}</span> : null}
                  {d.clearpay_pence > 0 ? <span>clearpay {formatPence(d.clearpay_pence)}</span> : null}
                </span>
                <strong style={{ fontVariantNumeric: 'tabular-nums', fontSize: theme.type.size.base }}>
                  {formatPence(d.payments_total_pence)}
                </strong>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function ReceiptsTab() {
  const r = usePendingReceipts();
  const [retrying, setRetrying] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; title: string; description?: string } | null>(null);

  const onRetry = async (receiptId: string) => {
    setRetrying(receiptId);
    setToast(null);
    const res = await retrySendReceipt(receiptId);
    setRetrying(null);
    if (!res.ok) {
      setToast({ tone: 'error', title: 'Retry failed', description: res.error });
      return;
    }
    setToast({ tone: 'success', title: 'Receipt re-delivered.' });
    r.refresh();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <Card padding="lg">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: theme.space[3] }}>
          <div>
            <h2 style={{ margin: 0, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold }}>
              Pending receipts
            </h2>
            <p style={{ margin: `${theme.space[2]}px 0 0`, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
              Receipts that haven't been delivered yet, or where Resend / Twilio reported a failure. Tap Retry to re-attempt.
            </p>
          </div>
          <Button variant="tertiary" size="sm" onClick={r.refresh}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
              <RefreshCw size={14} /> Refresh
            </span>
          </Button>
        </div>

        <div style={{ marginTop: theme.space[4] }}>
          {r.loading ? (
            <Skeleton height={64} />
          ) : r.data.length === 0 ? (
            <EmptyState
              icon={<Mail size={20} />}
              title="No pending receipts"
              description="Every receipt has been delivered. If a customer reports they didn't receive one, ask them to check spam first."
            />
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
              {r.data.map((row) => (
                <li
                  key={row.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: theme.space[3],
                    padding: theme.space[3],
                    background: theme.color.surface,
                    border: `1px solid ${theme.color.border}`,
                    borderRadius: 12,
                    flexWrap: 'wrap',
                  }}
                >
                  <StatusPill tone={row.failure_reason ? 'no_show' : 'in_progress'} size="sm">
                    {row.failure_reason ? 'Failed' : 'Queued'}
                  </StatusPill>
                  <span style={{ fontSize: theme.type.size.sm, color: theme.color.ink }}>
                    {row.channel.toUpperCase()}
                  </span>
                  <span style={{ flex: 1, minWidth: 200, fontSize: theme.type.size.sm, color: theme.color.inkMuted, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {row.recipient ?? '—'}
                    {row.failure_reason ? (
                      <span style={{ display: 'block', fontSize: theme.type.size.xs, color: theme.color.inkSubtle, marginTop: 2 }}>
                        {row.failure_reason}
                      </span>
                    ) : null}
                  </span>
                  <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>
                    {new Date(row.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <Button variant="secondary" size="sm" loading={retrying === row.id} onClick={() => onRetry(row.id)}>
                    Retry
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      {toast ? (
        <div style={{ position: 'fixed', bottom: theme.space[6], left: '50%', transform: 'translateX(-50%)', zIndex: 100 }}>
          <Toast tone={toast.tone} title={toast.title} description={toast.description} duration={5000} onDismiss={() => setToast(null)} />
        </div>
      ) : null}
    </div>
  );
}

function TestingTab() {
  const dirty = useDirtyAppointments();
  const [resetting, setResetting] = useState<string | null>(null);
  const [resettingAll, setResettingAll] = useState(false);
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; title: string; description?: string } | null>(null);

  const onReset = async (id: string, label: string) => {
    if (!confirm(`Reset ${label}? This deletes any visit/cart/payments created and flips the appointment back to booked.`)) return;
    setResetting(id);
    try {
      await resetTestAppointment(id);
      setToast({ tone: 'success', title: `Reset · ${label}` });
      dirty.refresh();
    } catch (e) {
      setToast({ tone: 'error', title: 'Reset failed', description: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setResetting(null);
    }
  };

  const onResetAll = async () => {
    if (dirty.data.length === 0) return;
    if (!confirm(`Reset all ${dirty.data.length} dirty appointment(s)? Deletes any visit/cart/payments created during testing and flips each back to booked.`)) return;
    setResettingAll(true);
    let ok = 0;
    let fail = 0;
    for (const r of dirty.data) {
      try {
        await resetTestAppointment(r.id);
        ok++;
      } catch {
        fail++;
      }
    }
    setResettingAll(false);
    setToast({
      tone: fail === 0 ? 'success' : 'error',
      title: `Reset ${ok} appointment(s)`,
      description: fail > 0 ? `${fail} failed.` : undefined,
    });
    dirty.refresh();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <Card padding="lg">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: theme.space[3] }}>
          <div>
            <h2 style={{ margin: 0, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
                <FlaskConical size={20} /> Testing
              </span>
            </h2>
            <p style={{ margin: `${theme.space[2]}px 0 0`, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
              Calendly appointments not in their default booked state. Lists anything you've flipped to arrived, in_progress, no_show, or complete while testing — past 14 days through next 60. Reset removes any visit, cart, payments, and receipts created, and flips status back to booked. Patient_events stay (audit history).
            </p>
          </div>
          {dirty.data.length > 0 ? (
            <Button variant="secondary" loading={resettingAll} onClick={onResetAll}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
                <RotateCcw size={14} /> Reset all ({dirty.data.length})
              </span>
            </Button>
          ) : null}
        </div>

        <div style={{ marginTop: theme.space[5] }}>
          {dirty.loading ? (
            <Skeleton height={64} />
          ) : dirty.data.length === 0 ? (
            <EmptyState
              icon={<Check size={20} />}
              title="No dirty appointments"
              description="Every Calendly appointment is in its default booked state. Nothing to reset."
            />
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
              {dirty.data.map((row) => {
                const name = `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim() || 'Patient';
                const when = new Date(row.start_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
                return (
                  <li
                    key={row.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: theme.space[3],
                      padding: theme.space[3],
                      background: theme.color.surface,
                      border: `1px solid ${theme.color.border}`,
                      borderRadius: 12,
                      flexWrap: 'wrap',
                    }}
                  >
                    <StatusPill tone={row.status === 'arrived' ? 'arrived' : row.status === 'no_show' ? 'no_show' : 'neutral'} size="sm">
                      {humaniseStatus(row.status as 'booked' | 'arrived' | 'in_progress' | 'complete' | 'no_show' | 'cancelled' | 'rescheduled')}
                    </StatusPill>
                    <span style={{ fontSize: theme.type.size.sm, color: theme.color.ink, fontWeight: theme.type.weight.semibold }}>
                      {name}
                    </span>
                    <span style={{ flex: 1, minWidth: 200, fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
                      {row.event_type_label ?? '—'} · {when}
                    </span>
                    <Button
                      variant="tertiary"
                      size="sm"
                      loading={resetting === row.id}
                      onClick={() => onReset(row.id, name)}
                    >
                      Reset
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Card>

      {toast ? (
        <div style={{ position: 'fixed', bottom: theme.space[6], left: '50%', transform: 'translateX(-50%)', zIndex: 100 }}>
          <Toast tone={toast.tone} title={toast.title} description={toast.description} duration={5000} onDismiss={() => setToast(null)} />
        </div>
      ) : null}
    </div>
  );
}

function DevicesTab() {
  const readers = useTerminalReaders();
  const sessions = useReceptionistSessions();

  // Register-reader sheet state. The form fetches Stripe locations
  // + Lounge locations on open so dropdowns are populated by the
  // time the receptionist starts typing the registration code.
  const [registerOpen, setRegisterOpen] = useState(false);
  const [regBusy, setRegBusy] = useState(false);
  const [regError, setRegError] = useState<string | null>(null);
  const [regCode, setRegCode] = useState('');
  const [regLabel, setRegLabel] = useState('');
  const [regStripeLocId, setRegStripeLocId] = useState<string>('');
  const [regLoungeLocId, setRegLoungeLocId] = useState<string>('');
  const [stripeLocs, setStripeLocs] = useState<StripeTerminalLocation[]>([]);
  const [loungeLocs, setLoungeLocs] = useState<LoungeLocation[]>([]);
  const [locsLoading, setLocsLoading] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; title: string; description?: string } | null>(null);

  const importFromStripe = async () => {
    setImportBusy(true);
    try {
      // Need a Lounge clinic to attach the imported readers to.
      // Grab the first if not already loaded.
      let lounge = loungeLocs;
      if (lounge.length === 0) {
        lounge = await listLoungeLocations();
        setLoungeLocs(lounge);
      }
      if (lounge.length === 0) {
        setToast({ tone: 'error', title: 'No Lounge locations', description: 'Configure a clinic first.' });
        return;
      }
      const result = await importReadersFromStripe(lounge[0]!.id);
      readers.refresh();
      if (result.imported.length === 0) {
        setToast({
          tone: 'success',
          title: result.already_present > 0 ? 'Already up to date.' : 'No readers in Stripe.',
          description:
            result.already_present > 0
              ? `${result.already_present} reader${result.already_present === 1 ? '' : 's'} already registered.`
              : 'Pair a reader in Stripe Dashboard or via Register reader.',
        });
      } else {
        setToast({
          tone: 'success',
          title: `Imported ${result.imported.length} reader${result.imported.length === 1 ? '' : 's'}.`,
          description: result.imported.map((r) => r.friendly_name).join(', '),
        });
      }
    } catch (e) {
      setToast({
        tone: 'error',
        title: 'Import failed',
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setImportBusy(false);
    }
  };

  const openRegister = async () => {
    setRegError(null);
    setRegCode('');
    setRegLabel('');
    setRegStripeLocId('');
    setRegLoungeLocId('');
    setRegisterOpen(true);
    setLocsLoading(true);
    try {
      // Fetch both lists in parallel so the dropdowns are ready
      // when the receptionist looks down to pick.
      const [s, l] = await Promise.all([listStripeLocations(), listLoungeLocations()]);
      setStripeLocs(s);
      setLoungeLocs(l);
      // Pre-pick a single-option list so the common single-clinic
      // single-Stripe-location case doesn't need extra clicks.
      if (s.length === 1) setRegStripeLocId(s[0]!.id);
      if (l.length === 1) setRegLoungeLocId(l[0]!.id);
    } catch (e) {
      setRegError(e instanceof Error ? e.message : 'Could not load locations');
    } finally {
      setLocsLoading(false);
    }
  };

  const submitRegister = async () => {
    if (!regCode.trim()) {
      setRegError('Enter the 3-word code shown on the reader.');
      return;
    }
    if (!regLabel.trim()) {
      setRegError('Give the reader a friendly name (e.g. "Front desk S700").');
      return;
    }
    if (!regStripeLocId) {
      setRegError('Pick a Stripe Terminal Location.');
      return;
    }
    if (!regLoungeLocId) {
      setRegError('Pick a Lounge clinic location.');
      return;
    }
    setRegBusy(true);
    setRegError(null);
    try {
      await registerReader({
        registration_code: regCode.trim(),
        friendly_name: regLabel.trim(),
        stripe_location_id: regStripeLocId,
        location_id: regLoungeLocId,
      });
      setRegisterOpen(false);
      setToast({ tone: 'success', title: 'Reader paired.', description: `${regLabel.trim()} is registered.` });
      readers.refresh();
    } catch (e) {
      setRegError(e instanceof Error ? e.message : 'Pairing failed');
    } finally {
      setRegBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <Card padding="lg">
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: theme.space[3],
            marginBottom: theme.space[4],
            flexWrap: 'wrap',
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold }}>
              Card readers
            </h2>
            <p style={{ margin: `${theme.space[1]}px 0 0`, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
              Stripe Terminal readers visible to your location. Pair an S700 by entering its on-screen code below.
            </p>
          </div>
          <div style={{ display: 'flex', gap: theme.space[2], flexWrap: 'wrap' }}>
            <Button variant="tertiary" size="sm" onClick={importFromStripe} loading={importBusy}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
                <RefreshCw size={16} /> Import from Stripe
              </span>
            </Button>
            <Button variant="secondary" size="sm" onClick={() => openRegister()}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
                <Plus size={16} /> Register reader
              </span>
            </Button>
          </div>
        </div>
        {readers.loading ? (
          <Skeleton height={64} />
        ) : readers.data.length === 0 ? (
          <EmptyState
            icon={<CreditCard size={20} />}
            title="No readers yet"
            description="Click Register reader, enter the 3-word code shown on the S700's screen, pick a location, save."
          />
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
            {readers.data.map((r) => (
              <li
                key={r.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: theme.space[3],
                  padding: theme.space[3],
                  background: theme.color.surface,
                  border: `1px solid ${theme.color.border}`,
                  borderRadius: 12,
                }}
              >
                <CreditCard size={20} style={{ color: theme.color.inkMuted }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: 0, fontSize: theme.type.size.base, fontWeight: theme.type.weight.semibold }}>
                    {r.friendly_name}
                  </p>
                  <p style={{ margin: `${theme.space[1]}px 0 0`, color: theme.color.inkMuted, fontSize: theme.type.size.xs }}>
                    {r.stripe_reader_id}
                  </p>
                </div>
                <StatusPill tone={r.status === 'online' ? 'arrived' : r.status === 'offline' ? 'no_show' : 'neutral'} size="sm">
                  {r.status}
                </StatusPill>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card padding="lg">
        <h2 style={{ margin: 0, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold }}>
          Active sessions
        </h2>
        <p style={{ margin: `${theme.space[2]}px 0 ${theme.space[5]}px`, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
          Receptionist tablet sessions. Revoke a session to log out a lost or stolen tablet immediately.
        </p>
        {sessions.loading ? (
          <Skeleton height={64} />
        ) : sessions.data.length === 0 ? (
          <EmptyState icon={<Users size={20} />} title="No sessions" description="Sessions appear when a receptionist signs in (slice 1 v2 wires this)." />
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
            {sessions.data.map((s) => (
              <li
                key={s.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: theme.space[3],
                  padding: theme.space[3],
                  background: theme.color.surface,
                  border: `1px solid ${theme.color.border}`,
                  borderRadius: 12,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: 0, fontSize: theme.type.size.sm, fontWeight: theme.type.weight.semibold }}>
                    {s.device_label ?? s.device_id.slice(0, 8)}
                  </p>
                  <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
                    Signed in {new Date(s.signed_in_at).toLocaleString('en-GB')}
                  </p>
                </div>
                <StatusPill
                  tone={s.revoked_at ? 'no_show' : s.ended_at ? 'complete' : s.locked_at ? 'in_progress' : 'arrived'}
                  size="sm"
                >
                  {s.revoked_at ? 'Revoked' : s.ended_at ? 'Ended' : s.locked_at ? 'Locked' : 'Active'}
                </StatusPill>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Register reader sheet. Pairs an S700 (or simulated WisePOS
          E) by sending its 3-word screen code to Stripe via the
          terminal-register-reader edge function. Stripe locations
          come from the Dashboard; Lounge locations are the local
          clinic sites. */}
      <BottomSheet
        open={registerOpen}
        onClose={() => !regBusy && setRegisterOpen(false)}
        dismissable={!regBusy}
        title="Register card reader"
        description="On the S700, go to Settings → Show registration code. Enter the 3 words below."
        footer={
          <div
            style={{
              display: 'flex',
              gap: theme.space[3],
              justifyContent: 'flex-end',
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <Button variant="secondary" onClick={() => setRegisterOpen(false)} disabled={regBusy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submitRegister} loading={regBusy}>
              Pair reader
            </Button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
          <Input
            label="Registration code"
            value={regCode}
            onChange={(e) => setRegCode(e.target.value)}
            placeholder="apple-grape-orange"
            autoFocus
          />
          <Input
            label="Friendly name"
            value={regLabel}
            onChange={(e) => setRegLabel(e.target.value)}
            placeholder="Front desk S700"
          />
          {locsLoading ? (
            <Skeleton height={56} radius={12} />
          ) : (
            <>
              <DropdownSelect<string>
                label="Stripe Terminal Location"
                required
                value={regStripeLocId}
                options={stripeLocs.map((l) => ({
                  value: l.id,
                  label: l.address ? `${l.display_name} · ${l.address}` : l.display_name,
                }))}
                onChange={(v) => setRegStripeLocId(v)}
                placeholder={stripeLocs.length === 0 ? 'Configure a Location in Stripe Dashboard first' : 'Pick a location'}
                disabled={stripeLocs.length === 0}
              />
              <DropdownSelect<string>
                label="Lounge clinic location"
                required
                value={regLoungeLocId}
                options={loungeLocs.map((l) => ({
                  value: l.id,
                  label: l.name ?? '(unnamed)',
                }))}
                onChange={(v) => setRegLoungeLocId(v)}
                placeholder="Pick a clinic"
                disabled={loungeLocs.length === 0}
              />
            </>
          )}
          {regError ? (
            <p
              role="alert"
              style={{
                margin: 0,
                color: theme.color.alert,
                fontSize: theme.type.size.sm,
                fontWeight: theme.type.weight.medium,
              }}
            >
              {regError}
            </p>
          ) : null}
        </div>
      </BottomSheet>

      {toast ? (
        <div style={{ position: 'fixed', bottom: theme.space[6], left: '50%', transform: 'translateX(-50%)', zIndex: 100 }}>
          <Toast tone={toast.tone} title={toast.title} description={toast.description} duration={4000} onDismiss={() => setToast(null)} />
        </div>
      ) : null}
    </div>
  );
}

function PaymentsTab() {
  const log = useStripePaymentsLog(50);
  const health = useCardPaymentHealth();
  const [reconcilingId, setReconcilingId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: 'success' | 'error' | 'info'; title: string; description?: string } | null>(null);

  const driftCount = log.rows.filter((r) => r.drift || r.orphan).length;

  const onReconcile = async (paymentId: string) => {
    setReconcilingId(paymentId);
    setToast(null);
    try {
      const result = await reconcileTerminalPayment(paymentId);
      setToast({
        tone: 'success',
        title: 'Reconciled',
        description: `Stripe says ${result.stripe_status}. Local now ${result.local_status ?? 'unchanged'}.`,
      });
      log.refresh();
      health.refresh();
    } catch (e) {
      setToast({ tone: 'error', title: 'Reconcile failed', description: e instanceof Error ? e.message : String(e) });
    } finally {
      setReconcilingId(null);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <Card padding="lg">
        <h2 style={{ margin: 0, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold }}>
          Card payment health
        </h2>
        <p style={{ margin: `${theme.space[2]}px 0 ${theme.space[5]}px`, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
          Two checks. Webhook delivery shows when Stripe last reached the terminal-webhook function. Status reconciler is a poll-based fallback that the till uses to flip the screen if a webhook is delayed or dropped.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: theme.space[3] }}>
          <HealthDot
            label="Webhook delivery"
            tone={health.webhookState}
            value={
              health.webhookLastSeenISO
                ? `Last seen ${formatRelative(health.webhookLastSeenISO)}`
                : 'No event received yet'
            }
          />
          <HealthDot
            label="Status reconciler"
            tone={health.reconcilerReachable === true ? 'green' : health.reconcilerReachable === false ? 'red' : 'unknown'}
            value={
              health.reconcilerReachable === true
                ? 'Reachable'
                : health.reconcilerReachable === false
                  ? 'Unreachable'
                  : 'Probing…'
            }
          />
        </div>
        <div style={{ marginTop: theme.space[4], display: 'flex', justifyContent: 'flex-end' }}>
          <Button variant="tertiary" size="sm" onClick={health.refresh}>
            Refresh
          </Button>
        </div>
      </Card>

      <Card padding="lg">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: theme.space[3], flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold }}>
              Recent card payments
            </h2>
            <p style={{ margin: `${theme.space[2]}px 0 0`, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
              Pulled live from Stripe. Drift means Stripe and Lounge disagree on status. Orphan means Stripe has the payment but no Lounge row.
              {driftCount > 0 ? ` ${driftCount} need attention.` : ''}
            </p>
          </div>
          <Button variant="tertiary" size="sm" onClick={log.refresh}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
              <RefreshCw size={14} aria-hidden />
              Refresh
            </span>
          </Button>
        </div>

        <div style={{ marginTop: theme.space[5], display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
          {log.error ? (
            <p style={{ color: theme.color.alert, margin: 0, fontSize: theme.type.size.sm }}>{log.error}</p>
          ) : log.loading ? (
            <Skeleton height={80} />
          ) : log.rows.length === 0 ? (
            <EmptyState
              icon={<CreditCard size={20} />}
              title="No payments yet"
              description="Stripe hasn't recorded any payment intents on this account."
            />
          ) : (
            log.rows.map((row) => (
              <PaymentLogRow
                key={row.stripe.id}
                row={row}
                reconciling={reconcilingId === row.local?.payment_id}
                onReconcile={onReconcile}
              />
            ))
          )}
        </div>
      </Card>

      {toast ? (
        <div style={{ position: 'fixed', bottom: theme.space[6], left: '50%', transform: 'translateX(-50%)', zIndex: 100 }}>
          <Toast tone={toast.tone} title={toast.title} description={toast.description} duration={4000} onDismiss={() => setToast(null)} />
        </div>
      ) : null}
    </div>
  );
}

function HealthDot({
  label,
  tone,
  value,
}: {
  label: string;
  tone: 'green' | 'amber' | 'red' | 'unknown';
  value: string;
}) {
  const dotColor =
    tone === 'green'
      ? theme.color.accent
      : tone === 'amber'
        ? theme.color.warn
        : tone === 'red'
          ? theme.color.alert
          : theme.color.inkSubtle;
  return (
    <div
      style={{
        padding: theme.space[3],
        borderRadius: theme.radius.input,
        border: `1px solid ${theme.color.border}`,
        background: theme.color.bg,
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[1],
      }}
    >
      <span
        style={{
          fontSize: theme.type.size.xs,
          textTransform: 'uppercase',
          letterSpacing: theme.type.tracking.wide,
          color: theme.color.inkMuted,
          fontWeight: theme.type.weight.medium,
        }}
      >
        {label}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2] }}>
        <span
          aria-hidden
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: dotColor,
            flexShrink: 0,
            boxShadow: tone === 'green' ? `0 0 0 4px ${dotColor}22` : undefined,
          }}
        />
        <span style={{ fontSize: theme.type.size.sm, color: theme.color.ink, fontVariantNumeric: 'tabular-nums' }}>
          {value}
        </span>
      </div>
    </div>
  );
}

function PaymentLogRow({
  row,
  reconciling,
  onReconcile,
}: {
  row: StripePaymentRow;
  reconciling: boolean;
  onReconcile: (paymentId: string) => void;
}) {
  const stateLabel = humaniseStripeStatus(row.stripe.status);
  const localLabel = row.local?.status ? humaniseLocalStatus(row.local.status) : 'Not in Lounge';
  const tone =
    row.drift || row.orphan
      ? 'no_show'
      : row.stripe.status === 'succeeded' || row.stripe.status === 'requires_capture'
        ? 'arrived'
        : row.stripe.status === 'canceled'
          ? 'cancelled'
          : 'pending';
  return (
    <div
      style={{
        padding: theme.space[4],
        borderRadius: theme.radius.input,
        border: `1px solid ${row.drift || row.orphan ? theme.color.alert : theme.color.border}`,
        background: theme.color.bg,
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto',
        gap: theme.space[4],
        alignItems: 'center',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2], minWidth: 0 }}>
        <div style={{ display: 'flex', gap: theme.space[3], alignItems: 'center', flexWrap: 'wrap' }}>
          <span
            style={{
              fontSize: theme.type.size.lg,
              fontWeight: theme.type.weight.semibold,
              fontVariantNumeric: 'tabular-nums',
              color: theme.color.ink,
            }}
          >
            {formatPence(row.stripe.amount_pence)}
          </span>
          <StatusPill tone={tone} size="sm">
            Stripe: {stateLabel}
          </StatusPill>
          <StatusPill tone={row.drift || row.orphan ? 'no_show' : 'arrived'} size="sm">
            Lounge: {localLabel}
          </StatusPill>
          {row.drift ? <StatusPill tone="no_show" size="sm">Drift</StatusPill> : null}
          {row.orphan ? <StatusPill tone="no_show" size="sm">Orphan</StatusPill> : null}
        </div>
        <div style={{ display: 'flex', gap: theme.space[3], alignItems: 'center', flexWrap: 'wrap', color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatRelative(new Date(row.stripe.created * 1000).toISOString())}</span>
          {row.local?.patient_name ? <span>· {row.local.patient_name}</span> : null}
          {row.local?.appointment_ref ? <span>· {row.local.appointment_ref}</span> : null}
          {row.local?.payment_journey && row.local.payment_journey !== 'standard' ? (
            <span>· {row.local.payment_journey}</span>
          ) : null}
        </div>
        <code
          style={{
            fontSize: theme.type.size.xs,
            color: theme.color.inkSubtle,
            fontVariantNumeric: 'tabular-nums',
            wordBreak: 'break-all',
          }}
        >
          {row.stripe.id}
        </code>
        {row.stripe.last_payment_error ? (
          <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.alert }}>
            {row.stripe.last_payment_error}
          </p>
        ) : null}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2], alignItems: 'flex-end' }}>
        {row.local?.payment_id ? (
          <Button
            variant={row.drift ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => onReconcile(row.local!.payment_id!)}
            loading={reconciling}
          >
            Reconcile
          </Button>
        ) : (
          <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkSubtle, textAlign: 'right' }}>
            No local row to reconcile
          </span>
        )}
      </div>
    </div>
  );
}

function humaniseStripeStatus(s: string): string {
  switch (s) {
    case 'succeeded':
      return 'Succeeded';
    case 'requires_capture':
      return 'Auth (capture pending)';
    case 'canceled':
      return 'Cancelled';
    case 'processing':
      return 'Processing';
    case 'requires_action':
      return 'Customer action needed';
    case 'requires_payment_method':
      return 'Awaiting tap';
    case 'requires_confirmation':
      return 'Awaiting confirmation';
    default:
      return s;
  }
}

function humaniseLocalStatus(s: string): string {
  switch (s) {
    case 'succeeded':
      return 'Succeeded';
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return 'Failed';
    case 'pending':
      return 'Pending';
    case 'processing':
      return 'Processing';
    default:
      return s;
  }
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return iso;
  const sec = Math.round(ms / 1000);
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} h ago`;
  const days = Math.round(hr / 24);
  return `${days} d ago`;
}

function StaffTab() {
  const staff = useStaff();
  const { account: currentAccount } = useCurrentAccount();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<StaffRow | null>(null);
  const [draftFirst, setDraftFirst] = useState('');
  const [draftLast, setDraftLast] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

  // Add-staff sheet
  const [addOpen, setAddOpen] = useState(false);
  const [addEmail, setAddEmail] = useState('');
  const [addAdmin, setAddAdmin] = useState(false);
  const [addManager, setAddManager] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Deactivate confirm sheet
  const [deactivating, setDeactivating] = useState<StaffRow | null>(null);
  const [deactivateBusy, setDeactivateBusy] = useState(false);

  // Permissions sheet — fine-grained Reports / Financials / Cash count
  // flags. Reports default-on for everyone, the other two default-off
  // and are super-admin-grant only. Sheet shows all three so an admin
  // can read what's set even if they can't change everything.
  const [permsOpen, setPermsOpen] = useState<StaffRow | null>(null);

  const canEditAdmin = currentAccount?.is_super_admin === true;
  const canEditFinancialPerms = currentAccount?.is_super_admin === true;

  const visibleStaff = showInactive
    ? staff.data
    : staff.data.filter((s) => s.status === 'active');
  const inactiveCount = staff.data.filter((s) => s.status === 'inactive').length;

  const toggleManager = async (staffMemberId: string, next: boolean) => {
    setBusyId(staffMemberId);
    setError(null);
    try {
      await setIsManager(staffMemberId, next);
      staff.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const toggleAdmin = async (staffMemberId: string, next: boolean) => {
    if (!canEditAdmin) return;
    setBusyId(staffMemberId);
    setError(null);
    try {
      await setIsAdmin(staffMemberId, next);
      staff.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const openEdit = (row: StaffRow) => {
    setEditing(row);
    setDraftFirst(row.first_name ?? '');
    setDraftLast(row.last_name ?? '');
  };

  const saveEdit = async () => {
    if (!editing) return;
    setEditBusy(true);
    setError(null);
    try {
      await setStaffName(editing.account_id, draftFirst, draftLast);
      staff.refresh();
      setEditing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setEditBusy(false);
    }
  };

  const openAdd = () => {
    setAddEmail('');
    setAddAdmin(false);
    setAddManager(false);
    setAddError(null);
    setAddOpen(true);
  };

  const submitAdd = async () => {
    setAddBusy(true);
    setAddError(null);
    try {
      const result = await addStaffMemberByEmail(addEmail, {
        is_admin: addAdmin && canEditAdmin,
        is_manager: addManager,
      });
      if (!result) {
        setAddError(
          'No account exists with that email. Ask the person to sign in to Meridian first, or send them a Supabase invite.',
        );
        return;
      }
      staff.refresh();
      setAddOpen(false);
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    } finally {
      setAddBusy(false);
    }
  };

  const submitDeactivate = async () => {
    if (!deactivating) return;
    setDeactivateBusy(true);
    setError(null);
    try {
      await deactivateStaffMember(deactivating.staff_member_id);
      staff.refresh();
      setDeactivating(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeactivateBusy(false);
    }
  };

  const reactivate = async (staffMemberId: string) => {
    setBusyId(staffMemberId);
    setError(null);
    try {
      await reactivateStaffMember(staffMemberId);
      staff.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  // Optimistic toggle for the three permission flags. The old version
  // awaited the Supabase write + a full staff refetch before the
  // checkbox visually updated, which made every click feel like a
  // 300-500ms freeze and ate rapid taps. Now: flip the local state
  // first so the checkbox responds instantly, then mirror the change
  // to the server in the background. On error, revert and surface a
  // toast.
  const togglePerm = (
    staffMemberId: string,
    flag: 'reports' | 'financials' | 'cash',
    next: boolean,
  ) => {
    const field =
      flag === 'reports'
        ? 'can_view_reports'
        : flag === 'financials'
          ? 'can_view_financials'
          : 'can_count_cash';
    const prev = !next;
    // Optimistic: update the open sheet immediately so the user sees
    // the click land. The full staff list refresh happens after the
    // server confirms.
    setPermsOpen((cur) =>
      cur && cur.staff_member_id === staffMemberId ? { ...cur, [field]: next } : cur,
    );
    setError(null);
    const mutation =
      flag === 'reports'
        ? setCanViewReports(staffMemberId, next)
        : flag === 'financials'
          ? setCanViewFinancials(staffMemberId, next)
          : setCanCountCash(staffMemberId, next);
    mutation
      .then(() => {
        staff.refresh();
      })
      .catch((e) => {
        // Revert the optimistic update so the checkbox snaps back.
        setPermsOpen((cur) =>
          cur && cur.staff_member_id === staffMemberId ? { ...cur, [field]: prev } : cur,
        );
        setError(e instanceof Error ? e.message : String(e));
      });
  };

  return (
    <Card padding="lg">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: theme.space[3], flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold }}>
            Staff
          </h2>
          <p style={{ margin: `${theme.space[2]}px 0 0`, color: theme.color.inkMuted, fontSize: theme.type.size.sm, maxWidth: 640 }}>
            Only the people listed here can use Lounge. Add or deactivate without touching anyone's Meridian access. Names land on every signature, payment, and discount they sign off; pre-fill the witness field on waivers automatically.{canEditAdmin ? '' : ' Admin promotions are locked to the super admin.'}
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={openAdd}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
            <Plus size={14} aria-hidden /> Add staff member
          </span>
        </Button>
      </div>

      <div style={{ marginTop: theme.space[5], marginBottom: theme.space[4] }}>
        {staff.loading ? (
          <Skeleton height={120} />
        ) : staff.error ? (
          <p style={{ color: theme.color.alert, margin: 0 }}>Could not load staff: {staff.error}</p>
        ) : visibleStaff.length === 0 ? (
          <EmptyState
            icon={<Users size={20} />}
            title="No staff yet"
            description="Add the first staff member to get started."
          />
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
            {visibleStaff.map((s) => {
              const isInactive = s.status === 'inactive';
              const isMe = s.account_id === currentAccount?.account_id;
              const isSuperAdminRow = s.login_email === 'dylan@lanquez.com';
              return (
                <li
                  key={s.staff_member_id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: theme.space[3],
                    padding: theme.space[3],
                    background: isInactive ? theme.color.bg : theme.color.surface,
                    border: `1px solid ${theme.color.border}`,
                    borderRadius: 12,
                    flexWrap: 'wrap',
                    opacity: isInactive ? 0.65 : 1,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <p style={{ margin: 0, fontSize: theme.type.size.base, fontWeight: theme.type.weight.semibold, display: 'flex', alignItems: 'center', gap: theme.space[2], flexWrap: 'wrap' }}>
                      <span>{s.display_name}</span>
                      {isInactive ? (
                        <StatusPill tone="cancelled" size="sm">
                          Deactivated
                        </StatusPill>
                      ) : null}
                      {!s.first_name || !s.last_name ? (
                        <span
                          style={{
                            fontSize: theme.type.size.xs,
                            color: theme.color.warn,
                            fontWeight: theme.type.weight.medium,
                          }}
                        >
                          Name incomplete
                        </span>
                      ) : null}
                    </p>
                    <p style={{ margin: `${theme.space[1]}px 0 0`, color: theme.color.inkMuted, fontSize: theme.type.size.xs }}>
                      {s.login_email || 'No login email'}
                    </p>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[4], flexWrap: 'wrap' }}>
                    {isInactive ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => reactivate(s.staff_member_id)}
                        loading={busyId === s.staff_member_id}
                      >
                        Reactivate
                      </Button>
                    ) : (
                      <>
                        <Checkbox
                          checked={s.is_manager}
                          onChange={(v) => toggleManager(s.staff_member_id, v)}
                          disabled={busyId === s.staff_member_id}
                          label="Manager"
                        />
                        <Checkbox
                          checked={s.is_admin}
                          onChange={(v) => toggleAdmin(s.staff_member_id, v)}
                          disabled={busyId === s.staff_member_id || !canEditAdmin || isSuperAdminRow}
                          label="Admin"
                        />
                        <Button variant="tertiary" size="sm" onClick={() => openEdit(s)}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
                            <Pencil size={14} aria-hidden /> Edit name
                          </span>
                        </Button>
                        <Button variant="tertiary" size="sm" onClick={() => setPermsOpen(s)}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
                            <ShieldAlert size={14} aria-hidden /> Permissions
                          </span>
                        </Button>
                        {isSuperAdminRow || isMe ? null : (
                          <Button
                            variant="tertiary"
                            size="sm"
                            onClick={() => setDeactivating(s)}
                          >
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1], color: theme.color.alert }}>
                              <Trash2 size={14} aria-hidden /> Deactivate
                            </span>
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {inactiveCount > 0 ? (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button variant="tertiary" size="sm" onClick={() => setShowInactive((v) => !v)}>
            {showInactive
              ? `Hide ${inactiveCount} deactivated`
              : `Show ${inactiveCount} deactivated`}
          </Button>
        </div>
      ) : null}

      {error ? (
        <p role="alert" style={{ marginTop: theme.space[3], color: theme.color.alert, fontSize: theme.type.size.sm }}>
          {error}
        </p>
      ) : null}

      <BottomSheet
        open={editing !== null}
        onClose={() => !editBusy && setEditing(null)}
        dismissable={!editBusy}
        title={editing ? `Edit ${editing.display_name}` : 'Edit staff'}
        description="First and last name are used wherever this account leaves a mark — waiver witness, timeline attribution, signed-document footer."
        footer={
          <div style={{ display: 'flex', gap: theme.space[3], justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={() => setEditing(null)} disabled={editBusy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={saveEdit} loading={editBusy}>
              Save
            </Button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
          <Input
            label="First name"
            value={draftFirst}
            onChange={(e) => setDraftFirst(e.target.value)}
            placeholder="e.g. Dylan"
            autoFocus
          />
          <Input
            label="Last name"
            value={draftLast}
            onChange={(e) => setDraftLast(e.target.value)}
            placeholder="e.g. Lane"
          />
        </div>
      </BottomSheet>

      <BottomSheet
        open={addOpen}
        onClose={() => !addBusy && setAddOpen(false)}
        dismissable={!addBusy}
        title="Add staff member"
        description="Adds an existing account to the Lounge staff list. They keep their existing access elsewhere; this just opts them into Lounge with the roles you pick."
        footer={
          <div style={{ display: 'flex', gap: theme.space[3], justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={() => setAddOpen(false)} disabled={addBusy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submitAdd} loading={addBusy}>
              Add
            </Button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
          <Input
            label="Login email"
            type="email"
            value={addEmail}
            onChange={(e) => setAddEmail(e.target.value)}
            placeholder="e.g. sarah@venneir.com"
            autoFocus
          />
          <div style={{ display: 'flex', gap: theme.space[5], flexWrap: 'wrap' }}>
            <Checkbox
              checked={addManager}
              onChange={setAddManager}
              label="Manager"
            />
            <Checkbox
              checked={addAdmin}
              onChange={setAddAdmin}
              disabled={!canEditAdmin}
              label={canEditAdmin ? 'Admin' : 'Admin (super admin only)'}
            />
          </div>
          {addError ? (
            <p role="alert" style={{ margin: 0, color: theme.color.alert, fontSize: theme.type.size.sm }}>
              {addError}
            </p>
          ) : null}
        </div>
      </BottomSheet>

      <BottomSheet
        open={deactivating !== null}
        onClose={() => !deactivateBusy && setDeactivating(null)}
        dismissable={!deactivateBusy}
        title={deactivating ? `Deactivate ${deactivating.display_name}?` : 'Deactivate staff'}
        description="They lose access to Lounge immediately. Their attribution on every past signature, payment, and discount they signed off stays in place. Their access to Meridian or any other Venneir tool is untouched. You can reactivate them later."
        footer={
          <div style={{ display: 'flex', gap: theme.space[3], justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={() => setDeactivating(null)} disabled={deactivateBusy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submitDeactivate} loading={deactivateBusy}>
              Deactivate
            </Button>
          </div>
        }
      >
        <div />
      </BottomSheet>

      <BottomSheet
        open={permsOpen !== null}
        onClose={() => setPermsOpen(null)}
        title={permsOpen ? `${permsOpen.display_name} — Permissions` : 'Permissions'}
        description="Granular access. Reports is operational and on by default; Financials and Cash counting are super-admin-grants only."
        footer={
          <div style={{ display: 'flex', gap: theme.space[3], justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={() => setPermsOpen(null)}>
              Done
            </Button>
          </div>
        }
      >
        {permsOpen ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
            <PermissionRow
              title="Reports"
              description="Opens the Reports tab — operational dashboards covering bookings, demographics, marketing, service mix, lifetime value."
              checked={permsOpen.can_view_reports}
              onChange={(v) => togglePerm(permsOpen.staff_member_id, 'reports', v)}
            />
            <PermissionRow
              title="Financials"
              description="Opens the Financials tab — sales, discounts, voids, anomaly flags, cash reconciliation. Super-admin-grant only."
              checked={permsOpen.can_view_financials}
              disabled={!canEditFinancialPerms}
              disabledReason={canEditFinancialPerms ? undefined : 'Only the super admin can grant Financials access.'}
              onChange={(v) => togglePerm(permsOpen.staff_member_id, 'financials', v)}
            />
            <PermissionRow
              title="Cash counting"
              description="Lets this person initiate a cash reconciliation count. Sign-off still requires a different manager. Super-admin-grant only."
              checked={permsOpen.can_count_cash}
              disabled={!canEditFinancialPerms}
              disabledReason={canEditFinancialPerms ? undefined : 'Only the super admin can grant Cash counting access.'}
              onChange={(v) => togglePerm(permsOpen.staff_member_id, 'cash', v)}
            />
          </div>
        ) : (
          <div />
        )}
      </BottomSheet>
    </Card>
  );
}

// Single row in the Permissions sheet. Title + explanation + toggle.
// Disabled with a reason line when the current operator isn't allowed
// to flip this particular flag — the brief is explicit that we never
// hide the door, we just say why it's locked.
function PermissionRow({
  title,
  description,
  checked,
  onChange,
  disabled = false,
  disabledReason,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        gap: theme.space[3],
        alignItems: 'flex-start',
        padding: theme.space[3],
        borderRadius: theme.radius.input,
        border: `1px solid ${theme.color.border}`,
        background: theme.color.bg,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: theme.type.size.base, fontWeight: theme.type.weight.semibold }}>
          {title}
        </p>
        <p style={{ margin: `${theme.space[1]}px 0 0`, color: theme.color.inkMuted, fontSize: theme.type.size.sm, lineHeight: 1.4 }}>
          {description}
        </p>
        {disabled && disabledReason ? (
          <p style={{ margin: `${theme.space[2]}px 0 0`, color: theme.color.inkSubtle, fontSize: theme.type.size.xs }}>
            {disabledReason}
          </p>
        ) : null}
      </div>
      <Checkbox
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        ariaLabel={title}
      />
    </div>
  );
}

function FailuresTab() {
  const { data, loading } = useUnresolvedFailures();

  const onResolve = async (row: SystemFailureRow) => {
    await supabase
      .from('lng_system_failures')
      .update({ resolved_at: new Date().toISOString(), resolution_notes: 'Resolved via /admin' })
      .eq('id', row.id);
    window.location.reload();
  };

  return (
    <Card padding="lg">
      <h2 style={{ margin: 0, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold }}>
        Unresolved failures
      </h2>
      <p style={{ margin: `${theme.space[2]}px 0 ${theme.space[5]}px`, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
        Anything that fell over and was logged. Resolve when you have addressed the cause.
      </p>
      {loading ? (
        <Skeleton height={64} />
      ) : data.length === 0 ? (
        <EmptyState
          icon={<AlertTriangle size={20} />}
          title="All clear"
          description="No unresolved failures. Nice."
        />
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
          {data.map((f) => (
            <li
              key={f.id}
              style={{
                padding: theme.space[4],
                background: theme.color.surface,
                border: `1px solid ${theme.color.border}`,
                borderRadius: 12,
                display: 'flex',
                flexDirection: 'column',
                gap: theme.space[2],
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2] }}>
                <StatusPill tone={severityToTone(f.severity)} size="sm">
                  {f.severity}
                </StatusPill>
                <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>{f.source}</span>
                <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkSubtle, marginLeft: 'auto' }}>
                  {new Date(f.occurred_at).toLocaleString('en-GB')}
                </span>
              </div>
              <p style={{ margin: 0, fontSize: theme.type.size.base, color: theme.color.ink }}>{f.message}</p>
              {f.context ? (
                <pre
                  style={{
                    margin: 0,
                    fontSize: theme.type.size.xs,
                    color: theme.color.inkMuted,
                    background: theme.color.bg,
                    padding: theme.space[2],
                    borderRadius: 6,
                    overflowX: 'auto',
                  }}
                >
                  {JSON.stringify(f.context, null, 2)}
                </pre>
              ) : null}
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button variant="secondary" size="sm" onClick={() => onResolve(f)}>
                  Mark resolved
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Tile({ icon, label, value }: { icon?: React.ReactNode; label: string; value: string }) {
  return (
    <div
      style={{
        background: theme.color.surface,
        borderRadius: theme.radius.card,
        padding: theme.space[4],
        boxShadow: theme.shadow.card,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], color: theme.color.inkMuted }}>
        {icon}
        <span style={{ fontSize: theme.type.size.xs, fontWeight: theme.type.weight.medium, textTransform: 'uppercase', letterSpacing: theme.type.tracking.wide }}>
          {label}
        </span>
      </div>
      <p
        style={{
          margin: `${theme.space[2]}px 0 0`,
          fontSize: theme.type.size.lg,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.ink,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </p>
    </div>
  );
}

function severityToTone(s: SystemFailureRow['severity']) {
  return s === 'critical' || s === 'error' ? 'no_show' : s === 'warning' ? 'in_progress' : 'neutral';
}

// ---------- Catalogue tab ----------
//
// Shared with Checkpoint via the lwo_catalogue table. Edits here land in the
// same row Checkpoint reads, so prices and SKUs never drift between the two
// surfaces. Active=false is the soft-delete (line items reference catalogue
// rows by id, never hard-delete).

type CatalogueMode = 'services' | 'products';

function CatalogueTab({ mode }: { mode: CatalogueMode }) {
  const { rows, loading, error, refresh } = useCatalogueAll();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; title: string; description?: string } | null>(null);

  // Filter to just this mode's rows. is_service splits the lwo_catalogue
  // table into two logical buckets — Services (treatments / appointments
  // bookable through the schedule) vs Products (retail items, care
  // products that show up as cart upsells). Same table, two views.
  const filteredRows = useMemo(
    () => rows.filter((r) => (mode === 'services' ? r.is_service : !r.is_service)),
    [rows, mode],
  );
  const grouped = groupByCategory(filteredRows);
  const isServices = mode === 'services';

  const onSave = async (draft: CatalogueDraft, waiverSectionKeys: string[]) => {
    try {
      // SLA target only persists when sla_enabled. Toggling SLA off
      // wipes the target so we don't leave dormant numbers in the row.
      const slaTargetMinutes = draft.sla_enabled
        ? parseInt(draft.sla_target_minutes, 10) || null
        : null;
      const saved = await upsertCatalogueRow({
        id: draft.id,
        code: draft.code.trim(),
        category: draft.category.trim(),
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        unit_price: parseFloat(draft.unit_price) || 0,
        extra_unit_price: draft.extra_unit_price.trim() ? parseFloat(draft.extra_unit_price) : null,
        both_arches_price:
          draft.arch_match !== 'any' && draft.both_arches_price.trim()
            ? parseFloat(draft.both_arches_price)
            : null,
        unit_label: draft.unit_label.trim() || null,
        image_url: draft.image_url,
        service_type: draft.service_type.trim() || null,
        product_key: draft.product_key.trim() || null,
        repair_variant: draft.repair_variant.trim() || null,
        arch_match: draft.arch_match,
        is_service: draft.is_service,
        quantity_enabled: draft.quantity_enabled,
        sla_enabled: draft.sla_enabled,
        sla_target_minutes: slaTargetMinutes,
        include_on_lwo: draft.include_on_lwo,
        allocate_job_box: draft.allocate_job_box,
        sort_order: parseInt(draft.sort_order, 10) || 0,
        active: draft.active,
      });
      // Persist waiver requirements after the row exists (new rows
      // don't have an id until upsert returns).
      await setCatalogueWaiverRequirements(saved.id, waiverSectionKeys);
      setEditingId(null);
      setAdding(false);
      refresh();
      setToast({ tone: 'success', title: draft.id ? 'Saved.' : 'Added.' });
    } catch (e) {
      setToast({
        tone: 'error',
        title: 'Save failed',
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const onToggleActive = async (row: CatalogueRow) => {
    try {
      await setCatalogueActive(row.id, !row.active);
      refresh();
    } catch (e) {
      setToast({
        tone: 'error',
        title: 'Could not toggle active',
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <Card padding="md">
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: theme.space[3],
          marginBottom: theme.space[4],
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h2
            style={{
              margin: 0,
              fontSize: theme.type.size.lg,
              fontWeight: theme.type.weight.semibold,
            }}
          >
            {isServices ? 'Services' : 'Products'}
          </h2>
          <p
            style={{
              margin: `${theme.space[1]}px 0 0`,
              color: theme.color.inkMuted,
              fontSize: theme.type.size.sm,
            }}
          >
            {isServices
              ? 'Treatments and appointments your team books in. Shared with Checkpoint via lwo_catalogue.'
              : 'Care products and retail items. Surface as cart upsells at checkout.'}
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setAdding(true)} disabled={adding}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
            <Plus size={16} /> {isServices ? 'Add service' : 'Add product'}
          </span>
        </Button>
      </div>

      {error ? (
        <p style={{ color: theme.color.alert, margin: 0 }}>Could not load catalogue: {error}</p>
      ) : loading ? (
        <Skeleton height={120} radius={12} />
      ) : adding ? (
        <CatalogueRowEditor
          mode={mode}
          initial={emptyDraft(mode)}
          onSave={onSave}
          onCancel={() => setAdding(false)}
        />
      ) : grouped.length === 0 ? (
        <EmptyState
          icon={<Package size={24} />}
          title={isServices ? 'No services yet' : 'No products yet'}
          description={
            isServices
              ? 'Tap Add service to seed your treatments.'
              : 'Tap Add product to seed care products that show up as cart upsells.'
          }
        />
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
          {/* Flat list. Category is preserved as a sort key inside
              groupByCategory so related rows still cluster, but the
              category eyebrow header is dropped — each card's own
              title already carries the name and the eyebrow read
              as duplicate noise. */}
          {grouped.flatMap(([, catRows]) =>
            catRows.map((row) =>
              editingId === row.id ? (
                <li key={row.id}>
                  <CatalogueRowEditor
                    mode={mode}
                    initial={draftFromRow(row)}
                    onSave={onSave}
                    onCancel={() => setEditingId(null)}
                  />
                </li>
              ) : (
                <CatalogueRowDisplay
                  key={row.id}
                  row={row}
                  onEdit={() => setEditingId(row.id)}
                  onToggleActive={() => onToggleActive(row)}
                />
              ),
            ),
          )}
        </ul>
      )}

      {toast ? (
        <div style={{ position: 'fixed', bottom: theme.space[6], left: '50%', transform: 'translateX(-50%)', zIndex: 100 }}>
          <Toast tone={toast.tone} title={toast.title} description={toast.description} duration={4000} onDismiss={() => setToast(null)} />
        </div>
      ) : null}
    </Card>
  );
}

interface CatalogueDraft {
  id?: string;
  code: string;
  category: string;
  name: string;
  description: string;
  unit_price: string; // pounds, edited as text so the user can type "25.50"
  extra_unit_price: string;
  // Pounds. Used when arch_match !== 'any' and the picker has both arches
  // selected. Stored as text so the form keeps the user's keystrokes
  // verbatim (e.g. "199.50") and we parseFloat once on save.
  both_arches_price: string;
  unit_label: string;
  image_url: string | null;
  service_type: string;
  product_key: string;
  repair_variant: string;
  arch_match: ArchMatch;
  is_service: boolean;
  quantity_enabled: boolean;
  sla_enabled: boolean;
  // Edited as text so the user can clear the field; parseInt on save.
  sla_target_minutes: string;
  include_on_lwo: boolean;
  allocate_job_box: boolean;
  sort_order: string;
  active: boolean;
}

function emptyDraft(mode: CatalogueMode): CatalogueDraft {
  const isService = mode === 'services';
  return {
    code: '',
    category: '',
    name: '',
    description: '',
    unit_price: '',
    extra_unit_price: '',
    both_arches_price: '',
    unit_label: '',
    image_url: null,
    service_type: '',
    product_key: '',
    repair_variant: '',
    arch_match: 'any',
    is_service: isService,
    // Services default to one-shot (no quantity selector, e.g. an
    // appointment isn't bought "in 3s"). Products default to
    // quantity-enabled because retail items often are.
    quantity_enabled: !isService,
    sla_enabled: false,
    sla_target_minutes: '',
    // LWO inclusion + JB allocation only mean anything for services
    // (lab work flow). Default off for products — they're retail
    // items that don't trigger lab orders.
    include_on_lwo: isService,
    allocate_job_box: isService,
    sort_order: '0',
    active: true,
  };
}

function draftFromRow(row: CatalogueRow): CatalogueDraft {
  return {
    id: row.id,
    code: row.code,
    category: row.category,
    name: row.name,
    description: row.description ?? '',
    unit_price: row.unit_price.toFixed(2),
    extra_unit_price: row.extra_unit_price != null ? row.extra_unit_price.toFixed(2) : '',
    both_arches_price: row.both_arches_price != null ? row.both_arches_price.toFixed(2) : '',
    unit_label: row.unit_label ?? '',
    image_url: row.image_url,
    service_type: row.service_type ?? '',
    product_key: row.product_key ?? '',
    repair_variant: row.repair_variant ?? '',
    arch_match: row.arch_match,
    is_service: row.is_service,
    quantity_enabled: row.quantity_enabled,
    sla_enabled: row.sla_enabled,
    sla_target_minutes: row.sla_target_minutes != null ? String(row.sla_target_minutes) : '',
    include_on_lwo: row.include_on_lwo,
    allocate_job_box: row.allocate_job_box,
    sort_order: String(row.sort_order),
    active: row.active,
  };
}

function CatalogueRowDisplay({
  row,
  onEdit,
  onToggleActive,
}: {
  row: CatalogueRow;
  onEdit: () => void;
  onToggleActive: () => void;
}) {
  return (
    <li
      style={{
        border: `1px solid ${theme.color.border}`,
        borderRadius: 14,
        padding: theme.space[4],
        background: row.active ? theme.color.surface : 'rgba(14, 20, 20, 0.02)',
        display: 'flex',
        alignItems: 'flex-start',
        gap: theme.space[3],
        opacity: row.active ? 1 : 0.7,
      }}
    >
      <CatalogueThumbnail src={row.image_url} alt={row.name} size={56} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: theme.space[2], flexWrap: 'wrap' }}>
          <span style={{ fontWeight: theme.type.weight.semibold, fontSize: theme.type.size.base, color: theme.color.ink }}>
            {row.name}
          </span>
          <span style={{ color: theme.color.inkSubtle, fontSize: theme.type.size.xs, fontFamily: 'monospace' }}>{row.code}</span>
          {!row.active ? (
            <StatusPill tone="cancelled" size="sm">
              Inactive
            </StatusPill>
          ) : null}
        </div>
        {row.description ? (
          <p style={{ margin: `${theme.space[1]}px 0 0`, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
            {row.description}
          </p>
        ) : null}
        <p
          style={{
            margin: `${theme.space[2]}px 0 0`,
            fontSize: theme.type.size.sm,
            fontVariantNumeric: 'tabular-nums',
            color: theme.color.ink,
          }}
        >
          {formatPounds(row.unit_price)}
          {row.extra_unit_price != null ? ` (extras ${formatPounds(row.extra_unit_price)})` : ''}
          {row.unit_label ? ` · ${row.unit_label}` : ''}
        </p>
        <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>
          {[
            row.service_type,
            row.product_key,
            row.repair_variant,
            row.arch_match !== 'any' ? `arch=${row.arch_match}` : null,
          ]
            .filter(Boolean)
            .join(' · ') || 'no match rules'}
        </p>
      </div>
      <div style={{ display: 'flex', gap: theme.space[1], flexShrink: 0 }}>
        <Button variant="tertiary" size="sm" onClick={onToggleActive}>
          {row.active ? 'Deactivate' : 'Reactivate'}
        </Button>
        <Button variant="secondary" size="sm" onClick={onEdit}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Pencil size={14} /> Edit
          </span>
        </Button>
      </div>
    </li>
  );
}

function CatalogueRowEditor({
  mode,
  initial,
  onSave,
  onCancel,
}: {
  mode: CatalogueMode;
  initial: CatalogueDraft;
  onSave: (draft: CatalogueDraft, waiverSectionKeys: string[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<CatalogueDraft>(initial);
  const isService = mode === 'services';
  const [busy, setBusy] = useState(false);
  const [imgBusy, setImgBusy] = useState(false);
  const [imgError, setImgError] = useState<string | null>(null);
  const set = <K extends keyof CatalogueDraft>(k: K, v: CatalogueDraft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  // Waiver requirements (per-item explicit links). When the editor opens
  // on an existing row the hook returns the current set; we mirror it
  // into local state so the user can toggle without persisting until
  // Save fires. New rows start with an empty set.
  const { sections: waiverSections, loading: waiverSectionsLoading } = useWaiverSections();
  const { sectionKeys: existingWaiverKeys, loading: existingWaiverLoading } =
    useCatalogueWaiverRequirements(initial.id ?? null);
  const [waiverKeys, setWaiverKeys] = useState<string[]>([]);
  const [waiverSeeded, setWaiverSeeded] = useState(false);
  // Seed local state once the hook has finished loading. Without this
  // gate a fast Save → reopen sequence could see a stale empty array.
  useEffect(() => {
    if (waiverSeeded) return;
    if (!initial.id) {
      setWaiverSeeded(true);
      return;
    }
    if (existingWaiverLoading) return;
    setWaiverKeys(existingWaiverKeys);
    setWaiverSeeded(true);
  }, [initial.id, existingWaiverLoading, existingWaiverKeys, waiverSeeded]);

  const toggleWaiver = (key: string, checked: boolean) => {
    setWaiverKeys((cur) => (checked ? [...new Set([...cur, key])] : cur.filter((k) => k !== key)));
  };

  const submit = async () => {
    if (!draft.code.trim() || !draft.name.trim() || !draft.category.trim()) return;
    setBusy(true);
    try {
      await onSave(draft, waiverKeys);
    } finally {
      setBusy(false);
    }
  };

  const onImageFile = async (file: File | null) => {
    setImgError(null);
    if (!file) return;
    if (!draft.code.trim()) {
      setImgError('Set a code first — the file is named after it.');
      return;
    }
    setImgBusy(true);
    try {
      const url = await uploadCatalogueImage(file, draft.code);
      set('image_url', url);
    } catch (e) {
      setImgError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setImgBusy(false);
    }
  };

  const onRemoveImage = async () => {
    setImgError(null);
    setImgBusy(true);
    try {
      if (draft.code.trim()) await deleteCatalogueImage(draft.code);
      set('image_url', null);
    } catch (e) {
      setImgError(e instanceof Error ? e.message : 'Remove failed');
    } finally {
      setImgBusy(false);
    }
  };

  return (
    <div
      style={{
        border: `1px solid ${theme.color.ink}`,
        borderRadius: 14,
        padding: theme.space[4],
        background: theme.color.surface,
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[3],
      }}
    >
      <div style={{ display: 'flex', gap: theme.space[4], alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <CatalogueThumbnail src={draft.image_url} alt={draft.name || draft.code} size={96} />
        <div style={{ flex: 1, minWidth: 200, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.xs,
              color: theme.color.inkMuted,
              fontWeight: theme.type.weight.medium,
              textTransform: 'uppercase',
              letterSpacing: theme.type.tracking.wide,
            }}
          >
            Image
          </p>
          <div style={{ display: 'flex', gap: theme.space[2], flexWrap: 'wrap' }}>
            <label>
              <input
                type="file"
                accept="image/*"
                disabled={imgBusy}
                onChange={(e) => onImageFile(e.target.files?.[0] ?? null)}
                style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
              />
              <span
                role="button"
                tabIndex={0}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: `0 ${theme.space[3]}px`,
                  height: 36,
                  borderRadius: theme.radius.pill,
                  border: `1px solid ${theme.color.ink}`,
                  background: theme.color.surface,
                  color: theme.color.ink,
                  fontSize: theme.type.size.sm,
                  fontWeight: theme.type.weight.medium,
                  cursor: imgBusy ? 'not-allowed' : 'pointer',
                  opacity: imgBusy ? 0.5 : 1,
                }}
              >
                <Plus size={14} /> {draft.image_url ? 'Replace image' : 'Upload image'}
              </span>
            </label>
            {draft.image_url ? (
              <Button variant="tertiary" size="sm" onClick={onRemoveImage} disabled={imgBusy}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <X size={14} /> Remove
                </span>
              </Button>
            ) : null}
          </div>
          {imgError ? (
            <p style={{ margin: 0, color: theme.color.alert, fontSize: theme.type.size.xs }}>{imgError}</p>
          ) : (
            <p style={{ margin: 0, color: theme.color.inkSubtle, fontSize: theme.type.size.xs }}>
              PNG / JPG. Stored as <code>{draft.code || '<code>'}.&lt;ext&gt;</code> in catalogue-images.
            </p>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: theme.space[3] }}>
        <Input label="Code (unique)" value={draft.code} onChange={(e) => set('code', e.target.value)} />
        <Input label="Category" value={draft.category} onChange={(e) => set('category', e.target.value)} />
      </div>
      <Input label="Name" value={draft.name} onChange={(e) => set('name', e.target.value)} />
      <Input
        label="Description"
        value={draft.description}
        onChange={(e) => set('description', e.target.value)}
      />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: theme.space[3] }}>
        <Input
          label="Unit price (£)"
          numericFormat="currency"
          value={draft.unit_price}
          onChange={(e) => set('unit_price', e.target.value)}
        />
        <Input
          label="Extras price (£)"
          numericFormat="currency"
          value={draft.extra_unit_price}
          onChange={(e) => set('extra_unit_price', e.target.value)}
          placeholder="optional"
        />
        <Input
          label="Unit label"
          value={draft.unit_label}
          onChange={(e) => set('unit_label', e.target.value)}
          placeholder="e.g. per tooth"
        />
      </div>
      {isService && draft.arch_match !== 'any' ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: theme.space[3] }}>
          <Input
            label="Both arches price (£)"
            numericFormat="currency"
            value={draft.both_arches_price}
            onChange={(e) => set('both_arches_price', e.target.value)}
            placeholder="optional, picker uses unit price when blank"
          />
          <span />
        </div>
      ) : null}
      {isService ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: theme.space[3] }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: theme.space[1] }}>
              <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkMuted, fontWeight: theme.type.weight.medium }}>
                Service type
              </span>
              <select
                value={draft.service_type}
                onChange={(e) => set('service_type', e.target.value)}
                style={{
                  height: theme.layout.inputHeight,
                  padding: `0 ${theme.space[3]}px`,
                  fontSize: theme.type.size.base,
                  fontFamily: 'inherit',
                  border: `1px solid ${theme.color.border}`,
                  borderRadius: theme.radius.input,
                  background: theme.color.surface,
                }}
              >
                <option value="">— any (wildcard) —</option>
                <option value="denture_repair">Denture repair</option>
                <option value="same_day_appliance">Same-day appliance</option>
                <option value="click_in_veneers">Click-in veneers</option>
                <option value="impression_appointment">Impression appointment</option>
                <option value="other">Other / consultation</option>
              </select>
            </label>
            <Input
              label="Product key"
              value={draft.product_key}
              onChange={(e) => set('product_key', e.target.value)}
              placeholder="e.g. retainer, night_guard"
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: theme.space[3] }}>
            <Input
              label="Repair variant"
              value={draft.repair_variant}
              onChange={(e) => set('repair_variant', e.target.value)}
              placeholder="e.g. Snapped denture"
            />
            <label style={{ display: 'flex', flexDirection: 'column', gap: theme.space[1] }}>
              <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkMuted, fontWeight: theme.type.weight.medium }}>
                Arch match
              </span>
              <select
                value={draft.arch_match}
                onChange={(e) => set('arch_match', e.target.value as ArchMatch)}
                style={{
                  height: theme.layout.inputHeight,
                  padding: `0 ${theme.space[3]}px`,
                  fontSize: theme.type.size.base,
                  fontFamily: 'inherit',
                  border: `1px solid ${theme.color.border}`,
                  borderRadius: theme.radius.input,
                  background: theme.color.surface,
                }}
              >
                <option value="any">any (wildcard)</option>
                <option value="single">single (upper or lower)</option>
                <option value="both">both arches</option>
              </select>
            </label>
          </div>
        </>
      ) : null}
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[4], flexWrap: 'wrap' }}>
        <Input
          label="Sort order"
          numericFormat="integer"
          value={draft.sort_order}
          onChange={(e) => set('sort_order', e.target.value)}
          style={{ maxWidth: 140 }}
        />
        <Checkbox
          checked={draft.active}
          onChange={(v) => set('active', v)}
          label="Active (visible to receptionist)"
        />
        <Checkbox
          checked={draft.quantity_enabled}
          onChange={(v) => set('quantity_enabled', v)}
          label={
            isService
              ? 'Quantity selector (uncheck for one-shot services like in-clinic appointments)'
              : 'Quantity selector (lets the patient buy more than one)'
          }
        />
      </div>

      {/* Service-only operational settings: LWO inclusion, JB allocation, SLA. */}
      {isService ? (
        <div
          style={{
            border: `1px solid ${theme.color.border}`,
            borderRadius: 12,
            padding: theme.space[3],
            display: 'flex',
            flexDirection: 'column',
            gap: theme.space[3],
            background: 'rgba(14, 20, 20, 0.02)',
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.xs,
              color: theme.color.inkMuted,
              fontWeight: theme.type.weight.medium,
              textTransform: 'uppercase',
              letterSpacing: theme.type.tracking.wide,
            }}
          >
            Operations
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[4], flexWrap: 'wrap' }}>
            <Checkbox
              checked={draft.include_on_lwo}
              onChange={(v) => set('include_on_lwo', v)}
              label="Print on Lab Work Order"
            />
            <Checkbox
              checked={draft.allocate_job_box}
              onChange={(v) => set('allocate_job_box', v)}
              label="Requires a job box at arrival"
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[4], flexWrap: 'wrap' }}>
            <Checkbox
              checked={draft.sla_enabled}
              onChange={(v) => set('sla_enabled', v)}
              label="SLA enabled (arrived → appointment complete)"
            />
            {draft.sla_enabled ? (
              <Input
                label="SLA target (minutes)"
                numericFormat="integer"
                value={draft.sla_target_minutes}
                onChange={(e) => set('sla_target_minutes', e.target.value)}
                placeholder="e.g. 120"
                style={{ maxWidth: 180 }}
              />
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Service-only: per-item waiver requirements. Products don't sign
          waivers — they're retail purchases. */}
      {isService ? (
        <div
          style={{
            border: `1px solid ${theme.color.border}`,
            borderRadius: 12,
            padding: theme.space[3],
            display: 'flex',
            flexDirection: 'column',
            gap: theme.space[2],
            background: 'rgba(14, 20, 20, 0.02)',
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.xs,
              color: theme.color.inkMuted,
              fontWeight: theme.type.weight.medium,
              textTransform: 'uppercase',
              letterSpacing: theme.type.tracking.wide,
            }}
          >
            Required waivers
          </p>
          <p style={{ margin: 0, fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>
            Tick every section the patient must sign for this item. Leave all unchecked to fall back to the
            service-type rule on the waiver section itself.
          </p>
          {waiverSectionsLoading || existingWaiverLoading ? (
            <Skeleton height={80} radius={8} />
          ) : waiverSections.length === 0 ? (
            <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
              No active waiver sections. Add some on the Waivers tab.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
              {waiverSections.map((sec) => (
                <Checkbox
                  key={sec.key}
                  checked={waiverKeys.includes(sec.key)}
                  onChange={(v) => toggleWaiver(sec.key, v)}
                  label={`${sec.title}  ·  v${sec.version}`}
                />
              ))}
            </div>
          )}
        </div>
      ) : null}

      {draft.id ? (
        <ProductUpgradesEditor
          catalogueId={draft.id}
          archEnabled={draft.arch_match !== 'any'}
        />
      ) : (
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            fontStyle: 'italic',
          }}
        >
          Save the product first to attach upgrades.
        </p>
      )}
      <div style={{ display: 'flex', gap: theme.space[2], justifyContent: 'flex-end', marginTop: theme.space[2] }}>
        <Button variant="tertiary" onClick={onCancel} disabled={busy}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <X size={16} /> Cancel
          </span>
        </Button>
        <Button variant="primary" onClick={submit} loading={busy}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Check size={16} /> {draft.id ? 'Save' : 'Add'}
          </span>
        </Button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-product upgrades editor — sits inside CatalogueRowEditor when
// editing an existing product. Each product owns its own upgrade rows
// (no shared registry). Add new ones inline, edit / delete / toggle
// active per row. Both-arches price input only renders when the parent
// product has arch options.
// ─────────────────────────────────────────────────────────────────────────────

function ProductUpgradesEditor({
  catalogueId,
  archEnabled,
}: {
  catalogueId: string;
  archEnabled: boolean;
}) {
  const { rows, loading, error, refresh } = useUpgradesForCatalogue(catalogueId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; title: string; description?: string } | null>(null);

  const onSave = async (draft: UpgradeDraftLocal) => {
    try {
      await upsertUpgrade({
        id: draft.id,
        catalogue_id: catalogueId,
        code: draft.code.trim(),
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        display_position: draft.display_position,
        sort_order: parseInt(draft.sort_order, 10) || 0,
        active: draft.active,
        price: parseFloat(draft.price),
        both_arches_price:
          archEnabled && draft.both_arches_price.trim() !== ''
            ? parseFloat(draft.both_arches_price)
            : null,
      });
      setEditingId(null);
      setAdding(false);
      refresh();
      setToast({ tone: 'success', title: draft.id ? 'Saved.' : 'Added.' });
    } catch (e) {
      setToast({
        tone: 'error',
        title: 'Save failed',
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const onToggleActive = async (row: UpgradeRow) => {
    setBusyId(row.id);
    try {
      await setUpgradeActive(row.id, !row.active);
      refresh();
    } catch (e) {
      setToast({
        tone: 'error',
        title: 'Could not toggle active',
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusyId(null);
    }
  };

  const onDelete = async (row: UpgradeRow) => {
    setBusyId(row.id);
    try {
      await deleteUpgrade(row.id);
      refresh();
      setToast({ tone: 'success', title: 'Removed.' });
    } catch (e) {
      setToast({
        tone: 'error',
        title: 'Could not remove',
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section
      style={{
        borderTop: `1px solid ${theme.color.border}`,
        paddingTop: theme.space[4],
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[3],
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: theme.space[3], flexWrap: 'wrap' }}>
        <div>
          <h3
            style={{
              margin: 0,
              fontSize: theme.type.size.base,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
            }}
          >
            Upgrades
          </h3>
          <p
            style={{
              margin: `${theme.space[1]}px 0 0`,
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
            }}
          >
            Add the upgrades patients can pick on this product.
            {archEnabled
              ? ' Both-arches price applies when the receptionist picks both arches.'
              : ''}
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setAdding(true)} disabled={adding}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
            <Plus size={16} /> Add upgrade
          </span>
        </Button>
      </div>

      {error ? (
        <p style={{ color: theme.color.alert, margin: 0, fontSize: theme.type.size.sm }}>
          Could not load upgrades: {error}
        </p>
      ) : loading ? (
        <Skeleton height={64} radius={12} />
      ) : (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: theme.space[2],
          }}
        >
          {rows.map((row) =>
            editingId === row.id ? (
              <li key={row.id}>
                <UpgradeEditor
                  initial={draftFromUpgrade(row)}
                  archEnabled={archEnabled}
                  onSave={onSave}
                  onCancel={() => setEditingId(null)}
                />
              </li>
            ) : (
              <UpgradeDisplayRow
                key={row.id}
                row={row}
                archEnabled={archEnabled}
                busy={busyId === row.id}
                onEdit={() => setEditingId(row.id)}
                onToggleActive={() => onToggleActive(row)}
                onDelete={() => onDelete(row)}
              />
            )
          )}
          {adding ? (
            <li>
              <UpgradeEditor
                initial={emptyUpgradeDraft()}
                archEnabled={archEnabled}
                onSave={onSave}
                onCancel={() => setAdding(false)}
              />
            </li>
          ) : null}
          {!adding && rows.length === 0 ? (
            <li>
              <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted, fontStyle: 'italic' }}>
                No upgrades on this product yet. Tap Add upgrade.
              </p>
            </li>
          ) : null}
        </ul>
      )}

      {toast ? (
        <div style={{ position: 'fixed', bottom: theme.space[6], left: '50%', transform: 'translateX(-50%)', zIndex: 100 }}>
          <Toast
            tone={toast.tone}
            title={toast.title}
            description={toast.description}
            duration={4000}
            onDismiss={() => setToast(null)}
          />
        </div>
      ) : null}
    </section>
  );
}

interface UpgradeDraftLocal {
  id?: string;
  code: string;
  name: string;
  description: string;
  display_position: UpgradeDisplayPosition;
  sort_order: string;
  active: boolean;
  price: string;
  both_arches_price: string;
}

function emptyUpgradeDraft(): UpgradeDraftLocal {
  return {
    code: '',
    name: '',
    description: '',
    display_position: 'after_device',
    sort_order: '0',
    active: true,
    price: '',
    both_arches_price: '',
  };
}

function draftFromUpgrade(row: UpgradeRow): UpgradeDraftLocal {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description ?? '',
    display_position: row.display_position,
    sort_order: String(row.sort_order),
    active: row.active,
    price: row.price.toFixed(2),
    both_arches_price: row.both_arches_price != null ? row.both_arches_price.toFixed(2) : '',
  };
}

const UPGRADE_DISPLAY_POSITION_OPTIONS: ReadonlyArray<{ value: UpgradeDisplayPosition; label: string }> = [
  { value: 'before_device', label: 'Before device name (e.g. "Scalloped Denture")' },
  { value: 'after_device', label: 'After device name (e.g. "Denture, scalloped")' },
  { value: 'own_line', label: 'On its own line' },
];

function UpgradeDisplayRow({
  row,
  archEnabled,
  busy,
  onEdit,
  onToggleActive,
  onDelete,
}: {
  row: UpgradeRow;
  archEnabled: boolean;
  busy: boolean;
  onEdit: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
}) {
  const priceLabel = `£${row.price.toFixed(2)}`;
  const bothLabel =
    archEnabled && row.both_arches_price != null ? `£${row.both_arches_price.toFixed(2)} both` : null;
  return (
    <li
      style={{
        border: `1px solid ${theme.color.border}`,
        borderRadius: 14,
        padding: theme.space[4],
        background: row.active ? theme.color.surface : 'rgba(14, 20, 20, 0.02)',
        display: 'flex',
        alignItems: 'flex-start',
        gap: theme.space[3],
        opacity: row.active ? 1 : 0.7,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: theme.space[2], flexWrap: 'wrap' }}>
          <span style={{ fontWeight: theme.type.weight.semibold, fontSize: theme.type.size.base, color: theme.color.ink }}>
            {row.name}
          </span>
          <span style={{ color: theme.color.inkSubtle, fontSize: theme.type.size.xs, fontFamily: 'monospace' }}>
            {row.code}
          </span>
          {!row.active ? (
            <StatusPill tone="cancelled" size="sm">
              Inactive
            </StatusPill>
          ) : null}
        </div>
        <div style={{ display: 'flex', gap: theme.space[3], flexWrap: 'wrap', marginTop: theme.space[1] }}>
          <span style={{ color: theme.color.ink, fontSize: theme.type.size.sm, fontVariantNumeric: 'tabular-nums' }}>
            {priceLabel}
          </span>
          {bothLabel ? (
            <span style={{ color: theme.color.inkMuted, fontSize: theme.type.size.sm, fontVariantNumeric: 'tabular-nums' }}>
              {bothLabel}
            </span>
          ) : null}
        </div>
        {row.description ? (
          <p style={{ margin: `${theme.space[1]}px 0 0`, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
            {row.description}
          </p>
        ) : null}
      </div>
      <div style={{ display: 'flex', gap: theme.space[1], flexShrink: 0 }}>
        <Button variant="tertiary" size="sm" onClick={onToggleActive} disabled={busy}>
          {row.active ? 'Deactivate' : 'Reactivate'}
        </Button>
        <Button variant="tertiary" size="sm" onClick={onDelete} disabled={busy}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: theme.color.alert }}>
            <X size={14} /> Delete
          </span>
        </Button>
        <Button variant="secondary" size="sm" onClick={onEdit} disabled={busy}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Pencil size={14} /> Edit
          </span>
        </Button>
      </div>
    </li>
  );
}

function UpgradeEditor({
  initial,
  archEnabled,
  onSave,
  onCancel,
}: {
  initial: UpgradeDraftLocal;
  archEnabled: boolean;
  onSave: (draft: UpgradeDraftLocal) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<UpgradeDraftLocal>(initial);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof UpgradeDraftLocal>(k: K, v: UpgradeDraftLocal[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const priceValid = draft.price.trim() !== '' && !Number.isNaN(parseFloat(draft.price));
  const bothValid =
    !archEnabled ||
    draft.both_arches_price.trim() === '' ||
    !Number.isNaN(parseFloat(draft.both_arches_price));
  const canSubmit = draft.code.trim() !== '' && draft.name.trim() !== '' && priceValid && bothValid;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await onSave(draft);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        border: `1px solid ${theme.color.ink}`,
        borderRadius: 14,
        padding: theme.space[4],
        background: theme.color.surface,
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[3],
      }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: theme.space[3] }}>
        <Input label="Code" value={draft.code} onChange={(e) => set('code', e.target.value)} placeholder="e.g. scalloped" />
        <Input label="Name" value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Scalloped" />
      </div>
      <Input
        label="Description"
        value={draft.description}
        onChange={(e) => set('description', e.target.value)}
        placeholder="optional, shown to staff in the picker"
      />
      <DropdownSelect<UpgradeDisplayPosition>
        label="Display position"
        value={draft.display_position}
        options={UPGRADE_DISPLAY_POSITION_OPTIONS}
        onChange={(v) => set('display_position', v)}
      />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: archEnabled ? '1fr 1fr' : '1fr',
          gap: theme.space[3],
        }}
      >
        <Input
          label="Price (£)"
          numericFormat="currency"
          value={draft.price}
          onChange={(e) => set('price', e.target.value)}
        />
        {archEnabled ? (
          <Input
            label="Both arches price (£)"
            numericFormat="currency"
            value={draft.both_arches_price}
            onChange={(e) => set('both_arches_price', e.target.value)}
            placeholder="optional"
          />
        ) : null}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[4], flexWrap: 'wrap' }}>
        <Input
          label="Sort order"
          numericFormat="integer"
          value={draft.sort_order}
          onChange={(e) => set('sort_order', e.target.value)}
          style={{ maxWidth: 140 }}
        />
        <Checkbox checked={draft.active} onChange={(v) => set('active', v)} label="Active" />
      </div>
      <div style={{ display: 'flex', gap: theme.space[2], justifyContent: 'flex-end', marginTop: theme.space[2] }}>
        <Button variant="tertiary" onClick={onCancel} disabled={busy}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <X size={16} /> Cancel
          </span>
        </Button>
        <Button variant="primary" onClick={submit} loading={busy} disabled={!canSubmit}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Check size={16} /> {draft.id ? 'Save' : 'Add'}
          </span>
        </Button>
      </div>
    </div>
  );
}

function groupByCategory(rows: CatalogueRow[]): Array<[string, CatalogueRow[]]> {
  const map = new Map<string, CatalogueRow[]>();
  for (const r of rows) {
    const list = map.get(r.category) ?? [];
    list.push(r);
    map.set(r.category, list);
  }
  return [...map.entries()];
}

// Square thumbnail with a rounded clip + subtle border. Falls back to a
// Package glyph on a tinted background when there's no image — keeps
// every catalogue row visually balanced regardless of image state.
function CatalogueThumbnail({
  src,
  alt,
  size,
}: {
  src: string | null;
  alt: string;
  size: number;
}) {
  return (
    <div
      style={{
        flexShrink: 0,
        width: size,
        height: size,
        borderRadius: 12,
        overflow: 'hidden',
        background: src ? theme.color.surface : 'rgba(14, 20, 20, 0.04)',
        border: `1px solid ${theme.color.border}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: theme.color.inkSubtle,
      }}
    >
      {src ? (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          onError={(e) => {
            // Hide the <img> if it fails to load; the surrounding tile's
            // tinted background + Package glyph (rendered alongside) takes
            // over. Cheap fallback that survives a stale URL.
            (e.currentTarget as HTMLElement).style.display = 'none';
          }}
        />
      ) : (
        <Package size={Math.round(size * 0.4)} aria-hidden />
      )}
    </div>
  );
}

// ---------- Waivers tab ----------
//
// CRUD over lng_waiver_sections so legal can edit terms / bump versions
// without writing SQL. Per-section versioning means bumping a version
// invalidates every existing signature against that section on the
// patient's next visit — that's by design (a "needs re-signing" banner
// will fire at the BottomSheet). terms_snapshot on lng_waiver_signatures
// preserves the exact text agreed to before the bump.

function WaiversTab() {
  const { sections, loading, error, refresh } = useAdminWaiverSections();
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; title: string; description?: string } | null>(null);

  const onSave = async (draft: WaiverSectionDraft) => {
    try {
      await upsertWaiverSection(draft);
      setEditingKey(null);
      setAdding(false);
      refresh();
      setToast({ tone: 'success', title: 'Saved.' });
    } catch (e) {
      setToast({
        tone: 'error',
        title: 'Save failed',
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <Card padding="lg">
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: theme.space[3],
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
              <FileSignature size={20} /> Waiver sections
            </span>
          </h2>
          <p style={{ margin: `${theme.space[2]}px 0 0`, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
            Edit the terms patients sign at arrival. Each section has its own version. Bumping a version flips every existing signature on that section to "needs re-signing" on the next visit. <strong>The exact text shown at sign time is preserved on the signature row</strong>, so prior agreements remain auditable.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setAdding(true)} disabled={adding}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
            <Plus size={16} /> Add section
          </span>
        </Button>
      </div>

      <div style={{ height: 1, background: theme.color.border, margin: `${theme.space[5]}px 0` }} />

      {error ? (
        <p style={{ color: theme.color.alert, margin: 0 }}>Could not load sections: {error}</p>
      ) : loading ? (
        <Skeleton height={120} radius={12} />
      ) : adding ? (
        <WaiverSectionEditor
          initial={emptyWaiverDraft()}
          isNew
          existingKeys={sections.map((s) => s.key)}
          onSave={onSave}
          onCancel={() => setAdding(false)}
        />
      ) : sections.length === 0 ? (
        <EmptyState
          icon={<FileSignature size={20} />}
          title="No sections yet"
          description="Tap Add section to seed the waiver."
        />
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
          {sections.map((s) =>
            editingKey === s.key ? (
              <li key={s.key}>
                <WaiverSectionEditor
                  initial={waiverDraftFromSection(s)}
                  isNew={false}
                  existingKeys={sections.map((x) => x.key)}
                  onSave={onSave}
                  onCancel={() => setEditingKey(null)}
                />
              </li>
            ) : (
              <WaiverSectionDisplay key={s.key} section={s} onEdit={() => setEditingKey(s.key)} />
            )
          )}
        </ul>
      )}

      {toast ? (
        <div style={{ position: 'fixed', bottom: theme.space[6], left: '50%', transform: 'translateX(-50%)', zIndex: 100 }}>
          <Toast tone={toast.tone} title={toast.title} description={toast.description} duration={4000} onDismiss={() => setToast(null)} />
        </div>
      ) : null}
    </Card>
  );
}

function WaiverSectionDisplay({ section, onEdit }: { section: WaiverSection; onEdit: () => void }) {
  const scope = serviceTypeScope(section.applies_to_service_type);
  return (
    <li
      style={{
        border: `1px solid ${theme.color.border}`,
        borderRadius: 14,
        padding: theme.space[4],
        background: section.active ? theme.color.surface : 'rgba(14, 20, 20, 0.02)',
        opacity: section.active ? 1 : 0.65,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: theme.space[3], flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: theme.space[2], flexWrap: 'wrap' }}>
            <span style={{ fontSize: theme.type.size.base, fontWeight: theme.type.weight.semibold, color: theme.color.ink }}>
              {section.title}
            </span>
            <span style={{ fontSize: theme.type.size.xs, fontFamily: 'ui-monospace, monospace', color: theme.color.inkSubtle }}>
              {section.key}
            </span>
            {!section.active ? (
              <StatusPill tone="cancelled" size="sm">Inactive</StatusPill>
            ) : null}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[3], marginTop: theme.space[2], flexWrap: 'wrap', fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
            <span>Version <strong style={{ color: theme.color.ink, fontFamily: 'ui-monospace, monospace' }}>{section.version}</strong></span>
            <span>·</span>
            <span>Scope: {scope}</span>
            <span>·</span>
            <span>Sort {section.sort_order}</span>
            <span>·</span>
            <span>{section.terms.length} {section.terms.length === 1 ? 'paragraph' : 'paragraphs'}</span>
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={onEdit}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Pencil size={14} /> Edit
          </span>
        </Button>
      </div>

      <ol
        style={{
          margin: `${theme.space[4]}px 0 0`,
          padding: `0 0 0 ${theme.space[5]}px`,
          color: theme.color.inkMuted,
          fontSize: theme.type.size.sm,
          lineHeight: theme.type.leading.relaxed,
          display: 'flex',
          flexDirection: 'column',
          gap: theme.space[2],
        }}
      >
        {section.terms.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ol>
    </li>
  );
}

function WaiverSectionEditor({
  initial,
  isNew,
  existingKeys,
  onSave,
  onCancel,
}: {
  initial: WaiverDraftState;
  isNew: boolean;
  existingKeys: string[];
  onSave: (draft: WaiverSectionDraft) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<WaiverDraftState>(initial);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof WaiverDraftState>(k: K, v: WaiverDraftState[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const termsChanged =
    JSON.stringify(initial.terms) !== JSON.stringify(draft.terms) ||
    initial.title !== draft.title;
  const versionChanged = initial.version !== draft.version;
  const needsBump = !isNew && termsChanged && !versionChanged;
  const suggested = suggestNextVersion(initial.version || draft.version);

  // Validation
  const trimmedKey = draft.key.trim();
  const keyError = isNew
    ? !trimmedKey
      ? 'Key required'
      : !/^[a-z0-9_]+$/.test(trimmedKey)
        ? 'Lowercase letters, numbers, underscores only'
        : existingKeys.includes(trimmedKey)
          ? 'Key already exists'
          : null
    : null;
  const titleError = !draft.title.trim() ? 'Title required' : null;
  const versionError = !draft.version.trim() ? 'Version required' : null;
  const termsError = draft.terms.every((t) => !t.trim()) ? 'At least one paragraph' : null;
  const hasError = !!(keyError || titleError || versionError || termsError);

  const submit = async () => {
    if (hasError) return;
    if (needsBump) {
      const ok = confirm(
        `You changed the terms but not the version. Existing signatures will keep counting as current — patients won't be asked to re-sign.\n\nSuggested new version: ${suggested}\n\nClick OK to save anyway. Cancel to bump the version first.`
      );
      if (!ok) return;
    }
    setBusy(true);
    try {
      await onSave({
        key: trimmedKey,
        title: draft.title.trim(),
        terms: draft.terms,
        version: draft.version.trim(),
        applies_to_service_type: draft.applies_to_service_type,
        sort_order: draft.sort_order,
        active: draft.active,
      });
    } finally {
      setBusy(false);
    }
  };

  const updateTerm = (i: number, value: string) =>
    setDraft((d) => ({ ...d, terms: d.terms.map((t, idx) => (idx === i ? value : t)) }));

  const removeTerm = (i: number) =>
    setDraft((d) => ({ ...d, terms: d.terms.filter((_, idx) => idx !== i) }));

  const addTerm = () => setDraft((d) => ({ ...d, terms: [...d.terms, ''] }));

  const moveTerm = (i: number, dir: -1 | 1) => {
    setDraft((d) => {
      const next = [...d.terms];
      const j = i + dir;
      if (j < 0 || j >= next.length) return d;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return { ...d, terms: next };
    });
  };

  return (
    <div
      style={{
        border: `1px solid ${theme.color.ink}`,
        borderRadius: 14,
        padding: theme.space[4],
        background: theme.color.surface,
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[4],
      }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: theme.space[3] }}>
        {isNew ? (
          <Input
            label="Section key (immutable)"
            value={draft.key}
            onChange={(e) => set('key', e.target.value)}
            placeholder="e.g. emergency_consent"
            error={keyError ?? undefined}
          />
        ) : (
          <div>
            <span
              style={{
                display: 'block',
                fontSize: theme.type.size.xs,
                color: theme.color.inkMuted,
                fontWeight: theme.type.weight.medium,
                marginBottom: theme.space[1],
              }}
            >
              Section key
            </span>
            <code
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                height: theme.layout.inputHeight,
                padding: `0 ${theme.space[3]}px`,
                background: theme.color.bg,
                border: `1px solid ${theme.color.border}`,
                borderRadius: theme.radius.input,
                fontSize: theme.type.size.sm,
                color: theme.color.inkMuted,
              }}
            >
              {draft.key}
            </code>
          </div>
        )}
        <Input
          label="Title (shown to patient)"
          value={draft.title}
          onChange={(e) => set('title', e.target.value)}
          placeholder="e.g. Privacy and consent"
          error={titleError ?? undefined}
        />
      </div>

      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: theme.space[2] }}>
          <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkMuted, fontWeight: theme.type.weight.medium }}>
            Terms (one paragraph per row)
          </span>
          {termsError ? (
            <span style={{ fontSize: theme.type.size.xs, color: theme.color.alert }}>{termsError}</span>
          ) : null}
        </div>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
          {draft.terms.map((term, i) => (
            <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: theme.space[2] }}>
              <span
                aria-hidden
                style={{
                  flexShrink: 0,
                  width: 24,
                  textAlign: 'right',
                  paddingTop: 10,
                  fontSize: theme.type.size.xs,
                  color: theme.color.inkSubtle,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {i + 1}.
              </span>
              <textarea
                value={term}
                onChange={(e) => updateTerm(i, e.target.value)}
                rows={Math.max(2, Math.ceil(term.length / 80))}
                style={{
                  flex: 1,
                  resize: 'vertical',
                  minHeight: 56,
                  padding: theme.space[3],
                  fontFamily: 'inherit',
                  fontSize: theme.type.size.sm,
                  lineHeight: theme.type.leading.relaxed,
                  border: `1px solid ${theme.color.border}`,
                  borderRadius: theme.radius.input,
                  background: theme.color.surface,
                  color: theme.color.ink,
                }}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 4 }}>
                <IconButton ariaLabel="Move up" disabled={i === 0} onClick={() => moveTerm(i, -1)}>
                  <ArrowUp size={14} />
                </IconButton>
                <IconButton ariaLabel="Move down" disabled={i === draft.terms.length - 1} onClick={() => moveTerm(i, 1)}>
                  <ArrowDown size={14} />
                </IconButton>
                <IconButton ariaLabel="Remove paragraph" disabled={draft.terms.length <= 1} onClick={() => removeTerm(i)}>
                  <Trash2 size={14} />
                </IconButton>
              </div>
            </li>
          ))}
        </ul>
        <Button variant="tertiary" size="sm" onClick={addTerm} style={{ marginTop: theme.space[2] }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Plus size={14} /> Add paragraph
          </span>
        </Button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: theme.space[3], alignItems: 'end' }}>
        <Input
          label="Version"
          value={draft.version}
          onChange={(e) => set('version', e.target.value)}
          placeholder="2026-04-28-v1"
          error={versionError ?? undefined}
        />
        <Button
          variant="tertiary"
          size="sm"
          onClick={() => set('version', suggested)}
          disabled={draft.version === suggested}
        >
          Bump to {suggested}
        </Button>
      </div>
      {needsBump ? (
        <p
          style={{
            margin: 0,
            padding: theme.space[3],
            background: 'rgba(245, 158, 11, 0.08)',
            border: '1px solid rgba(245, 158, 11, 0.3)',
            borderRadius: theme.radius.input,
            fontSize: theme.type.size.xs,
            color: theme.color.ink,
          }}
        >
          <strong>Heads up:</strong> you've changed the wording but kept the version. Existing signatures will keep counting as current — patients won't be asked to re-sign. Bump the version if this is a legally-meaningful change.
        </p>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: theme.space[3] }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: theme.space[1] }}>
          <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkMuted, fontWeight: theme.type.weight.medium }}>
            Applies to
          </span>
          <select
            value={draft.applies_to_service_type ?? ''}
            onChange={(e) => set('applies_to_service_type', (e.target.value || null) as WaiverSectionDraft['applies_to_service_type'])}
            style={{
              height: theme.layout.inputHeight,
              padding: `0 ${theme.space[3]}px`,
              fontSize: theme.type.size.base,
              fontFamily: 'inherit',
              border: `1px solid ${theme.color.border}`,
              borderRadius: theme.radius.input,
              background: theme.color.surface,
            }}
          >
            <option value="">Every patient (e.g. GDPR)</option>
            <option value="denture_repair">Denture repair</option>
            <option value="same_day_appliance">Same-day appliance</option>
            <option value="click_in_veneers">Click-in veneers</option>
            <option value="impression_appointment">Impression appointment</option>
          </select>
        </label>
        <Input
          label="Sort order"
          numericFormat="integer"
          value={String(draft.sort_order)}
          onChange={(e) => set('sort_order', parseInt(e.target.value, 10) || 0)}
        />
      </div>

      <Checkbox
        checked={draft.active}
        onChange={(v) => set('active', v)}
        label="Active (shown to patients)"
      />

      <div style={{ display: 'flex', gap: theme.space[2], justifyContent: 'flex-end' }}>
        <Button variant="tertiary" onClick={onCancel} disabled={busy}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <X size={16} /> Cancel
          </span>
        </Button>
        <Button variant="primary" onClick={submit} loading={busy} disabled={hasError}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Check size={16} /> Save
          </span>
        </Button>
      </div>
    </div>
  );
}

function IconButton({
  children,
  onClick,
  ariaLabel,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      disabled={disabled}
      style={{
        appearance: 'none',
        width: 28,
        height: 28,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: `1px solid ${theme.color.border}`,
        borderRadius: 6,
        background: theme.color.surface,
        color: disabled ? theme.color.inkSubtle : theme.color.inkMuted,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {children}
    </button>
  );
}

interface WaiverDraftState {
  key: string;
  title: string;
  terms: string[];
  version: string;
  applies_to_service_type: WaiverSection['applies_to_service_type'];
  sort_order: number;
  active: boolean;
}

function emptyWaiverDraft(): WaiverDraftState {
  return {
    key: '',
    title: '',
    terms: [''],
    version: suggestNextVersion(''),
    applies_to_service_type: null,
    sort_order: 100,
    active: true,
  };
}

function waiverDraftFromSection(s: WaiverSection): WaiverDraftState {
  return {
    key: s.key,
    title: s.title,
    terms: [...s.terms],
    version: s.version,
    applies_to_service_type: s.applies_to_service_type,
    sort_order: s.sort_order,
    active: s.active,
  };
}

function serviceTypeScope(s: WaiverSection['applies_to_service_type']): string {
  if (s === null) return 'Every patient';
  if (s === 'denture_repair') return 'Denture repair';
  if (s === 'same_day_appliance') return 'Same-day appliance';
  if (s === 'click_in_veneers') return 'Click-in veneers';
  if (s === 'impression_appointment') return 'Impression appointment';
  return s;
}
