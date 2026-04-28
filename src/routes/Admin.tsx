import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { AlertTriangle, BarChart3, CalendarCheck, Check, CreditCard, FlaskConical, Mail, Package, Pencil, Plus, RefreshCw, RotateCcw, ShieldAlert, Users, X } from 'lucide-react';
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
  setCatalogueActive,
  upsertCatalogueRow,
  useCatalogueAll,
  type ArchMatch,
} from '../lib/queries/catalogue.ts';
import { supabase } from '../lib/supabase.ts';

type Tab = 'devices' | 'failures' | 'reports' | 'calendly' | 'catalogue' | 'receipts' | 'testing';

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
      <div style={{ maxWidth: 880, margin: '0 auto' }}>
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
        unit_label: draft.unit_label.trim() || null,
        service_type: draft.service_type.trim() || null,
        product_key: draft.product_key.trim() || null,
        repair_variant: draft.repair_variant.trim() || null,
        arch_match: draft.arch_match,
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
  unit_label: string;
  service_type: string;
  product_key: string;
  repair_variant: string;
  arch_match: ArchMatch;
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
    unit_label: '',
    service_type: '',
    product_key: '',
    repair_variant: '',
    arch_match: 'any',
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
    unit_label: row.unit_label ?? '',
    service_type: row.service_type ?? '',
    product_key: row.product_key ?? '',
    repair_variant: row.repair_variant ?? '',
    arch_match: row.arch_match,
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
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: theme.space[3] }}>
        <Input
          label="Service type"
          value={draft.service_type}
          onChange={(e) => set('service_type', e.target.value)}
          placeholder="denture_repair / same_day_appliance / click_in_veneers"
        />
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
