import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { AlertTriangle, ArrowDown, ArrowUp, BarChart3, CalendarCheck, Check, CreditCard, FileSignature, FlaskConical, Mail, Package, Pencil, Plus, RefreshCw, RotateCcw, ShieldAlert, Sparkles, Trash2, Users, X } from 'lucide-react';
import {
  Button,
  Card,
  EmptyState,
  Input,
  SegmentedControl,
  Skeleton,
  StatusPill,
  Toast,
} from '../components/index.ts';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../components/KioskStatusBar/KioskStatusBar.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useIsMobile } from '../lib/useIsMobile.ts';
import { useTerminalReaders } from '../lib/queries/terminalReaders.ts';
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
import { formatPence } from '../lib/queries/carts.ts';
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
  suggestNextVersion,
  upsertWaiverSection,
  useAdminWaiverSections,
  type WaiverSection,
  type WaiverSectionDraft,
} from '../lib/queries/waiver.ts';
import {
  removeUpgradeLink,
  setUpgradeActive,
  setUpgradeLink,
  upsertUpgrade,
  useUpgradeLinksForCatalogue,
  useUpgradesActive,
  useUpgradesAll,
  type UpgradeRow,
} from '../lib/queries/upgrades.ts';
import { supabase } from '../lib/supabase.ts';

type Tab = 'devices' | 'failures' | 'reports' | 'calendly' | 'catalogue' | 'receipts' | 'testing' | 'waivers' | 'upgrades';

export function Admin() {
  const { user, loading: authLoading } = useAuth();
  const isMobile = useIsMobile(640);
  const [tab, setTab] = useState<Tab>('calendly');

  if (authLoading) return null;
  if (!user) return <Navigate to="/sign-in" replace />;

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

        <div style={{ marginBottom: theme.space[5], overflowX: 'auto' }}>
          <SegmentedControl<Tab>
            value={tab}
            onChange={setTab}
            options={[
              { value: 'calendly', label: 'Calendly' },
              { value: 'catalogue', label: 'Catalogue' },
              { value: 'upgrades', label: 'Upgrades' },
              { value: 'waivers', label: 'Waivers' },
              { value: 'receipts', label: 'Receipts' },
              { value: 'reports', label: 'Reports' },
              { value: 'devices', label: 'Devices' },
              { value: 'failures', label: 'Failures' },
              { value: 'testing', label: 'Testing' },
            ]}
          />
        </div>

        {tab === 'calendly' ? (
          <CalendlyTab />
        ) : tab === 'catalogue' ? (
          <CatalogueTab />
        ) : tab === 'upgrades' ? (
          <UpgradesTab />
        ) : tab === 'waivers' ? (
          <WaiversTab />
        ) : tab === 'receipts' ? (
          <ReceiptsTab />
        ) : tab === 'reports' ? (
          <ReportsTab />
        ) : tab === 'devices' ? (
          <DevicesTab />
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
            <DiagTile label="Webhook deliveries" value={String(d.deliveriesTotal)} />
            <DiagTile label="Processed" value={String(d.deliveriesProcessed)} />
            <DiagTile label="Failed" value={String(d.deliveriesFailed)} tone={d.deliveriesFailed > 0 ? 'alert' : 'normal'} />
            <DiagTile label="Calendly appts" value={String(d.lngAppointmentsCalendly)} />
            <DiagTile label="Errors (24h)" value={String(d.recentFailures)} tone={d.recentFailures > 0 ? 'alert' : 'normal'} />
            <DiagTile
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

function DiagTile({ label, value, tone = 'normal' }: { label: string; value: string; tone?: 'normal' | 'alert' }) {
  return (
    <div
      style={{
        background: theme.color.surface,
        borderRadius: theme.radius.card,
        padding: theme.space[4],
        boxShadow: theme.shadow.card,
      }}
    >
      <span
        style={{
          fontSize: theme.type.size.xs,
          color: theme.color.inkMuted,
          fontWeight: theme.type.weight.medium,
          textTransform: 'uppercase',
          letterSpacing: theme.type.tracking.wide,
        }}
      >
        {label}
      </span>
      <p
        style={{
          margin: `${theme.space[2]}px 0 0`,
          fontSize: theme.type.size.lg,
          fontWeight: theme.type.weight.semibold,
          color: tone === 'alert' ? theme.color.alert : theme.color.ink,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </p>
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <Card padding="lg">
        <h2 style={{ margin: 0, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold }}>
          Card readers
        </h2>
        <p style={{ margin: `${theme.space[2]}px 0 ${theme.space[5]}px`, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
          Stripe Terminal readers visible to your location. Add via INSERT into lng_terminal_readers after registering in Stripe Dashboard.
        </p>
        {readers.loading ? (
          <Skeleton height={64} />
        ) : readers.data.length === 0 ? (
          <EmptyState
            icon={<CreditCard size={20} />}
            title="No readers yet"
            description="Activate Terminal in Stripe Dashboard, register a Simulated WisePOS E or your S700, then INSERT into lng_terminal_readers."
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

function CatalogueTab() {
  const { rows, loading, error, refresh } = useCatalogueAll();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; title: string; description?: string } | null>(null);

  const grouped = groupByCategory(rows);

  const onSave = async (draft: CatalogueDraft) => {
    try {
      await upsertCatalogueRow({
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
        sort_order: parseInt(draft.sort_order, 10) || 0,
        active: draft.active,
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
            Product catalogue
          </h2>
          <p
            style={{
              margin: `${theme.space[1]}px 0 0`,
              color: theme.color.inkMuted,
              fontSize: theme.type.size.sm,
            }}
          >
            Shared with Checkpoint. Edits land in <code>lwo_catalogue</code>; line-item prices snapshot at insert.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setAdding(true)} disabled={adding}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
            <Plus size={16} /> Add product
          </span>
        </Button>
      </div>

      {error ? (
        <p style={{ color: theme.color.alert, margin: 0 }}>Could not load catalogue: {error}</p>
      ) : loading ? (
        <Skeleton height={120} radius={12} />
      ) : adding ? (
        <CatalogueRowEditor
          initial={emptyDraft()}
          onSave={onSave}
          onCancel={() => setAdding(false)}
        />
      ) : grouped.length === 0 ? (
        <EmptyState
          icon={<Package size={24} />}
          title="No products yet"
          description="Tap Add product to seed the catalogue."
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
          {grouped.map(([category, catRows]) => (
            <div key={category}>
              <h3
                style={{
                  margin: `0 0 ${theme.space[2]}px`,
                  fontSize: theme.type.size.xs,
                  fontWeight: theme.type.weight.semibold,
                  color: theme.color.inkSubtle,
                  textTransform: 'uppercase',
                  letterSpacing: theme.type.tracking.wide,
                }}
              >
                {category}
              </h3>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
                {catRows.map((row) =>
                  editingId === row.id ? (
                    <li key={row.id}>
                      <CatalogueRowEditor
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
                  )
                )}
              </ul>
            </div>
          ))}
        </div>
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
  sort_order: string;
  active: boolean;
}

function emptyDraft(): CatalogueDraft {
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
    is_service: false,
    quantity_enabled: true,
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
          £{row.unit_price.toFixed(2)}
          {row.extra_unit_price != null ? ` (extras £${row.extra_unit_price.toFixed(2)})` : ''}
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
  initial,
  onSave,
  onCancel,
}: {
  initial: CatalogueDraft;
  onSave: (draft: CatalogueDraft) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<CatalogueDraft>(initial);
  const [busy, setBusy] = useState(false);
  const [imgBusy, setImgBusy] = useState(false);
  const [imgError, setImgError] = useState<string | null>(null);
  const set = <K extends keyof CatalogueDraft>(k: K, v: CatalogueDraft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const submit = async () => {
    if (!draft.code.trim() || !draft.name.trim() || !draft.category.trim()) return;
    setBusy(true);
    try {
      await onSave(draft);
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
          inputMode="decimal"
          value={draft.unit_price}
          onChange={(e) => set('unit_price', e.target.value)}
        />
        <Input
          label="Extras price (£)"
          inputMode="decimal"
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
      {draft.arch_match !== 'any' ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: theme.space[3] }}>
          <Input
            label="Both arches price (£)"
            inputMode="decimal"
            value={draft.both_arches_price}
            onChange={(e) => set('both_arches_price', e.target.value)}
            placeholder="optional, picker uses unit price when blank"
          />
          <span />
        </div>
      ) : null}
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
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[4], flexWrap: 'wrap' }}>
        <Input
          label="Sort order"
          inputMode="numeric"
          value={draft.sort_order}
          onChange={(e) => set('sort_order', e.target.value)}
          style={{ maxWidth: 140 }}
        />
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: theme.space[2],
            fontSize: theme.type.size.sm,
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={draft.active}
            onChange={(e) => set('active', e.target.checked)}
            style={{ width: 18, height: 18 }}
          />
          Active (visible to receptionist)
        </label>
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: theme.space[2],
            fontSize: theme.type.size.sm,
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={draft.is_service}
            onChange={(e) => set('is_service', e.target.checked)}
            style={{ width: 18, height: 18 }}
          />
          This is a service (sits in Services bucket in the picker)
        </label>
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: theme.space[2],
            fontSize: theme.type.size.sm,
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={draft.quantity_enabled}
            onChange={(e) => set('quantity_enabled', e.target.checked)}
            style={{ width: 18, height: 18 }}
          />
          Quantity selector (uncheck for one-shot services like in-clinic appointments)
        </label>
      </div>
      {draft.id ? (
        <UpgradeLinksEditor
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
// Upgrade links subsection — sits inside CatalogueRowEditor when editing
// an existing product. Each active upgrade gets a row: checkbox, price
// input, and (when the parent product has arch options) a both-arches
// price. Per-link save: each row commits independently so a network
// blip on one upgrade can't lose another's price.
// ─────────────────────────────────────────────────────────────────────────────

function UpgradeLinksEditor({
  catalogueId,
  archEnabled,
}: {
  catalogueId: string;
  archEnabled: boolean;
}) {
  const { rows: upgrades, loading: upLoading } = useUpgradesActive();
  const { links, loading: linkLoading, refresh } = useUpgradeLinksForCatalogue(catalogueId);

  const linkByUpgrade = new Map(links.map((l) => [l.upgrade_id, l]));

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
      <div>
        <h3
          style={{
            margin: 0,
            fontSize: theme.type.size.xs,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.inkSubtle,
            textTransform: 'uppercase',
            letterSpacing: theme.type.tracking.wide,
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
          Tick the upgrades you want available on this product, then set the price.
          {archEnabled
            ? ' Both-arches price is used when the receptionist picks both arches.'
            : ''}
        </p>
      </div>

      {upLoading || linkLoading ? (
        <Skeleton height={48} radius={12} />
      ) : upgrades.length === 0 ? (
        <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted, fontStyle: 'italic' }}>
          No upgrades defined yet. Add some in the Upgrades tab.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
          {upgrades.map((u) => (
            <li key={u.id}>
              <UpgradeLinkRow
                upgrade={u}
                link={linkByUpgrade.get(u.id) ?? null}
                archEnabled={archEnabled}
                onSave={async (price, bothArches) => {
                  await setUpgradeLink(catalogueId, u.id, price, bothArches);
                  refresh();
                }}
                onRemove={async () => {
                  await removeUpgradeLink(catalogueId, u.id);
                  refresh();
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function UpgradeLinkRow({
  upgrade,
  link,
  archEnabled,
  onSave,
  onRemove,
}: {
  upgrade: UpgradeRow;
  link: { price: number; both_arches_price: number | null } | null;
  archEnabled: boolean;
  onSave: (price: number, bothArchesPrice: number | null) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [linked, setLinked] = useState(link != null);
  const [price, setPrice] = useState(link != null ? link.price.toFixed(2) : '');
  const [bothArches, setBothArches] = useState(
    link?.both_arches_price != null ? link.both_arches_price.toFixed(2) : ''
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-sync local state when the link changes underneath (e.g. after a
  // sibling row's refresh re-fetches the list).
  useEffect(() => {
    setLinked(link != null);
    setPrice(link != null ? link.price.toFixed(2) : '');
    setBothArches(link?.both_arches_price != null ? link.both_arches_price.toFixed(2) : '');
  }, [link]);

  const onToggle = async (checked: boolean) => {
    setError(null);
    if (!checked && link) {
      setBusy(true);
      try {
        await onRemove();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not remove');
        setLinked(true);
      } finally {
        setBusy(false);
      }
      return;
    }
    setLinked(checked);
  };

  const dirty =
    linked &&
    (price.trim() !== (link != null ? link.price.toFixed(2) : '') ||
      bothArches.trim() !== (link?.both_arches_price != null ? link.both_arches_price.toFixed(2) : ''));

  const canSave =
    linked &&
    price.trim() !== '' &&
    !Number.isNaN(parseFloat(price)) &&
    (!archEnabled || bothArches.trim() === '' || !Number.isNaN(parseFloat(bothArches)));

  const submit = async () => {
    setError(null);
    if (!canSave) return;
    setBusy(true);
    try {
      const priceNum = parseFloat(price);
      const bothNum = archEnabled && bothArches.trim() ? parseFloat(bothArches) : null;
      await onSave(priceNum, bothNum);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        border: `1px solid ${theme.color.border}`,
        borderRadius: theme.radius.input,
        padding: theme.space[3],
        background: linked ? theme.color.surface : 'rgba(14, 20, 20, 0.02)',
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[2],
      }}
    >
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2], cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={linked}
          onChange={(e) => onToggle(e.target.checked)}
          disabled={busy}
          style={{ width: 18, height: 18 }}
        />
        <span style={{ fontWeight: theme.type.weight.medium, fontSize: theme.type.size.sm, color: theme.color.ink }}>
          {upgrade.name}
        </span>
        <code style={{ fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>{upgrade.code}</code>
      </label>
      {linked ? (
        <div style={{ display: 'flex', gap: theme.space[2], alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <Input
            label="Price (£)"
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            style={{ maxWidth: 140 }}
          />
          {archEnabled ? (
            <Input
              label="Both arches price (£)"
              inputMode="decimal"
              value={bothArches}
              onChange={(e) => setBothArches(e.target.value)}
              placeholder="optional"
              style={{ maxWidth: 200 }}
            />
          ) : null}
          <Button variant="secondary" size="sm" onClick={submit} loading={busy} disabled={!dirty || !canSave}>
            Save
          </Button>
        </div>
      ) : null}
      {error ? (
        <p style={{ margin: 0, color: theme.color.alert, fontSize: theme.type.size.xs }}>{error}</p>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Upgrades tab — CRUD for the lng_catalogue_upgrades registry.
// Pricing per-product lives on the link table (edited inside each
// catalogue row), so this tab just owns names + activity.
// ─────────────────────────────────────────────────────────────────────────────

function UpgradesTab() {
  const { rows, loading, error, refresh } = useUpgradesAll();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; title: string; description?: string } | null>(null);

  const onSave = async (draft: UpgradeDraft) => {
    try {
      await upsertUpgrade({
        id: draft.id,
        code: draft.code.trim(),
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        sort_order: parseInt(draft.sort_order, 10) || 0,
        active: draft.active,
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
    try {
      await setUpgradeActive(row.id, !row.active);
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
          <h2 style={{ margin: 0, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold }}>
            Upgrades
          </h2>
          <p style={{ margin: `${theme.space[1]}px 0 0`, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
            Pure registry. Per-product pricing is set inside each catalogue row, on the Upgrades subsection.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setAdding(true)} disabled={adding}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
            <Plus size={16} /> Add upgrade
          </span>
        </Button>
      </div>

      {error ? (
        <p style={{ color: theme.color.alert, margin: 0 }}>Could not load upgrades: {error}</p>
      ) : loading ? (
        <Skeleton height={120} radius={12} />
      ) : adding ? (
        <UpgradeEditor initial={emptyUpgradeDraft()} onSave={onSave} onCancel={() => setAdding(false)} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Sparkles size={24} />}
          title="No upgrades yet"
          description="Tap Add upgrade to define one (e.g. Scalloped)."
        />
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
          {rows.map((row) =>
            editingId === row.id ? (
              <li key={row.id}>
                <UpgradeEditor initial={draftFromUpgrade(row)} onSave={onSave} onCancel={() => setEditingId(null)} />
              </li>
            ) : (
              <UpgradeDisplayRow
                key={row.id}
                row={row}
                onEdit={() => setEditingId(row.id)}
                onToggleActive={() => onToggleActive(row)}
              />
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

interface UpgradeDraft {
  id?: string;
  code: string;
  name: string;
  description: string;
  sort_order: string;
  active: boolean;
}

function emptyUpgradeDraft(): UpgradeDraft {
  return { code: '', name: '', description: '', sort_order: '0', active: true };
}

function draftFromUpgrade(row: UpgradeRow): UpgradeDraft {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description ?? '',
    sort_order: String(row.sort_order),
    active: row.active,
  };
}

function UpgradeDisplayRow({
  row,
  onEdit,
  onToggleActive,
}: {
  row: UpgradeRow;
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
        {row.description ? (
          <p style={{ margin: `${theme.space[1]}px 0 0`, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
            {row.description}
          </p>
        ) : null}
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

function UpgradeEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: UpgradeDraft;
  onSave: (draft: UpgradeDraft) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<UpgradeDraft>(initial);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof UpgradeDraft>(k: K, v: UpgradeDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const submit = async () => {
    if (!draft.code.trim() || !draft.name.trim()) return;
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
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[4], flexWrap: 'wrap' }}>
        <Input
          label="Sort order"
          inputMode="numeric"
          value={draft.sort_order}
          onChange={(e) => set('sort_order', e.target.value)}
          style={{ maxWidth: 140 }}
        />
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: theme.space[2],
            fontSize: theme.type.size.sm,
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={draft.active}
            onChange={(e) => set('active', e.target.checked)}
            style={{ width: 18, height: 18 }}
          />
          Active
        </label>
      </div>
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
          inputMode="numeric"
          value={String(draft.sort_order)}
          onChange={(e) => set('sort_order', parseInt(e.target.value, 10) || 0)}
        />
      </div>

      <label
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: theme.space[2],
          fontSize: theme.type.size.sm,
          cursor: 'pointer',
        }}
      >
        <input
          type="checkbox"
          checked={draft.active}
          onChange={(e) => set('active', e.target.checked)}
          style={{ width: 18, height: 18 }}
        />
        Active (shown to patients)
      </label>

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
