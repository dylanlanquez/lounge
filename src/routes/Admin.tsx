import { type CSSProperties, Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ArchiveRestore, ArrowDown, ArrowUp, BarChart3, Briefcase, CalendarCheck, CalendarClock, Check, ChevronUp, Clock, CreditCard, FileSignature, FlaskConical, GripVertical, Image as ImageIcon, KeyRound, Layers, Mail, Package, Pencil, Plus, RefreshCw, Rocket, RotateCcw, Settings, Link2, ShieldAlert, ShieldCheck, Trash2, UserPlus, Users, Video, Wallet, X } from 'lucide-react';
import {
  Button,
  Card,
  Checkbox,
  DatePicker,
  DropdownSelect,
  EmptyState,
  FieldTrigger,
  Input,
  SegmentedControl,
  Skeleton,
  StatCard,
  StatusPill,
  TimePicker,
  Toast,
} from '../components/index.ts';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../components/KioskStatusBar/KioskStatusBar.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useIsMobile } from '../lib/useIsMobile.ts';
import { fmtTzAbbr } from '../lib/dateFormat.ts';
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
  inviteNewStaffMember,
  deactivateStaffMember,
  reactivateStaffMember,
  archiveStaffRole,
  createStaffRole,
  resetTwoFactor,
  resendStaffInvite,
  getStaffInviteLink,
  sendMagicLink,
  sendPasswordReset,
  setAdminPageAccess,
  setCanCountCash,
  setCanViewFinancials,
  setCanViewReports,
  setClinicianCanEditOwnHours,
  setClinicianSelfServe,
  setIsAdmin,
  setIsCustomerService,
  setIsManager,
  setIsVirtualImpressionClinician,
  setRequire2fa,
  setStaffLocation,
  setStaffName,
  setStaffRole,
  unarchiveStaffRole,
  updateStaffRole,
  useStaff,
  useStaffRoles,
  type StaffRoleRow,
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
import {
  previewTestPatientAppointmentsWipe,
  setLaunchDate,
  TEST_PATIENT_EMAILS,
  useLaunchDate,
  wipeTestPatientAppointments,
} from '../lib/queries/launchDate.ts';
import { humaniseStatus } from '../lib/queries/appointments.ts';
import {
  useCalendlyDiagnostic,
  runCalendlyBackfill,
  verifyCalendlyWebhook,
  type VerifyResult,
} from '../lib/queries/calendlyDiagnostic.ts';
import {
  answerMapKey,
  deleteCalendlyAnswerMap,
  saveCalendlyAnswerMap,
  useCalendlyAnswerMap,
  useCalendlyDiscoveredAnswers,
  type CalendlyAnswerMapRow,
  type CalendlyDiscoveredAnswer,
} from '../lib/queries/calendlyAnswerMap.ts';
import { formatPence, formatPounds } from '../lib/queries/carts.ts';
import {
  batchUpdateSortOrders,
  type CatalogueRow,
  deleteCatalogueImage,
  setCatalogueActive,
  uploadCatalogueImage,
  upsertCatalogueRow,
  useCatalogueActive,
  useCatalogueAll,
  type ArchMatch,
} from '../lib/queries/catalogue.ts';
import {
  addStaffMeetHost,
  batchUpdateMeetHostSortOrders,
  createMeetHostInvite,
  deleteMeetHost,
  listMeetOAuthClients,
  type MeetOAuthClient,
  setMeetHostActive,
  startMeetHostOAuth,
  useMeetHosts,
} from '../lib/queries/meetHosts.ts';
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
import { useCurrentAccount } from '../lib/queries/currentAccount.tsx';
import { useLocations } from '../lib/queries/locations.ts';
import { AdminBookingTypesTab, TimeField, WorkingHoursEditor } from './AdminBookingTypesTab.tsx';
import {
  addClinicianOverride,
  addOwnClinicianOverride,
  deleteClinicianOverride,
  deleteOwnClinicianOverride,
  fetchClinicianSchedule,
  setClinicianHours,
  setOwnClinicianHours,
  type ClinicianOverride,
} from '../lib/queries/clinicianHours.ts';
import type { OpeningHoursWeek } from '../lib/queries/clinicSettings.ts';
import { todayIso } from '../lib/calendarMonth.ts';
import { AdminConflictsTab } from './AdminConflictsTab.tsx';
import { AdminEmailTemplatesTab } from './AdminEmailTemplatesTab.tsx';
import { AdminSmsTemplatesTab } from './AdminSmsTemplatesTab.tsx';
import { AdminBrandingTab } from './AdminBrandingTab.tsx';
import { AdminWidgetTab } from './AdminWidgetTab.tsx';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

type Tab = 'devices' | 'failures' | 'reports' | 'calendly' | 'services' | 'products' | 'booking_types' | 'conflicts' | 'emails' | 'sms' | 'branding' | 'widget' | 'receipts' | 'testing' | 'waivers' | 'staff' | 'payments' | 'virtual_impressions';

// Canonical list of every Admin tab. Drives the SegmentedControl in
// the Admin header, the per-staff "Admin pages" toggle list in the
// Manage sheet, and the visibility filter at /admin for staff with
// per-page grants. Adding a new admin tab? Add it here and the
// permissions UI picks it up automatically — no migration needed,
// because admin_page_access on lng_staff_members is a JSONB array
// validated against this list app-side, not via a CHECK constraint.
//
// Two non-toggleable tabs:
//   • staff   — must be full admin to manage staff. Listing it as a
//               page grant would let a non-admin demote an admin.
//   • testing — destructive dev tooling, super admin only.
// Both are excluded from MANAGEABLE_ADMIN_TABS below. They still
// render for full admins / super admins via the standard tab filter.
const ADMIN_TABS: { key: Tab; label: string; description: string }[] = [
  { key: 'calendly', label: 'Calendly', description: 'Webhook health, backfill imports, subscription diagnostics.' },
  { key: 'services', label: 'Services', description: 'Bookable service catalogue, ordering, images.' },
  { key: 'products', label: 'Products', description: 'Add-on product catalogue, pricing, archiving.' },
  { key: 'booking_types', label: 'Booking types', description: 'Calendly mapping, deposits, services-per-type policy.' },
  { key: 'conflicts', label: 'Resources', description: 'Resource conflict rules so two appointments never share a chair or surgeon.' },
  { key: 'emails', label: 'Emails', description: 'Editable transactional email templates with version history.' },
  { key: 'sms', label: 'SMS', description: 'Editable manually-sent SMS templates per booking type.' },
  { key: 'branding', label: 'Branding', description: 'Logo, colour, footer copy applied across emails and receipts.' },
  { key: 'widget', label: 'Widget', description: 'Public-facing booking widget configuration and embed snippet.' },
  { key: 'waivers', label: 'Waivers', description: 'Waiver section authoring + per-service requirement matrix.' },
  { key: 'receipts', label: 'Receipts', description: 'Failed or pending receipt deliveries; retry sends.' },
  { key: 'reports', label: 'Reports', description: 'Operational and revenue dashboards.' },
  { key: 'devices', label: 'Devices', description: 'Stripe Terminal readers + location pairing.' },
  { key: 'payments', label: 'Payments', description: 'Stripe payment log, reconciliation, retries.' },
  { key: 'staff', label: 'Staff', description: 'Add, deactivate, permissions, and account actions for Lounge staff.' },
  { key: 'virtual_impressions', label: 'Virtual impressions', description: 'Clinicians who run virtual impression calls, their hours, and the Google accounts that host the rooms.' },
  { key: 'failures', label: 'Failures', description: 'Unresolved system failures captured by lng_system_failures.' },
  { key: 'testing', label: 'Testing', description: 'Dev-only resets and test-harness shortcuts.' },
];

// Admin tabs an admin can grant a non-admin staff member access to.
// Staff + Testing are full-admin only and never appear as toggleable
// per-page grants — see the comment on ADMIN_TABS.
const NON_GRANTABLE_TABS: ReadonlySet<Tab> = new Set<Tab>(['staff', 'testing']);
const MANAGEABLE_ADMIN_TABS = ADMIN_TABS.filter((t) => !NON_GRANTABLE_TABS.has(t.key));

export function Admin() {
  const { user, loading: authLoading } = useAuth();
  const { account, loading: accountLoading } = useCurrentAccount();
  const isMobile = useIsMobile(640);
  const navigate = useNavigate();
  // The active tab is encoded in the URL (/admin/:tab) so a refresh,
  // a back-navigation, or a shared link keeps the operator on the
  // same surface. useState would have lost that on every reload.
  const params = useParams<{ tab?: string }>();

  // Visible tabs depend on the operator. Super admins and full admins
  // see every tab. Limited admins (is_admin = false, but
  // admin_page_access has entries) see only the tabs they've been
  // granted. Memoised here so the segmented control + the URL gate
  // stay in sync.
  const visibleTabs = useMemo(() => {
    if (!account) return [];
    if (account.is_super_admin || account.is_admin) return ADMIN_TABS;
    const allowed = new Set(account.admin_page_access);
    return ADMIN_TABS.filter((t) => allowed.has(t.key));
  }, [account]);

  // Resolve the active tab from the URL, gated against visibleTabs.
  // Bare /admin (no :tab) AND any unknown / no-longer-visible :tab
  // both fall back to the operator's first visible tab — the canonical
  // URL is restored via a replaceState below.
  const urlTab = params.tab as Tab | undefined;
  const tab: Tab = useMemo(() => {
    const fallback: Tab = visibleTabs[0]?.key ?? 'calendly';
    if (!urlTab) return fallback;
    if (!visibleTabs.some((t) => t.key === urlTab)) return fallback;
    return urlTab;
  }, [urlTab, visibleTabs]);

  const setTab = useCallback(
    (next: Tab) => {
      navigate(`/admin/${next}`, { replace: false });
    },
    [navigate],
  );

  // Keep the URL canonical:
  //   • /admin (no :tab)        → /admin/<first-visible>
  //   • /admin/<unknown-tab>    → /admin/<first-visible>
  //   • /admin/<not-granted>    → /admin/<first-visible> (grant shift mid-session)
  // replace:true so the canonical URL replaces the malformed one
  // in history rather than stacking a back-step the user didn't take.
  useEffect(() => {
    if (visibleTabs.length === 0) return;
    if (!urlTab || !visibleTabs.some((t) => t.key === urlTab)) {
      const fallback = visibleTabs[0]!.key;
      navigate(`/admin/${fallback}`, { replace: true });
    }
  }, [urlTab, visibleTabs, navigate]);

  if (authLoading || accountLoading) return null;
  if (!user) return <Navigate to="/sign-in" replace />;
  // Admin gate. Three ways in:
  //   • Super admin                  — fixed email, always sees everything
  //   • Full admin                   — lng_staff_members.is_admin = true
  //   • Limited admin (page grants)  — admin_page_access has entries
  // No path in → home redirect. Non-admin staff can use everything
  // else in Lounge but /admin (and the Staff tab specifically) stays
  // off-limits without an explicit grant.
  const hasFullAdmin = account?.is_admin === true || account?.is_super_admin === true;
  const hasLimitedAdmin = (account?.admin_page_access?.length ?? 0) > 0;
  if (!account || (!hasFullAdmin && !hasLimitedAdmin)) {
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
            options={visibleTabs.map((t) => ({ value: t.key, label: t.label }))}
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
        ) : tab === 'sms' ? (
          <AdminSmsTemplatesTab />
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
        ) : tab === 'virtual_impressions' ? (
          <VirtualImpressionsTab />
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
              value={d.lastDelivery ? `${new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(d.lastDelivery))} ${fmtTzAbbr(d.lastDelivery)}` : '—'}
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

      <CalendlyAnswerMappingsCard onError={(msg) => setToast({ tone: 'error', title: msg })} />

      {toast ? (
        <div style={{ position: 'fixed', bottom: theme.space[6], left: '50%', transform: 'translateX(-50%)', zIndex: 100 }}>
          <Toast tone={toast.tone === 'info' ? 'info' : toast.tone === 'error' ? 'error' : 'success'} title={toast.title} description={toast.description} duration={6000} onDismiss={() => setToast(null)} />
        </div>
      ) : null}
    </div>
  );
}

function CalendlyAnswerMappingsCard({ onError }: { onError: (msg: string) => void }) {
  const { byQuestionAnswer, loading: mappingsLoading, refresh } = useCalendlyAnswerMap();
  const { answers: discovered, loading: discoveredLoading } = useCalendlyDiscoveredAnswers();
  const { rows: catalogueRows } = useCatalogueActive();

  // Pending catalogue selection per (question, answer_text) key — used for
  // unmapped rows where the admin has opened the dropdown but not yet saved.
  const [pending, setPending] = useState<Map<string, string>>(new Map());
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<Set<string>>(new Set());

  const catalogueOptions = [
    { value: '', label: 'Choose a catalogue item…' },
    ...catalogueRows.map((r) => ({ value: r.id, label: `${r.name} — ${r.category}` })),
  ];

  // Group discovered answers by question label for section rendering.
  const byQuestion = useMemo(() => {
    const map = new Map<string, CalendlyDiscoveredAnswer[]>();
    for (const a of discovered) {
      const arr = map.get(a.question) ?? [];
      arr.push(a);
      map.set(a.question, arr);
    }
    return map;
  }, [discovered]);

  const onMap = async (question: string, answer_text: string) => {
    const key = answerMapKey(question, answer_text);
    const catalogueId = pending.get(key);
    if (!catalogueId) return;
    setSaving((s) => new Set(s).add(key));
    const { error } = await saveCalendlyAnswerMap(question, answer_text, catalogueId);
    setSaving((s) => { const n = new Set(s); n.delete(key); return n; });
    if (error) { onError(error); return; }
    refresh();
  };

  const onRemove = async (row: CalendlyAnswerMapRow) => {
    setDeleting((d) => new Set(d).add(row.id));
    const { error } = await deleteCalendlyAnswerMap(row.id);
    setDeleting((d) => { const n = new Set(d); n.delete(row.id); return n; });
    if (error) { onError(error); return; }
    refresh();
  };

  const loading = mappingsLoading || discoveredLoading;

  return (
    <Card padding="lg">
      <h2 style={{ margin: 0, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold }}>
        Intake answer mappings
      </h2>
      <p style={{ margin: `${theme.space[2]}px 0 ${theme.space[5]}px`, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
        These are all the answer values seen in real Calendly bookings. Map each one to the catalogue item it represents so Lounge can pre-fill the arrival basket automatically. Arch is always derived from the arch question separately.
      </p>

      {loading ? (
        <Skeleton height={200} />
      ) : byQuestion.size === 0 ? (
        <p style={{ color: theme.color.inkSubtle, fontSize: theme.type.size.sm, margin: 0 }}>
          No Calendly intake data found. Run a backfill first.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[6] }}>
          {[...byQuestion.entries()].map(([question, answers]) => (
            <div key={question}>
              {/* Question section header */}
              <div
                style={{
                  fontSize: theme.type.size.xs,
                  fontWeight: theme.type.weight.semibold,
                  color: theme.color.inkMuted,
                  textTransform: 'uppercase',
                  letterSpacing: theme.type.tracking.wide,
                  marginBottom: theme.space[3],
                }}
              >
                {question}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
                {answers.map(({ answer_text, frequency }) => {
                  const key = answerMapKey(question, answer_text);
                  const existing = byQuestionAnswer.get(key);
                  const pendingId = pending.get(key) ?? '';
                  const isSaving = saving.has(key);
                  const isDeleting = existing ? deleting.has(existing.id) : false;

                  return (
                    <div
                      key={answer_text}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: theme.space[3],
                        padding: `${theme.space[3]}px ${theme.space[4]}px`,
                        background: existing ? theme.color.accentBg : theme.color.bg,
                        borderRadius: theme.radius.card,
                        border: `1px solid ${existing ? theme.color.accent + '40' : theme.color.border}`,
                        flexWrap: 'wrap',
                      }}
                    >
                      {/* Answer text + frequency badge */}
                      <div style={{ flex: '1 1 160px', minWidth: 0, display: 'flex', alignItems: 'center', gap: theme.space[2] }}>
                        <span style={{ fontSize: theme.type.size.sm, fontWeight: theme.type.weight.semibold, color: theme.color.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {answer_text}
                        </span>
                        <span
                          style={{
                            flexShrink: 0,
                            fontSize: theme.type.size.xs,
                            color: theme.color.inkSubtle,
                            background: theme.color.surface,
                            border: `1px solid ${theme.color.border}`,
                            borderRadius: theme.radius.pill,
                            padding: `1px ${theme.space[2]}px`,
                          }}
                        >
                          ×{frequency}
                        </span>
                      </div>

                      {/* Right-hand controls */}
                      {existing ? (
                        // Already mapped: show catalogue name + remove button
                        <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[3], flexShrink: 0 }}>
                          <span style={{ fontSize: theme.type.size.sm, color: theme.color.ink }}>
                            {existing.catalogue_name}
                            {existing.catalogue_category ? (
                              <span style={{ color: theme.color.inkMuted }}> — {existing.catalogue_category}</span>
                            ) : null}
                          </span>
                          <button
                            type="button"
                            disabled={isDeleting}
                            onClick={() => void onRemove(existing)}
                            title="Remove mapping"
                            style={{
                              appearance: 'none',
                              border: 'none',
                              background: 'none',
                              cursor: isDeleting ? 'default' : 'pointer',
                              color: theme.color.inkSubtle,
                              padding: theme.space[1],
                              opacity: isDeleting ? 0.4 : 1,
                              display: 'flex',
                              alignItems: 'center',
                            }}
                          >
                            <X size={15} />
                          </button>
                        </div>
                      ) : (
                        // Unmapped: dropdown + Map button
                        <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], flex: '1 1 280px' }}>
                          <div style={{ flex: 1, minWidth: 180 }}>
                            <DropdownSelect
                              value={pendingId}
                              onChange={(id) =>
                                setPending((p) => { const n = new Map(p); n.set(key, id); return n; })
                              }
                              options={catalogueOptions}
                            />
                          </div>
                          <Button
                            variant="primary"
                            size="sm"
                            loading={isSaving}
                            disabled={!pendingId}
                            onClick={() => void onMap(question, answer_text)}
                          >
                            Map
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
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
              Receipts that haven't been delivered yet, or where delivery reported a failure. Tap Retry to re-attempt.
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
                    {`${new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(row.created_at))} ${fmtTzAbbr(row.created_at)}`}
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
  const navigate = useNavigate();
  const [resetting, setResetting] = useState<string | null>(null);
  const [resettingAll, setResettingAll] = useState(false);
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; title: string; description?: string } | null>(null);
  const [legacyConfirm, setLegacyConfirm] = useState(false);

  // Send the admin to the Cash counts page with state.kind so the
  // sheet opens in legacy-baseline mode (different copy + the new
  // count row is tagged kind='legacy_baseline'). The actual count
  // flow lives in /cash-counts so the manager-sign-off, threshold
  // notes and PDF download all reuse one path.
  const startLegacyCashCount = () => {
    setLegacyConfirm(false);
    navigate('/cash-counts', { state: { kind: 'legacy_baseline' } });
  };

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
      {/* Launch — set the launch date, then flip every still-booked
          row whose slot ended before launch to no_show with a clear
          backfill tag. Sits above the legacy cash count card because
          the launch date is the most foundational piece of go-live
          state; everything else (cash baseline, dirty-appointment
          cleanup) follows from it. */}
      <LaunchCard onToast={setToast} />

      {/* Test-patient wipe — deletes every appointment + downstream
          artefact for Dylan's five test inboxes. Sits between Launch
          and Legacy cash count because it's the "make the schedule
          actually empty" step before flipping the launch switch.
          Destructive: rows go for good (no soft-delete fallback). */}
      <WipeTestAppointmentsCard onToast={setToast} />

      {/* Legacy cash count — admin entry point for resetting the cash
          chain at launch / re-launch. Card sits at the top of the
          Testing tab because it's a launch-prep tool (everything below
          is for cleaning up test data). Repeatable on purpose: Dylan
          asked for the option to run this multiple times during
          pre-launch / re-launch cycles. */}
      <Card padding="lg">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: theme.space[3] }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <h2 style={{ margin: 0, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
                <Wallet size={20} /> Legacy cash count
              </span>
            </h2>
            <p
              style={{
                margin: `${theme.space[2]}px 0 0`,
                color: theme.color.inkMuted,
                fontSize: theme.type.size.sm,
                lineHeight: theme.type.leading.normal,
              }}
            >
              Used when launching, or relaunching, the app at a venue. Counts the cash that is physically in the safe right now and signs that amount off as the new baseline. Every routine cash count after this one starts from that moment. You can run this more than once, each new run replaces the previous baseline.
            </p>
          </div>
          <Button
            variant="primary"
            onClick={() => setLegacyConfirm(true)}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
              <Wallet size={14} /> Start legacy cash count
            </span>
          </Button>
        </div>
      </Card>

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
                const when = `${new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(row.start_at))} ${fmtTzAbbr(row.start_at)}`;
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
                    <StatusPill tone={row.status === 'arrived' || row.status === 'joined' ? 'arrived' : row.status === 'no_show' ? 'no_show' : 'neutral'} size="sm">
                      {humaniseStatus(row.status as 'booked' | 'arrived' | 'joined' | 'complete' | 'no_show' | 'cancelled' | 'rescheduled')}
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

      <BottomSheet
        open={legacyConfirm}
        onClose={() => setLegacyConfirm(false)}
        title="Start a legacy cash count?"
        description="The next page asks you to count what is physically in the safe right now. A manager signs it off and that amount becomes the new baseline. Every routine cash count after this starts counting from that point."
        footer={
          <div style={{ display: 'flex', gap: theme.space[3], justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={() => setLegacyConfirm(false)}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <X size={16} aria-hidden /> Not now
              </span>
            </Button>
            <Button variant="primary" onClick={startLegacyCashCount}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Wallet size={16} aria-hidden /> Open the count sheet
              </span>
            </Button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
          <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted, lineHeight: theme.type.leading.normal }}>
            Safe to run more than once. Each new legacy count replaces the prior baseline; the older counts stay in the history list, tagged so they read as launch-time resets rather than routine reconciliations.
          </p>
        </div>
      </BottomSheet>
    </div>
  );
}

// Launch-date card on the Testing tab. Date + time pickers + Save
// write lng_settings.lounge.launch_date. The saved instant drives
// the AppointmentDetail PreLaunchBanner and the reports range clamp
// so pre-launch Calendly history is naturally excluded from charts
// without touching any underlying row.
function LaunchCard({
  onToast,
}: {
  onToast: (toast: { tone: 'success' | 'error'; title: string; description?: string }) => void;
}) {
  const launch = useLaunchDate();

  // Local form state — separate from the persisted value so the
  // operator can edit and discard without dirtying the DB.
  const initialDate = launch.data ? splitLaunchIso(launch.data).date : '';
  const initialTime = launch.data ? splitLaunchIso(launch.data).time : '';
  const [date, setDate] = useState<string>(initialDate);
  const [time, setTime] = useState<string>(initialTime);
  const [dateOpen, setDateOpen] = useState(false);
  const [timeOpen, setTimeOpen] = useState(false);
  const dateTriggerRef = useRef<HTMLButtonElement | null>(null);
  const timeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [saving, setSaving] = useState(false);

  // Resync local form state when the persisted launch_date changes —
  // matters after a Save → refresh round-trip so the form reflects
  // exactly what's in the DB.
  useEffect(() => {
    if (launch.data) {
      const split = splitLaunchIso(launch.data);
      setDate(split.date);
      setTime(split.time);
    } else {
      setDate('');
      setTime('');
    }
  }, [launch.data]);

  const composed = composeLaunchIso(date, time);
  const dirty = composed !== launch.data && (composed !== null || launch.data !== null);
  const canSave = !!composed && dirty && !saving;

  const onSave = async () => {
    if (!composed || saving) return;
    setSaving(true);
    try {
      await setLaunchDate(composed);
      onToast({ tone: 'success', title: 'Launch date saved' });
      launch.refresh();
    } catch (e) {
      onToast({
        tone: 'error',
        title: 'Could not save launch date',
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  const onClear = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await setLaunchDate(null);
      onToast({ tone: 'success', title: 'Launch date cleared' });
      launch.refresh();
    } catch (e) {
      onToast({
        tone: 'error',
        title: 'Could not clear launch date',
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card padding="lg">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: theme.space[3] }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <h2 style={{ margin: 0, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
              <Rocket size={20} /> Launch
            </span>
          </h2>
          <p
            style={{
              margin: `${theme.space[2]}px 0 0`,
              color: theme.color.inkMuted,
              fontSize: theme.type.size.sm,
              lineHeight: theme.type.leading.normal,
            }}
          >
            Set the moment Lounge went live. Bookings that pre-date this instant get a "Booked before Lounge launched" banner on the appointment page, and the reports auto-floor their start date here so legacy Calendly history stays out of the funnel.
          </p>
        </div>
      </div>

      <div style={{ marginTop: theme.space[5], display: 'grid', gridTemplateColumns: '2fr 1fr', gap: theme.space[3], maxWidth: 560 }}>
        <FieldTrigger
          ref={dateTriggerRef}
          icon={<CalendarClock size={16} aria-hidden />}
          value={date ? formatLaunchDateLong(date) : ''}
          placeholder="Pick launch date"
          open={dateOpen}
          onClick={() => {
            setTimeOpen(false);
            setDateOpen((v) => !v);
          }}
        />
        <FieldTrigger
          ref={timeTriggerRef}
          icon={<Clock size={16} aria-hidden />}
          value={time}
          placeholder="HH:MM"
          open={timeOpen}
          onClick={() => {
            setDateOpen(false);
            setTimeOpen((v) => !v);
          }}
        />
      </div>
      <DatePicker
        open={dateOpen}
        onClose={() => setDateOpen(false)}
        value={date}
        onChange={(iso) => setDate(iso)}
        anchorRef={dateTriggerRef}
        title="Launch date"
      />
      <TimePicker
        open={timeOpen}
        onClose={() => setTimeOpen(false)}
        value={time}
        onChange={(t) => setTime(t)}
        anchorRef={timeTriggerRef}
        title="Launch time"
      />

      <div style={{ marginTop: theme.space[4], display: 'flex', gap: theme.space[2], alignItems: 'center', flexWrap: 'wrap' }}>
        <Button variant="primary" onClick={onSave} loading={saving} disabled={!canSave}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Check size={14} /> Save launch date
          </span>
        </Button>
        {launch.data ? (
          <Button variant="tertiary" onClick={onClear} disabled={saving}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <X size={14} /> Clear
            </span>
          </Button>
        ) : null}
        {launch.data ? (
          <span style={{ marginLeft: 'auto', fontSize: theme.type.size.xs, color: theme.color.inkSubtle, fontVariantNumeric: 'tabular-nums' }}>
            Saved: {formatLaunchInstantLong(launch.data)}
          </span>
        ) : null}
      </div>

    </Card>
  );
}

// Wipe-test-appointments card on the Testing tab. Hard-coded inbox
// list (TEST_PATIENT_EMAILS in launchDate.ts) so the operator can't
// accidentally point this at a real patient — the surface is "wipe
// MY test data", not "wipe arbitrary patient data". The RPC keeps
// the patient profile rows but removes every appointment + every
// cascaded artefact (visits, carts, payments, receipts, phases,
// upgrades, repair items, intake photos, meet hosts, email
// messages, appointment-keyed patient_events).
function WipeTestAppointmentsCard({
  onToast,
}: {
  onToast: (toast: { tone: 'success' | 'error'; title: string; description?: string }) => void;
}) {
  const [preview, setPreview] = useState<{ patients: number; appointments: number } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPreviewLoading(true);
    (async () => {
      try {
        const res = await previewTestPatientAppointmentsWipe(TEST_PATIENT_EMAILS);
        if (cancelled) return;
        setPreview(res);
        setPreviewError(null);
      } catch (e) {
        if (cancelled) return;
        setPreview(null);
        setPreviewError(e instanceof Error ? e.message : 'Could not preview wipe');
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const refresh = () => setNonce((n) => n + 1);

  const onRun = async () => {
    if (running) return;
    setRunning(true);
    try {
      const res = await wipeTestPatientAppointments(TEST_PATIENT_EMAILS);
      onToast({
        tone: 'success',
        title:
          res.appointments === 0
            ? 'Nothing to wipe'
            : `Wiped ${res.appointments} appointment${res.appointments === 1 ? '' : 's'}`,
        description:
          res.appointments === 0
            ? 'Test inboxes already have a clean slate.'
            : `Across ${res.patients} patient${res.patients === 1 ? '' : 's'}. Profile rows kept; every booking + downstream record removed.`,
      });
      setConfirmOpen(false);
      refresh();
    } catch (e) {
      onToast({
        tone: 'error',
        title: 'Wipe failed',
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setRunning(false);
    }
  };

  const hasAny = (preview?.appointments ?? 0) > 0;

  return (
    <Card padding="lg">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: theme.space[3] }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <h2 style={{ margin: 0, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
              <Trash2 size={20} /> Wipe test appointments
            </span>
          </h2>
          <p
            style={{
              margin: `${theme.space[2]}px 0 0`,
              color: theme.color.inkMuted,
              fontSize: theme.type.size.sm,
              lineHeight: theme.type.leading.normal,
            }}
          >
            Deletes every appointment, visit, cart, payment, receipt, phase, upgrade, repair line, intake photo, and timeline event tied to these five test inboxes. Patient profile rows stay so Dylan can keep re-using them post-launch. Destructive — no undo.
          </p>
          <ul
            style={{
              margin: `${theme.space[3]}px 0 0`,
              padding: 0,
              listStyle: 'none',
              display: 'flex',
              flexWrap: 'wrap',
              gap: theme.space[2],
            }}
          >
            {TEST_PATIENT_EMAILS.map((e) => (
              <li
                key={e}
                style={{
                  padding: `${theme.space[1]}px ${theme.space[2]}px`,
                  borderRadius: 999,
                  background: theme.color.surface,
                  border: `1px solid ${theme.color.border}`,
                  fontSize: theme.type.size.xs,
                  color: theme.color.inkMuted,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {e}
              </li>
            ))}
          </ul>
        </div>
        <Button
          variant="secondary"
          onClick={() => setConfirmOpen(true)}
          disabled={previewLoading || !hasAny}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Trash2 size={14} /> Wipe appointments
          </span>
        </Button>
      </div>

      <div style={{ marginTop: theme.space[4], fontSize: theme.type.size.xs, color: theme.color.inkSubtle, fontVariantNumeric: 'tabular-nums' }}>
        {previewLoading
          ? 'Counting test bookings…'
          : previewError
            ? previewError
            : !preview
              ? 'No data.'
              : preview.appointments === 0
                ? `${preview.patients} test patient${preview.patients === 1 ? '' : 's'} found, no appointments to wipe.`
                : `${preview.appointments.toLocaleString('en-GB')} appointment${preview.appointments === 1 ? '' : 's'} across ${preview.patients} test patient${preview.patients === 1 ? '' : 's'} ready to wipe.`}
      </div>

      <BottomSheet
        open={confirmOpen}
        onClose={running ? () => undefined : () => setConfirmOpen(false)}
        title="Wipe every test appointment?"
        description={
          preview && preview.appointments > 0
            ? `${preview.appointments.toLocaleString('en-GB')} appointment${preview.appointments === 1 ? '' : 's'} across ${preview.patients} test patient${preview.patients === 1 ? '' : 's'}. Every visit, cart, payment, receipt, phase, repair line, upgrade, intake photo, meet host, email record, and appointment-keyed timeline event for these inboxes will be deleted. There is no undo.`
            : 'Nothing to wipe.'
        }
        footer={
          <div style={{ display: 'flex', gap: theme.space[3], justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={() => setConfirmOpen(false)} disabled={running}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <X size={16} aria-hidden /> Not yet
              </span>
            </Button>
            <Button variant="primary" onClick={onRun} loading={running} disabled={!hasAny}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Trash2 size={16} aria-hidden />
                {preview && preview.appointments > 0
                  ? `Wipe ${preview.appointments.toLocaleString('en-GB')}`
                  : 'Wipe'}
              </span>
            </Button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
          <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted, lineHeight: theme.type.leading.normal }}>
            Idempotent. A re-run after a successful wipe finds nothing and reports 0.
          </p>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: theme.space[1] }}>
            {TEST_PATIENT_EMAILS.map((e) => (
              <li key={e} style={{ fontSize: theme.type.size.sm, color: theme.color.ink, fontFamily: 'monospace' }}>
                {e}
              </li>
            ))}
          </ul>
        </div>
      </BottomSheet>
    </Card>
  );
}

// Local YYYY-MM-DD + HH:MM ↔ ISO timestamptz helpers. Mirrors the
// pair NewBookingSheet uses; kept inline rather than extracted because
// the launch card is the only other surface that needs them, and the
// helpers are small.
function splitLaunchIso(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: '', time: '' };
  // Split into clinic-time wall components so the launch date/time
  // inputs read in BST/GMT for every admin viewer regardless of
  // device timezone.
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
  };
}

function composeLaunchIso(date: string, time: string): string | null {
  if (!date || !time) return null;
  // Treat the typed parts as clinic-time wall clock and back out
  // the London offset so the stored UTC instant reads as the
  // entered time when displayed in London tz.
  const [Y, M, D] = date.split('-').map(Number);
  const [hh, mi] = time.split(':').map(Number);
  if (!Y || !M || !D || Number.isNaN(hh) || Number.isNaN(mi)) return null;
  const naiveUtc = Date.UTC(Y, M - 1, D, hh, mi, 0);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(naiveUtc));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const londonAsUtc = Date.UTC(
    n('year'),
    n('month') - 1,
    n('day'),
    n('hour') % 24,
    n('minute'),
    n('second'),
  );
  return new Date(naiveUtc - (londonAsUtc - naiveUtc)).toISOString();
}

function formatLaunchDateLong(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatLaunchInstantLong(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const stamp = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
  return `${stamp} ${fmtTzAbbr(iso)}`;
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
                    Signed in {`${new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(s.signed_in_at))} ${fmtTzAbbr(s.signed_in_at)}`}
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
  const [showInactive, setShowInactive] = useState(false);
  const [search, setSearch] = useState('');

  // Add-staff sheet
  const [addOpen, setAddOpen] = useState(false);
  const [addEmail, setAddEmail] = useState('');
  const [addFirstName, setAddFirstName] = useState('');
  const [addLastName, setAddLastName] = useState('');
  const [addAdmin, setAddAdmin] = useState(false);
  const [addManager, setAddManager] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  // When the edge function provisions the account but Resend can't
  // deliver the invite email, we show the action_link inline so the
  // admin can copy + send manually rather than us swallowing it.
  const [addManualInviteLink, setAddManualInviteLink] = useState<{
    name: string;
    email: string;
    link: string;
    reason: string | null;
  } | null>(null);

  // Single Manage sheet — replaces the four overlapping sheets the
  // tab used to expose (edit name, permissions, account actions,
  // deactivate). One row state, six sections inside.
  const [managing, setManaging] = useState<StaffRow | null>(null);
  const [draftFirst, setDraftFirst] = useState('');
  const [draftLast, setDraftLast] = useState('');
  const [nameBusy, setNameBusy] = useState(false);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [deactivateBusy, setDeactivateBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState<
    null | 'password_reset' | 'magic_link' | 'reset_2fa' | 'toggle_2fa' | 'resend_invite'
  >(null);
  const [actionFeedback, setActionFeedback] = useState<{
    tone: 'success' | 'error';
    title: string;
    description?: string;
    manualLink?: string;
  } | null>(null);
  // Active invite URL for the currently-managed staff member, fetched
  // lazily via lng-get-staff-invite-link the moment a pending staff
  // row's Manage sheet opens. Read-only — the function does NOT mint
  // a fresh token, so the URL shown here matches the one already
  // sitting in the staff member's inbox. 'loading' covers the fetch
  // in flight, 'error' surfaces a fetch failure (network, auth) so
  // the admin can retry, and 'ready' carries the resolved URL +
  // expiry. Admins use this URL as a Slack/WhatsApp fallback when the
  // staff_invite email doesn't reach the inbox (silent Resend
  // acceptance + downstream filter, broken DKIM, ATP quarantine, etc.)
  const [pendingInviteLink, setPendingInviteLink] = useState<
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'ready'; url: string | null; expired: boolean; expiresAt: string | null }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });
  const [confirmReset2fa, setConfirmReset2fa] = useState(false);
  // Tab key currently mid-write for the per-page access toggles.
  // Used to disable just-clicked rows while their PATCH is in flight,
  // so rapid taps don't queue up conflicting writes against the same
  // JSONB column.
  const [pageBusy, setPageBusy] = useState<string | null>(null);
  // Tracks the role-assignment write so the Manage sheet's role
  // dropdown can show a busy state without locking the rest of the
  // sheet.
  const [roleAssignBusy, setRoleAssignBusy] = useState(false);
  // Same idea, separate flag, for the per-staff location dropdown.
  // Multiple staff added today have accounts.location_id null, which
  // hides most of the app from them (every Lounge view filters on
  // the deterministic location). Surfacing a dropdown in the Manage
  // sheet is the recovery path.
  const [locationAssignBusy, setLocationAssignBusy] = useState(false);
  const locations = useLocations();

  // Role catalogue management. The "Manage roles" sheet is a sibling
  // to the Manage staff sheet — opened from the header bar, not from
  // a staff row, because it edits the shared catalogue rather than
  // any one staff member's record.
  const roles = useStaffRoles();
  const [rolesOpen, setRolesOpen] = useState(false);
  const [roleDraftName, setRoleDraftName] = useState('');
  const [roleDraftDescription, setRoleDraftDescription] = useState('');
  const [roleCreateBusy, setRoleCreateBusy] = useState(false);
  const [roleCreateError, setRoleCreateError] = useState<string | null>(null);
  // Per-row edit state inside the Manage roles sheet. Stores the row
  // currently being renamed plus the in-flight name draft. Only one
  // edit-in-place is permitted at a time so save/cancel state stays
  // simple.
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
  const [editingRoleName, setEditingRoleName] = useState('');
  const [editingRoleDescription, setEditingRoleDescription] = useState('');
  const [roleRowBusy, setRoleRowBusy] = useState<string | null>(null);
  const [roleRowError, setRoleRowError] = useState<string | null>(null);
  // Show archived roles toggle, parallel to showInactive on staff.
  const [showArchivedRoles, setShowArchivedRoles] = useState(false);

  const canEditAdmin = currentAccount?.is_super_admin === true;
  const canEditFinancialPerms = currentAccount?.is_super_admin === true;
  // Page-access grants are admin-editable, but the operator must
  // already have admin rights themselves (full or super). A limited
  // admin can't grant other people access.
  const canEditPageAccess = currentAccount?.is_admin === true || currentAccount?.is_super_admin === true;

  // Stats line at the top — answers "how many people, who's an
  // admin, how many limited admins, how many sat in the inactive
  // bucket". Cheap derivation, kept inline rather than memoised.
  const activeStaff = staff.data.filter((s) => s.status === 'active');
  const inactiveCount = staff.data.length - activeStaff.length;
  const adminCount = activeStaff.filter((s) => s.is_admin).length;
  const limitedAdminCount = activeStaff.filter((s) => !s.is_admin && s.admin_page_access.length > 0).length;

  const searchTerm = search.trim().toLowerCase();
  const visibleStaff = (showInactive ? staff.data : activeStaff)
    .filter((s) =>
      !searchTerm
        ? true
        : s.display_name.toLowerCase().includes(searchTerm) ||
          s.login_email.toLowerCase().includes(searchTerm),
    );

  // Keep the open Manage sheet's row in sync with fresh data from the
  // staff list. Without this, optimistic toggles applied to
  // `managing` would be lost the moment the background refetch lands
  // and the sheet would re-render with stale-looking state. We snap
  // the local row to whatever the latest list has when ids match.
  useEffect(() => {
    if (!managing) return;
    const fresh = staff.data.find((s) => s.staff_member_id === managing.staff_member_id);
    if (fresh && fresh !== managing) {
      setManaging(fresh);
    }
  }, [staff.data, managing]);

  // Fetch the currently-active invite URL whenever the Manage sheet
  // opens for a pending staff member (invite sent, not yet accepted).
  // Read-only — does NOT mint a new token. We key on staff_member_id
  // alone so toggling an unrelated field on the row (manager flag,
  // location, etc.) does not refetch. Accepted rows reset the state.
  useEffect(() => {
    if (!managing) {
      setPendingInviteLink({ kind: 'idle' });
      return;
    }
    if (managing.invite_accepted_at || !managing.invite_sent_at) {
      setPendingInviteLink({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    setPendingInviteLink({ kind: 'loading' });
    (async () => {
      try {
        const result = await getStaffInviteLink(managing.staff_member_id);
        if (cancelled) return;
        setPendingInviteLink({
          kind: 'ready',
          url: result.inviteUrl,
          expired: result.expired,
          expiresAt: result.inviteExpiresAt,
        });
      } catch (e) {
        if (cancelled) return;
        setPendingInviteLink({
          kind: 'error',
          message: e instanceof Error ? e.message : String(e),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [managing?.staff_member_id, managing?.invite_accepted_at, managing?.invite_sent_at]);

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

  const toggleCustomerService = async (staffMemberId: string, next: boolean) => {
    setBusyId(staffMemberId);
    setError(null);
    try {
      await setIsCustomerService(staffMemberId, next);
      staff.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const openManage = (row: StaffRow) => {
    setManaging(row);
    setDraftFirst(row.first_name ?? '');
    setDraftLast(row.last_name ?? '');
    setActionFeedback(null);
    setConfirmReset2fa(false);
    setConfirmDeactivate(false);
    setError(null);
  };

  const closeManage = () => {
    if (nameBusy || actionBusy || deactivateBusy) return;
    setManaging(null);
    setActionFeedback(null);
    setConfirmReset2fa(false);
    setConfirmDeactivate(false);
  };

  const saveName = async () => {
    if (!managing) return;
    const trimmedFirst = draftFirst.trim();
    const trimmedLast = draftLast.trim();
    if (trimmedFirst === (managing.first_name ?? '') && trimmedLast === (managing.last_name ?? '')) {
      return;
    }
    setNameBusy(true);
    setError(null);
    try {
      await setStaffName(managing.account_id, trimmedFirst, trimmedLast);
      staff.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setNameBusy(false);
    }
  };

  // Persist the location selected in the Manage sheet's location
  // dropdown. accounts.location_id drives every clinic-axis filter
  // in the app (which schedule the staff sees, which till they post
  // payments against, which patient pool they search), so leaving it
  // null hides most of the UI from them. Empty value clears the
  // binding entirely.
  const saveLocation = async (next: string | null) => {
    if (!managing) return;
    if (next === managing.location_id) return;
    setLocationAssignBusy(true);
    setError(null);
    try {
      await setStaffLocation(managing.account_id, next);
      staff.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLocationAssignBusy(false);
    }
  };

  const openAdd = () => {
    setAddEmail('');
    setAddFirstName('');
    setAddLastName('');
    setAddAdmin(false);
    setAddManager(false);
    setAddError(null);
    setAddManualInviteLink(null);
    setAddOpen(true);
  };

  const submitAdd = async () => {
    setAddBusy(true);
    setAddError(null);
    try {
      // First try the existing-account path. If the email is already
      // in public.accounts (typically a Meridian person being given
      // Lounge access too), this just adds the lng_staff_members row
      // and reuses their identity.
      const existing = await addStaffMemberByEmail(addEmail, {
        is_admin: addAdmin && canEditAdmin,
        is_manager: addManager,
      });
      if (!existing) {
        // No account row exists for this email. Provision a fresh
        // identity (auth user + accounts row + staff row) so the new
        // staff member ends up with sign-in credentials entirely
        // separate from any Meridian account. Requires first/last
        // name because accounts.name is NOT NULL.
        if (!addFirstName.trim() || !addLastName.trim()) {
          setAddError('Enter a first and last name to create a new Lounge account.');
          return;
        }
        const invited = await inviteNewStaffMember({
          email: addEmail,
          first_name: addFirstName,
          last_name: addLastName,
          is_admin: addAdmin && canEditAdmin,
          is_manager: addManager,
        });
        // Always surface the invite link in the sheet on a successful
        // create, even when Resend reports the email as sent. Two
        // reasons:
        //
        //   1. Corporate filters (Outlook ATP, Gmail safe-links,
        //      domain DMARC failures) routinely silently quarantine
        //      legit mail with no failure signal back to Resend. The
        //      admin has no way of knowing if the recipient actually
        //      received it until they're sitting next to the new
        //      starter wondering why they never got an email.
        //   2. Even on guaranteed delivery, admins often prefer to
        //      hand-deliver the link via Slack/WhatsApp so the new
        //      starter has it instantly. Forcing them to dig through
        //      a sent-mail archive to find the URL is silly.
        //
        // The `reason` field stays null on success — only set on
        // genuine email failures so the copy reads cleanly without
        // an alarming "Reason:" suffix.
        if (invited.inviteUrl) {
          setAddManualInviteLink({
            name: invited.display_name,
            email: addEmail.trim(),
            link: invited.inviteUrl,
            reason: invited.emailSent ? null : invited.emailError ?? null,
          });
          staff.refresh();
          return;
        }
      }
      staff.refresh();
      setAddOpen(false);
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    } finally {
      setAddBusy(false);
    }
  };

  const handleSendPasswordReset = async () => {
    if (!managing) return;
    setActionBusy('password_reset');
    setActionFeedback(null);
    try {
      const r = await sendPasswordReset(managing.staff_member_id);
      if (r.emailSent) {
        setActionFeedback({
          tone: 'success',
          title: 'Password reset link sent.',
          description: `Delivered to ${managing.login_email}. The link is good for one hour.`,
        });
      } else {
        setActionFeedback({
          tone: 'error',
          title: 'Reset link generated, but email could not be delivered.',
          description: r.emailError ?? 'Copy the link below and send it manually.',
          manualLink: r.manualLink,
        });
      }
    } catch (e) {
      setActionFeedback({
        tone: 'error',
        title: 'Could not send password reset.',
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setActionBusy(null);
    }
  };

  const handleResendInvite = async () => {
    if (!managing) return;
    setActionBusy('resend_invite');
    setActionFeedback(null);
    try {
      const r = await resendStaffInvite(managing.staff_member_id);
      // The resend always mints a fresh token + URL; snap the
      // pending-link state to the new URL immediately so the
      // copyable field in the Invite & sign-in panel matches the
      // link in the just-sent email. Resend invites set a fresh 7-
      // day expiry, so expired is always false here.
      if (r.inviteUrl) {
        setPendingInviteLink({
          kind: 'ready',
          url: r.inviteUrl,
          expired: false,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        });
      }
      if (r.emailSent) {
        setActionFeedback({
          tone: 'success',
          title: 'Invite re-sent.',
          description: `A fresh invite landed in ${managing.login_email}. The link is valid for 7 days; previous invite links are now invalid. The new link is also shown above so you can copy it as a backup.`,
        });
        staff.refresh();
      } else {
        setActionFeedback({
          tone: 'error',
          title: 'Invite generated, but email could not be delivered.',
          description: r.emailError ?? 'Copy the link above and send it manually.',
          manualLink: r.manualLink,
        });
      }
    } catch (e) {
      setActionFeedback({
        tone: 'error',
        title: 'Could not resend invite.',
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setActionBusy(null);
    }
  };

  const handleSendMagicLink = async () => {
    if (!managing) return;
    setActionBusy('magic_link');
    setActionFeedback(null);
    try {
      const r = await sendMagicLink(managing.staff_member_id);
      if (r.emailSent) {
        setActionFeedback({
          tone: 'success',
          title: 'Sign-in link sent.',
          description: `Delivered to ${managing.login_email}. The link is good for ten minutes.`,
        });
      } else {
        setActionFeedback({
          tone: 'error',
          title: 'Sign-in link generated, but email could not be delivered.',
          description: r.emailError ?? 'Copy the link below and send it manually.',
          manualLink: r.manualLink,
        });
      }
    } catch (e) {
      setActionFeedback({
        tone: 'error',
        title: 'Could not send sign-in link.',
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setActionBusy(null);
    }
  };

  const handleReset2fa = async () => {
    if (!managing) return;
    setActionBusy('reset_2fa');
    setActionFeedback(null);
    try {
      const r = await resetTwoFactor(managing.staff_member_id);
      setActionFeedback({
        tone: 'success',
        title:
          r.factorsRemoved === 0
            ? 'No authenticators were enrolled.'
            : `Removed ${r.factorsRemoved} authenticator${r.factorsRemoved === 1 ? '' : 's'}.`,
        description:
          r.factorsRemoved === 0
            ? 'There were no MFA factors to remove.'
            : 'They will be prompted to enrol a new authenticator on next sign-in if 2FA is required.',
      });
      setConfirmReset2fa(false);
    } catch (e) {
      setActionFeedback({
        tone: 'error',
        title: 'Could not reset 2FA.',
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setActionBusy(null);
    }
  };

  const handleToggleRequire2fa = async (next: boolean) => {
    if (!managing) return;
    setActionBusy('toggle_2fa');
    setActionFeedback(null);
    // Optimistic — flip the in-sheet row immediately so the toggle
    // doesn't fight the user's click. Refresh after the write lands.
    setManaging((cur) => (cur ? { ...cur, require_2fa: next } : cur));
    try {
      await setRequire2fa(managing.staff_member_id, next);
      staff.refresh();
    } catch (e) {
      setManaging((cur) => (cur ? { ...cur, require_2fa: !next } : cur));
      setActionFeedback({
        tone: 'error',
        title: 'Could not update the 2FA requirement.',
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setActionBusy(null);
    }
  };

  const submitDeactivate = async () => {
    if (!managing) return;
    setDeactivateBusy(true);
    setError(null);
    try {
      await deactivateStaffMember(managing.staff_member_id);
      staff.refresh();
      setManaging(null);
      setConfirmDeactivate(false);
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

  // Assigns or clears a staff member's job title. Optimistic: flip
  // the local sheet immediately, then mirror the change. The
  // roleAssignBusy flag drives the dropdown's loading state without
  // locking every other control in the sheet.
  const handleAssignRole = async (roleId: string | null) => {
    if (!managing) return;
    const prevRoleId = managing.role_id;
    const prevRoleName = managing.role_name;
    const nextRoleName = roleId ? roles.data.find((r) => r.id === roleId)?.name ?? null : null;
    setManaging((cur) => (cur ? { ...cur, role_id: roleId, role_name: nextRoleName } : cur));
    setRoleAssignBusy(true);
    setError(null);
    try {
      await setStaffRole(managing.staff_member_id, roleId);
      staff.refresh();
    } catch (e) {
      setManaging((cur) =>
        cur ? { ...cur, role_id: prevRoleId, role_name: prevRoleName } : cur,
      );
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRoleAssignBusy(false);
    }
  };

  const openRoles = () => {
    setRoleDraftName('');
    setRoleDraftDescription('');
    setRoleCreateError(null);
    setRoleRowError(null);
    setEditingRoleId(null);
    setShowArchivedRoles(false);
    setRolesOpen(true);
  };

  const closeRoles = () => {
    if (roleCreateBusy || roleRowBusy) return;
    setRolesOpen(false);
    setEditingRoleId(null);
  };

  const submitCreateRole = async () => {
    const name = roleDraftName.trim();
    if (!name) {
      setRoleCreateError('Enter a role name.');
      return;
    }
    setRoleCreateBusy(true);
    setRoleCreateError(null);
    try {
      await createStaffRole({
        name,
        description: roleDraftDescription.trim() || null,
      });
      setRoleDraftName('');
      setRoleDraftDescription('');
      roles.refresh();
    } catch (e) {
      setRoleCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setRoleCreateBusy(false);
    }
  };

  const beginEditRole = (row: StaffRoleRow) => {
    setEditingRoleId(row.id);
    setEditingRoleName(row.name);
    setEditingRoleDescription(row.description ?? '');
    setRoleRowError(null);
  };

  const submitEditRole = async () => {
    if (!editingRoleId) return;
    const name = editingRoleName.trim();
    if (!name) {
      setRoleRowError('Role name cannot be empty.');
      return;
    }
    setRoleRowBusy(editingRoleId);
    setRoleRowError(null);
    try {
      await updateStaffRole(editingRoleId, {
        name,
        description: editingRoleDescription.trim() || null,
      });
      setEditingRoleId(null);
      roles.refresh();
      // Refresh the staff list too — a rename should propagate to the
      // pills in the Manage sheet and the row list.
      staff.refresh();
    } catch (e) {
      setRoleRowError(e instanceof Error ? e.message : String(e));
    } finally {
      setRoleRowBusy(null);
    }
  };

  const handleArchiveRole = async (row: StaffRoleRow) => {
    setRoleRowBusy(row.id);
    setRoleRowError(null);
    try {
      await archiveStaffRole(row.id);
      roles.refresh();
    } catch (e) {
      setRoleRowError(e instanceof Error ? e.message : String(e));
    } finally {
      setRoleRowBusy(null);
    }
  };

  const handleUnarchiveRole = async (row: StaffRoleRow) => {
    setRoleRowBusy(row.id);
    setRoleRowError(null);
    try {
      await unarchiveStaffRole(row.id);
      roles.refresh();
    } catch (e) {
      setRoleRowError(e instanceof Error ? e.message : String(e));
    } finally {
      setRoleRowBusy(null);
    }
  };

  // Optimistic toggle for the three section-access flags. The old
  // version awaited the Supabase write + a full staff refetch before
  // the checkbox visually updated, which made every click feel like a
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
    setManaging((cur) =>
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
        setManaging((cur) =>
          cur && cur.staff_member_id === staffMemberId ? { ...cur, [field]: prev } : cur,
        );
        setError(e instanceof Error ? e.message : String(e));
      });
  };

  // Toggles a single tab key on/off in admin_page_access. The whole
  // array is rewritten on every change rather than diff'd because
  // Postgres' JSONB arrays don't have an efficient "remove one
  // element" primitive — the round trip cost is identical either way.
  // Optimistic update so each click responds instantly; pageBusy
  // locks the just-clicked row until the write confirms so rapid
  // taps don't race against the server.
  const togglePageAccess = (staffMemberId: string, tabKey: string, next: boolean) => {
    if (!canEditPageAccess) return;
    setManaging((cur) => {
      if (!cur || cur.staff_member_id !== staffMemberId) return cur;
      const has = cur.admin_page_access.includes(tabKey);
      const nextList = next
        ? has
          ? cur.admin_page_access
          : [...cur.admin_page_access, tabKey].sort()
        : cur.admin_page_access.filter((k) => k !== tabKey);
      return { ...cur, admin_page_access: nextList };
    });
    setPageBusy(tabKey);
    setError(null);
    // Read the latest list off the freshest managing snapshot we have.
    const sourceRow = managing?.staff_member_id === staffMemberId ? managing : staff.data.find((s) => s.staff_member_id === staffMemberId);
    const nextList = next
      ? Array.from(new Set([...(sourceRow?.admin_page_access ?? []), tabKey]))
      : (sourceRow?.admin_page_access ?? []).filter((k) => k !== tabKey);
    setAdminPageAccess(staffMemberId, nextList)
      .then(() => {
        staff.refresh();
      })
      .catch((e) => {
        // Revert.
        setManaging((cur) => {
          if (!cur || cur.staff_member_id !== staffMemberId) return cur;
          return { ...cur, admin_page_access: sourceRow?.admin_page_access ?? [] };
        });
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setPageBusy(null));
  };

  const nameDirty =
    managing !== null &&
    (draftFirst.trim() !== (managing.first_name ?? '') || draftLast.trim() !== (managing.last_name ?? ''));

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
        <div style={{ display: 'flex', gap: theme.space[2], flexWrap: 'wrap' }}>
          <Button variant="secondary" size="sm" onClick={openRoles}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
              <Briefcase size={14} aria-hidden /> Manage roles
            </span>
          </Button>
          <Button variant="primary" size="sm" onClick={openAdd}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
              <Plus size={14} aria-hidden /> Add staff member
            </span>
          </Button>
        </div>
      </div>

      <StaffSummary
        active={activeStaff.length}
        admins={adminCount}
        limited={limitedAdminCount}
        inactive={inactiveCount}
      />

      <div style={{ marginTop: theme.space[4], marginBottom: theme.space[4], display: 'flex', gap: theme.space[3], flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ flex: '1 1 240px', minWidth: 200 }}>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or email"
            aria-label="Search staff"
          />
        </div>
        {inactiveCount > 0 ? (
          <Button variant="tertiary" size="sm" onClick={() => setShowInactive((v) => !v)}>
            {showInactive
              ? `Hide ${inactiveCount} deactivated`
              : `Show ${inactiveCount} deactivated`}
          </Button>
        ) : null}
      </div>

      <div style={{ marginBottom: theme.space[4] }}>
        {staff.loading ? (
          <Skeleton height={120} />
        ) : staff.error ? (
          <p style={{ color: theme.color.alert, margin: 0 }}>Could not load staff: {staff.error}</p>
        ) : visibleStaff.length === 0 ? (
          <EmptyState
            icon={<Users size={20} />}
            title={searchTerm ? 'No matches' : 'No staff yet'}
            description={searchTerm ? 'No staff member matched that search.' : 'Add the first staff member to get started.'}
          />
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
            {visibleStaff.map((s) => {
              const isInactive = s.status === 'inactive';
              const isSuperAdminRow = s.login_email === 'dylan@lanquez.com';
              const nameMissing = !s.first_name || !s.last_name;
              const pageGrantCount = s.admin_page_access.length;
              return (
                <li
                  key={s.staff_member_id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: theme.space[4],
                    padding: theme.space[4],
                    background: isInactive ? theme.color.bg : theme.color.surface,
                    border: `1px solid ${theme.color.border}`,
                    borderRadius: 12,
                    opacity: isInactive ? 0.7 : 1,
                    flexWrap: 'wrap',
                  }}
                >
                  <div style={{ flex: '1 1 240px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: theme.space[1] }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], flexWrap: 'wrap' }}>
                      <span style={{ fontSize: theme.type.size.base, fontWeight: theme.type.weight.semibold, color: theme.color.ink }}>
                        {s.display_name}
                      </span>
                      {isInactive ? (
                        <StatusPill tone="cancelled" size="sm">Deactivated</StatusPill>
                      ) : (
                        <>
                          {s.role_name ? <RolePill tone="neutral">{s.role_name}</RolePill> : null}
                          {isSuperAdminRow ? (
                            <RolePill tone="accent">Super admin</RolePill>
                          ) : s.is_admin ? (
                            <RolePill tone="accent">Admin</RolePill>
                          ) : pageGrantCount > 0 ? (
                            <RolePill tone="accent-soft">
                              Admin · {pageGrantCount} {pageGrantCount === 1 ? 'page' : 'pages'}
                            </RolePill>
                          ) : null}
                          {s.is_manager ? <RolePill tone="neutral">Manager</RolePill> : null}
                          {s.is_customer_service ? <RolePill tone="neutral">Customer Service</RolePill> : null}
                          {s.require_2fa ? <RolePill tone="neutral">2FA required</RolePill> : null}
                          {/* Pending-invite indicator. Three states
                              surface here, all gated on
                              !invite_accepted_at:
                                - Awaiting invite: row has no
                                  invite_sent_at yet — either freshly
                                  reset (admin needs to click Resend
                                  for the first time) or a row that
                                  predates the custom-token flow and
                                  was reset by 20260520000008.
                                - Pending invite: invite_sent_at set
                                  and within the 7-day window.
                                - Invite expired: invite_sent_at set
                                  and invite_expires_at in the past.
                              Pre-feature accounts that accepted under
                              the old Supabase flow have invite_accepted_at
                              backfilled to hired_at and never enter
                              any of these states. */}
                          {!s.invite_accepted_at
                            ? (() => {
                                if (!s.invite_sent_at) {
                                  return (
                                    <StatusPill tone="unsuitable" size="sm">
                                      Awaiting invite
                                    </StatusPill>
                                  );
                                }
                                const expiresMs = s.invite_expires_at
                                  ? new Date(s.invite_expires_at).getTime()
                                  : null;
                                const expired = !!(
                                  expiresMs &&
                                  Number.isFinite(expiresMs) &&
                                  expiresMs < Date.now()
                                );
                                return (
                                  <StatusPill tone={expired ? 'cancelled' : 'unsuitable'} size="sm">
                                    {expired ? 'Invite expired' : 'Pending invite'}
                                  </StatusPill>
                                );
                              })()
                            : null}
                        </>
                      )}
                      {nameMissing && !isInactive ? (
                        <span style={{ fontSize: theme.type.size.xs, color: theme.color.warn, fontWeight: theme.type.weight.medium }}>
                          Name incomplete
                        </span>
                      ) : null}
                    </div>
                    <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.login_email || 'No login email'}
                      {/* Surface the location binding right under the
                          email. Every booking this staff member creates
                          from the Schedule or Walk-in flow lands at
                          this location; an admin scanning the list can
                          spot when someone's bound to the wrong clinic
                          at a glance. Null when the account predates
                          accounts.location_id or hasn't been assigned. */}
                      {s.location_name ? (
                        <>
                          <span aria-hidden style={{ margin: `0 ${theme.space[1]}px`, opacity: 0.4 }}>·</span>
                          {s.location_name}
                          {s.location_type ? ` ${s.location_type}` : ''}
                          {s.location_city ? `, ${s.location_city}` : ''}
                        </>
                      ) : (
                        <>
                          <span aria-hidden style={{ margin: `0 ${theme.space[1]}px`, opacity: 0.4 }}>·</span>
                          <span style={{ color: theme.color.warn, fontWeight: theme.type.weight.medium }}>
                            No location assigned
                          </span>
                        </>
                      )}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: theme.space[2], flex: '0 0 auto' }}>
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
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => openManage(s)}
                      >
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
                          <Settings size={14} aria-hidden /> Manage
                        </span>
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {error ? (
        <p role="alert" style={{ marginTop: theme.space[3], color: theme.color.alert, fontSize: theme.type.size.sm }}>
          {error}
        </p>
      ) : null}

      <BottomSheet
        open={managing !== null}
        onClose={closeManage}
        dismissable={!nameBusy && !actionBusy && !deactivateBusy}
        title={managing ? `Manage ${managing.display_name}` : 'Manage staff'}
        description={managing?.login_email ?? undefined}
        footer={
          <div style={{ display: 'flex', gap: theme.space[3], justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={closeManage} disabled={nameBusy || !!actionBusy || deactivateBusy}>
              Done
            </Button>
          </div>
        }
      >
        {managing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[6] }}>
            <ManageSection
              title="Identity"
              description="Name lands on every signature, payment, and discount this person signs off. Pre-fills the witness field on waivers automatically."
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
                <div style={{ display: 'flex', gap: theme.space[3], flexWrap: 'wrap' }}>
                  <div style={{ flex: '1 1 160px' }}>
                    <Input
                      label="First name"
                      value={draftFirst}
                      onChange={(e) => setDraftFirst(e.target.value)}
                      placeholder="e.g. Sarah"
                    />
                  </div>
                  <div style={{ flex: '1 1 160px' }}>
                    <Input
                      label="Last name"
                      value={draftLast}
                      onChange={(e) => setDraftLast(e.target.value)}
                      placeholder="e.g. Mackay"
                    />
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={saveName}
                    loading={nameBusy}
                    disabled={!nameDirty || nameBusy}
                  >
                    Save name
                  </Button>
                </div>
              </div>
            </ManageSection>

            <ManageSection
              title="Job title"
              description="What this person actually does day-to-day. Independent of the permissions below — a hygienist and a receptionist might both be Managers, but they're different jobs. Manage the catalogue from the Manage roles button."
              icon={<Briefcase size={14} aria-hidden />}
            >
              <StaffRoleField
                value={managing.role_id}
                roles={roles.data.filter((r) => r.archived_at === null || r.id === managing.role_id)}
                rolesLoading={roles.loading}
                onAssign={handleAssignRole}
                onManage={openRoles}
                busy={roleAssignBusy}
              />
            </ManageSection>

            <ManageSection
              title="Location"
              description="Which clinic this person is bound to. Drives every location-axis filter in Lounge: which schedule they see, which till they post payments against, which patient pool they search. Leave it unassigned and most of the app will look empty to them on sign-in."
            >
              <DropdownSelect<string>
                ariaLabel="Location"
                value={managing.location_id ?? ''}
                placeholder={locations.loading ? 'Loading locations…' : 'Choose a clinic'}
                disabled={locationAssignBusy || locations.loading || (locations.data?.length ?? 0) === 0}
                options={[
                  { value: '', label: 'No location' },
                  ...(locations.data ?? []).map((l) => ({
                    value: l.id,
                    // "The Venneir Clinic, lab · Glasgow" — keeps the
                    // type/city visible so two same-named rows (the
                    // Glasgow practice and lab share the venneir
                    // name) are distinguishable in the dropdown.
                    label: [
                      l.name,
                      l.type ? `, ${l.type}` : '',
                      l.city ? ` · ${l.city}` : '',
                    ].join(''),
                  })),
                ]}
                onChange={(next) => {
                  void saveLocation(next === '' ? null : next);
                }}
              />
              {!managing.location_id ? (
                <p
                  style={{
                    margin: `${theme.space[2]}px 0 0`,
                    fontSize: theme.type.size.xs,
                    color: theme.color.warn,
                    fontWeight: theme.type.weight.medium,
                    lineHeight: theme.type.leading.relaxed,
                  }}
                >
                  No location assigned. Most of the app will render empty for this person until you pick one.
                </p>
              ) : null}
            </ManageSection>

            <ManageSection
              title="Permissions"
              description="Admin opens the /admin tab and unlocks every page below by default. Manager picks who gets notified when a cashier applies a discount, issues a refund, or voids a payment at the till."
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
                <PermissionRow
                  title="Admin"
                  description="Full /admin access. Sees every tab, can manage staff, configure the catalogue, and view financials."
                  checked={managing.is_admin}
                  disabled={!canEditAdmin || managing.login_email === 'dylan@lanquez.com'}
                  disabledReason={
                    managing.login_email === 'dylan@lanquez.com'
                      ? 'The super admin role is permanent.'
                      : canEditAdmin
                        ? undefined
                        : 'Only the super admin can promote or demote admins.'
                  }
                  onChange={(v) => toggleAdmin(managing.staff_member_id, v)}
                />
                <PermissionRow
                  title="Manager"
                  description="Eligible to be ticked as a notification recipient in Admin, Emails, Manager notifications. Each ticked manager gets an email whenever a cashier applies a discount, issues a refund, or voids a payment. Distinct from Admin: a manager doesn't see /admin unless they're also an admin."
                  checked={managing.is_manager}
                  onChange={(v) => toggleManager(managing.staff_member_id, v)}
                />
                <PermissionRow
                  title="Customer Service"
                  description="Patient-comms agent role. Sees a focused view: book, reschedule, cancel, and resend confirmation emails. Loses clinic-floor actions (arrival, no-show, cart, payment, Print LWO, end visit early, tech notes). Admins or managers flagged as CS keep their full access."
                  checked={managing.is_customer_service}
                  onChange={(v) => toggleCustomerService(managing.staff_member_id, v)}
                />
              </div>
            </ManageSection>

            <ManageSection
              title="Section access"
              description="Top-level destinations outside the /admin tab. Reports defaults on; Financials and Cash counting are super-admin grants only."
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
                <PermissionRow
                  title="Reports"
                  description="Operational dashboards covering bookings, demographics, marketing, service mix, lifetime value."
                  checked={managing.can_view_reports}
                  onChange={(v) => togglePerm(managing.staff_member_id, 'reports', v)}
                />
                <PermissionRow
                  title="Financials"
                  description="Sales, discounts, voids, anomaly flags, cash reconciliation. Super-admin-grant only."
                  checked={managing.can_view_financials}
                  disabled={!canEditFinancialPerms}
                  disabledReason={canEditFinancialPerms ? undefined : 'Only the super admin can grant Financials access.'}
                  onChange={(v) => togglePerm(managing.staff_member_id, 'financials', v)}
                />
                <PermissionRow
                  title="Cash counting"
                  description="Lets this person initiate a cash reconciliation count. Sign-off still requires a different manager. Super-admin-grant only."
                  checked={managing.can_count_cash}
                  disabled={!canEditFinancialPerms}
                  disabledReason={canEditFinancialPerms ? undefined : 'Only the super admin can grant Cash counting access.'}
                  onChange={(v) => togglePerm(managing.staff_member_id, 'cash', v)}
                />
              </div>
            </ManageSection>

            <ManageSection
              title="Admin pages"
              description={
                managing.is_admin
                  ? 'This person is a full admin — every page is unlocked. Remove the Admin role above to grant page-by-page access instead.'
                  : 'Grant access to specific /admin pages without making this person a full admin. They land on /admin and only see the pages you tick here. Staff and Testing are admin-only and can never be granted as a page.'
              }
              icon={<Layers size={14} aria-hidden />}
            >
              {managing.is_admin ? (
                <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkSubtle, fontStyle: 'italic' }}>
                  Page-level grants are inactive while this person is a full admin.
                </p>
              ) : (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                    gap: theme.space[2],
                  }}
                >
                  {MANAGEABLE_ADMIN_TABS.map((t) => {
                    const checked = managing.admin_page_access.includes(t.key);
                    return (
                      <label
                        key={t.key}
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: theme.space[2],
                          padding: theme.space[3],
                          border: `1px solid ${checked ? theme.color.accent : theme.color.border}`,
                          borderRadius: theme.radius.input,
                          background: checked ? theme.color.accentBg : theme.color.surface,
                          cursor: canEditPageAccess ? 'pointer' : 'not-allowed',
                          opacity: canEditPageAccess ? 1 : 0.65,
                        }}
                      >
                        <Checkbox
                          checked={checked}
                          onChange={(v) => togglePageAccess(managing.staff_member_id, t.key, v)}
                          disabled={!canEditPageAccess || pageBusy === t.key}
                          ariaLabel={t.label}
                        />
                        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <span style={{ fontSize: theme.type.size.sm, fontWeight: theme.type.weight.semibold, color: theme.color.ink }}>
                            {t.label}
                          </span>
                          <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkMuted, lineHeight: theme.type.leading.relaxed }}>
                            {t.description}
                          </span>
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
            </ManageSection>

            <ManageSection
              title="Invite & sign-in"
              description="When their invite was sent, when they accepted it, and the last time they signed in."
            >
              <InviteStatusPanel
                inviteSentAt={managing.invite_sent_at}
                inviteExpiresAt={managing.invite_expires_at}
                inviteAcceptedAt={managing.invite_accepted_at}
                lastSignInAt={managing.last_sign_in_at}
                hiredAt={managing.hired_at}
                pendingInviteLink={pendingInviteLink}
              />
            </ManageSection>

            <ManageSection
              title="Account actions"
              description="Send sign-in help or remove their authenticator. Every action is delivered to their email on file."
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[6] }}>
                {!managing.invite_accepted_at ? (
                  <ActionRow
                    icon={<Mail size={16} aria-hidden />}
                    title="Resend invite"
                    description="Re-sends the staff_invite email with a fresh 7-day link. The previous invite (if any) is voided so older emails can't be used. Hidden once the staff member has accepted; use Send password reset after that."
                    cta="Resend invite"
                    loading={actionBusy === 'resend_invite'}
                    disabled={!!actionBusy}
                    onClick={handleResendInvite}
                  />
                ) : null}
                <ActionRow
                  icon={<KeyRound size={16} aria-hidden />}
                  title="Send password reset link"
                  description="Emails a one-time link they can use to set a new password. Use this when a new starter never set theirs, or for forgotten-password support."
                  cta="Send reset link"
                  loading={actionBusy === 'password_reset'}
                  disabled={!!actionBusy}
                  onClick={handleSendPasswordReset}
                />
                <ActionRow
                  icon={<Mail size={16} aria-hidden />}
                  title="Send sign-in link"
                  description="Emails a one-time magic link that signs them in without a password. Useful as a fallback when password reset isn't reaching their inbox."
                  cta="Send sign-in link"
                  loading={actionBusy === 'magic_link'}
                  disabled={!!actionBusy}
                  onClick={handleSendMagicLink}
                />
                <ActionRow
                  icon={<ShieldAlert size={16} aria-hidden />}
                  title="Reset two-factor authentication"
                  description="Removes the authenticator app linked to their account. They'll be prompted to enrol a new one on next sign-in if 2FA is required."
                  cta={confirmReset2fa ? 'Confirm reset' : 'Reset 2FA'}
                  ctaTone={confirmReset2fa ? 'alert' : 'default'}
                  loading={actionBusy === 'reset_2fa'}
                  disabled={!!actionBusy}
                  onClick={() => {
                    if (!confirmReset2fa) {
                      setConfirmReset2fa(true);
                      return;
                    }
                    void handleReset2fa();
                  }}
                  secondaryCta={confirmReset2fa ? 'Cancel' : undefined}
                  onSecondary={confirmReset2fa ? () => setConfirmReset2fa(false) : undefined}
                />
                <ActionRow
                  icon={<ShieldCheck size={16} aria-hidden />}
                  title="Require two-factor authentication"
                  description="When enabled, this person must enrol an authenticator app on their next sign-in before they can use Lounge. If they already have 2FA set up, nothing changes for them."
                  toggleChecked={managing.require_2fa}
                  onToggle={handleToggleRequire2fa}
                  toggleDisabled={!!actionBusy}
                  toggleLoading={actionBusy === 'toggle_2fa'}
                />
                {actionFeedback ? (
                  <div
                    role={actionFeedback.tone === 'error' ? 'alert' : 'status'}
                    style={{
                      margin: 0,
                      padding: theme.space[4],
                      background: actionFeedback.tone === 'error' ? 'rgba(184, 58, 42, 0.06)' : theme.color.accentBg,
                      border: `1px solid ${actionFeedback.tone === 'error' ? 'rgba(184, 58, 42, 0.18)' : theme.color.border}`,
                      borderRadius: theme.radius.input,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: theme.space[2],
                    }}
                  >
                    <p style={{ margin: 0, fontSize: theme.type.size.sm, fontWeight: theme.type.weight.semibold, color: actionFeedback.tone === 'error' ? theme.color.alert : theme.color.ink }}>
                      {actionFeedback.title}
                    </p>
                    {actionFeedback.description ? (
                      <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted, lineHeight: theme.type.leading.relaxed }}>
                        {actionFeedback.description}
                      </p>
                    ) : null}
                    {actionFeedback.manualLink ? (
                      <>
                        <textarea
                          readOnly
                          value={actionFeedback.manualLink}
                          onFocus={(e) => e.currentTarget.select()}
                          style={{
                            width: '100%',
                            minHeight: 72,
                            padding: theme.space[3],
                            border: `1px solid ${theme.color.border}`,
                            borderRadius: theme.radius.input,
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                            fontSize: theme.type.size.xs,
                            background: theme.color.surface,
                            color: theme.color.ink,
                            resize: 'vertical',
                            boxSizing: 'border-box',
                          }}
                        />
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            if (actionFeedback.manualLink) {
                              void navigator.clipboard?.writeText(actionFeedback.manualLink).catch(() => {});
                            }
                          }}
                        >
                          Copy link
                        </Button>
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </ManageSection>

            {managing.login_email === 'dylan@lanquez.com' || managing.account_id === currentAccount?.account_id ? null : (
              <ManageSection
                title="Danger zone"
                description="Deactivation immediately removes Lounge access. Their attribution on every past signature, payment, and discount they signed off stays in place. Their access to Meridian or any other Venneir tool is untouched. You can reactivate them later."
                tone="alert"
              >
                {confirmDeactivate ? (
                  <div style={{ display: 'flex', gap: theme.space[3], alignItems: 'center', flexWrap: 'wrap' }}>
                    <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.alert, fontWeight: theme.type.weight.semibold }}>
                      Deactivate {managing.display_name}?
                    </p>
                    <div style={{ display: 'flex', gap: theme.space[2], marginLeft: 'auto' }}>
                      <Button variant="tertiary" size="sm" onClick={() => setConfirmDeactivate(false)} disabled={deactivateBusy}>
                        Cancel
                      </Button>
                      <Button variant="primary" size="sm" onClick={submitDeactivate} loading={deactivateBusy}>
                        Confirm deactivate
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <Button variant="secondary" size="sm" onClick={() => setConfirmDeactivate(true)}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1], color: theme.color.alert }}>
                        <Trash2 size={14} aria-hidden /> Deactivate
                      </span>
                    </Button>
                  </div>
                )}
              </ManageSection>
            )}
          </div>
        ) : (
          <div />
        )}
      </BottomSheet>

      <BottomSheet
        open={addOpen}
        onClose={() => !addBusy && setAddOpen(false)}
        dismissable={!addBusy}
        title="Add staff member"
        description="If the email already has an account, they keep that login and just gain Lounge access. If not, we create a brand-new Lounge sign-in and email them an invite to set a password."
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
          <div style={{ display: 'flex', gap: theme.space[3] }}>
            <Input
              label="First name"
              value={addFirstName}
              onChange={(e) => setAddFirstName(e.target.value)}
              placeholder="e.g. Sarah"
              autoFocus
            />
            <Input
              label="Last name"
              value={addLastName}
              onChange={(e) => setAddLastName(e.target.value)}
              placeholder="e.g. Mackay"
            />
          </div>
          <Input
            label="Login email"
            type="email"
            value={addEmail}
            onChange={(e) => setAddEmail(e.target.value)}
            placeholder="e.g. sarah@venneir.com"
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
          {addManualInviteLink ? (
            <div
              style={{
                margin: 0,
                padding: theme.space[4],
                background: theme.color.accentBg,
                borderRadius: theme.radius.input,
                border: `1px solid ${theme.color.border}`,
                display: 'flex',
                flexDirection: 'column',
                gap: theme.space[3],
              }}
            >
              <p style={{ margin: 0, fontSize: theme.type.size.sm, fontWeight: theme.type.weight.semibold, color: theme.color.ink }}>
                {addManualInviteLink.reason
                  ? `Account created for ${addManualInviteLink.name}, but the invite email could not be delivered.`
                  : `Account created. Invite emailed to ${addManualInviteLink.email}.`}
              </p>
              <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted, lineHeight: theme.type.leading.relaxed }}>
                {addManualInviteLink.reason
                  ? `Copy this invite link and send it to ${addManualInviteLink.email} yourself. The link is valid for 7 days. (Reason: ${addManualInviteLink.reason})`
                  : `Here's the invite link too, in case it doesn't reach the inbox (corporate spam filters quietly drop legit mail). Hand-deliver via Slack or WhatsApp if needed. The link is valid for 7 days.`}
              </p>
              <textarea
                readOnly
                value={addManualInviteLink.link}
                onFocus={(e) => e.currentTarget.select()}
                style={{
                  width: '100%',
                  minHeight: 80,
                  padding: theme.space[3],
                  border: `1px solid ${theme.color.border}`,
                  borderRadius: theme.radius.input,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: theme.type.size.xs,
                  background: theme.color.surface,
                  color: theme.color.ink,
                  resize: 'vertical',
                  boxSizing: 'border-box',
                }}
              />
              <div style={{ display: 'flex', gap: theme.space[2] }}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard?.writeText(addManualInviteLink.link).catch(() => {});
                  }}
                >
                  Copy link
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    setAddManualInviteLink(null);
                    setAddOpen(false);
                  }}
                >
                  Done
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </BottomSheet>

      <BottomSheet
        open={rolesOpen}
        onClose={closeRoles}
        dismissable={!roleCreateBusy && roleRowBusy === null}
        title="Manage roles"
        description="The job-title catalogue every staff member picks from. Add roles you actually use at the clinic (Receptionist, Treatment Coordinator, Hygienist, etc.). Renaming or archiving here propagates to every staff card."
        footer={
          <div style={{ display: 'flex', gap: theme.space[3], justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={closeRoles} disabled={roleCreateBusy || roleRowBusy !== null}>
              Done
            </Button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[6] }}>
          <ManageSection title="Add a new role" description="Name is required. Description is optional but useful for explaining who the role is for.">
            <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
              <Input
                label="Role name"
                value={roleDraftName}
                onChange={(e) => setRoleDraftName(e.target.value)}
                placeholder="e.g. Receptionist"
              />
              <Input
                label="Description (optional)"
                value={roleDraftDescription}
                onChange={(e) => setRoleDraftDescription(e.target.value)}
                placeholder="e.g. Front of house, books appointments, takes payments."
              />
              {roleCreateError ? (
                <p role="alert" style={{ margin: 0, color: theme.color.alert, fontSize: theme.type.size.sm }}>
                  {roleCreateError}
                </p>
              ) : null}
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={submitCreateRole}
                  loading={roleCreateBusy}
                  disabled={!roleDraftName.trim() || roleCreateBusy}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
                    <Plus size={14} aria-hidden /> Add role
                  </span>
                </Button>
              </div>
            </div>
          </ManageSection>

          <ManageSection
            title="Roles"
            description={
              roles.data.filter((r) => r.archived_at === null).length === 0
                ? 'No roles yet. Add the first one above.'
                : 'Click a row to rename or archive. Archived roles disappear from the assignment dropdown but stay on existing staff cards.'
            }
          >
            {roleRowError ? (
              <p role="alert" style={{ margin: 0, marginBottom: theme.space[2], color: theme.color.alert, fontSize: theme.type.size.sm }}>
                {roleRowError}
              </p>
            ) : null}
            {roles.loading ? (
              <Skeleton height={120} />
            ) : roles.error ? (
              <p style={{ color: theme.color.alert, margin: 0 }}>Could not load roles: {roles.error}</p>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
                {(showArchivedRoles ? roles.data : roles.data.filter((r) => r.archived_at === null)).map((row) => {
                  const isEditing = editingRoleId === row.id;
                  const isArchived = row.archived_at !== null;
                  return (
                    <li
                      key={row.id}
                      style={{
                        padding: theme.space[3],
                        background: isArchived ? theme.color.bg : theme.color.surface,
                        border: `1px solid ${theme.color.border}`,
                        borderRadius: theme.radius.input,
                        opacity: isArchived ? 0.7 : 1,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: theme.space[3],
                      }}
                    >
                      {isEditing ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
                          <Input
                            label="Role name"
                            value={editingRoleName}
                            onChange={(e) => setEditingRoleName(e.target.value)}
                            autoFocus
                          />
                          <Input
                            label="Description"
                            value={editingRoleDescription}
                            onChange={(e) => setEditingRoleDescription(e.target.value)}
                          />
                          <div style={{ display: 'flex', gap: theme.space[2], justifyContent: 'flex-end' }}>
                            <Button variant="tertiary" size="sm" onClick={() => setEditingRoleId(null)} disabled={roleRowBusy === row.id}>
                              Cancel
                            </Button>
                            <Button variant="primary" size="sm" onClick={submitEditRole} loading={roleRowBusy === row.id}>
                              Save
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: theme.space[3], flexWrap: 'wrap' }}>
                          <div style={{ flex: '1 1 240px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: theme.space[1] }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], flexWrap: 'wrap' }}>
                              <span style={{ fontSize: theme.type.size.base, fontWeight: theme.type.weight.semibold, color: theme.color.ink }}>
                                {row.name}
                              </span>
                              {isArchived ? (
                                <StatusPill tone="cancelled" size="sm">Archived</StatusPill>
                              ) : null}
                              {row.member_count > 0 ? (
                                <RolePill tone="neutral">
                                  {row.member_count} {row.member_count === 1 ? 'person' : 'people'}
                                </RolePill>
                              ) : null}
                            </div>
                            {row.description ? (
                              <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted, lineHeight: theme.type.leading.relaxed }}>
                                {row.description}
                              </span>
                            ) : null}
                          </div>
                          <div style={{ display: 'flex', gap: theme.space[2], flex: '0 0 auto' }}>
                            <Button variant="tertiary" size="sm" onClick={() => beginEditRole(row)} disabled={roleRowBusy !== null}>
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
                                <Pencil size={14} aria-hidden /> Edit
                              </span>
                            </Button>
                            {isArchived ? (
                              <Button variant="tertiary" size="sm" onClick={() => handleUnarchiveRole(row)} loading={roleRowBusy === row.id}>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
                                  <ArchiveRestore size={14} aria-hidden /> Restore
                                </span>
                              </Button>
                            ) : (
                              <Button variant="tertiary" size="sm" onClick={() => handleArchiveRole(row)} loading={roleRowBusy === row.id}>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1], color: theme.color.alert }}>
                                  <Trash2 size={14} aria-hidden /> Archive
                                </span>
                              </Button>
                            )}
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {roles.data.some((r) => r.archived_at !== null) ? (
              <div style={{ marginTop: theme.space[3], display: 'flex', justifyContent: 'flex-end' }}>
                <Button variant="tertiary" size="sm" onClick={() => setShowArchivedRoles((v) => !v)}>
                  {showArchivedRoles
                    ? `Hide ${roles.data.filter((r) => r.archived_at !== null).length} archived`
                    : `Show ${roles.data.filter((r) => r.archived_at !== null).length} archived`}
                </Button>
              </div>
            ) : null}
          </ManageSection>
        </div>
      </BottomSheet>
    </Card>
  );
}

// Compact role-assignment field inside the Manage sheet. Wraps
// DropdownSelect with a sentinel "no role" option (value="" → null on
// assign) and an empty-state hint when the catalogue itself is empty.
function StaffRoleField({
  value,
  roles,
  rolesLoading,
  onAssign,
  onManage,
  busy,
}: {
  value: string | null;
  roles: StaffRoleRow[];
  rolesLoading: boolean;
  onAssign: (roleId: string | null) => void | Promise<void>;
  onManage: () => void;
  busy: boolean;
}) {
  if (rolesLoading) {
    return <Skeleton height={48} />;
  }
  if (roles.length === 0) {
    return (
      <div
        style={{
          padding: theme.space[3],
          border: `1px dashed ${theme.color.border}`,
          borderRadius: theme.radius.input,
          background: theme.color.bg,
          display: 'flex',
          flexDirection: 'column',
          gap: theme.space[2],
        }}
      >
        <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
          No roles in the catalogue yet. Add the roles your clinic uses, then assign them here.
        </p>
        <div>
          <Button variant="secondary" size="sm" onClick={onManage}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
              <Briefcase size={14} aria-hidden /> Manage roles
            </span>
          </Button>
        </div>
      </div>
    );
  }
  const NONE = '__none__';
  const opts = [
    { value: NONE, label: 'No role assigned' },
    ...roles.map((r) => ({ value: r.id, label: r.name })),
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
      <DropdownSelect<string>
        ariaLabel="Job title"
        value={value ?? NONE}
        options={opts}
        disabled={busy}
        onChange={(v) => onAssign(v === NONE ? null : v)}
      />
    </div>
  );
}

// Summary tiles at the top of Staff. Compact stat strip showing active
// roster size, admin headcount, limited-admin grants, and inactive
// staff. Kept inline (no Card wrapper) so it reads as a sub-section of
// the existing Staff card rather than a competing surface.
function StaffSummary({
  active,
  admins,
  limited,
  inactive,
}: {
  active: number;
  admins: number;
  limited: number;
  inactive: number;
}) {
  const items: { label: string; value: number; tone?: 'normal' | 'accent' | 'muted' }[] = [
    { label: 'Active', value: active, tone: 'accent' },
    { label: 'Full admins', value: admins },
    { label: 'Limited admins', value: limited },
    { label: 'Deactivated', value: inactive, tone: 'muted' },
  ];
  return (
    <div
      style={{
        marginTop: theme.space[5],
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: theme.space[2],
      }}
    >
      {items.map((it) => (
        <div
          key={it.label}
          style={{
            padding: theme.space[3],
            background: it.tone === 'accent' ? theme.color.accentBg : theme.color.bg,
            border: `1px solid ${theme.color.border}`,
            borderRadius: theme.radius.input,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <span
            style={{
              fontSize: theme.type.size.xs,
              color: theme.color.inkMuted,
              letterSpacing: theme.type.tracking.tight,
            }}
          >
            {it.label}
          </span>
          <span
            style={{
              fontSize: theme.type.size.xl,
              fontWeight: theme.type.weight.semibold,
              color: it.tone === 'muted' ? theme.color.inkMuted : theme.color.ink,
              letterSpacing: theme.type.tracking.tight,
            }}
          >
            {it.value}
          </span>
        </div>
      ))}
    </div>
  );
}

// Compact role tag used on the staff list rows. Lower-weight than
// StatusPill so a row of three pills doesn't out-shout the name; the
// accent / accent-soft / neutral tones cover the three distinctions
// that matter here (full admin / page-grant admin / non-admin role).
function RolePill({ tone, children }: { tone: 'accent' | 'accent-soft' | 'neutral'; children: ReactNode }) {
  const styles: CSSProperties =
    tone === 'accent'
      ? { background: theme.color.accent, color: theme.color.surface }
      : tone === 'accent-soft'
        ? { background: theme.color.accentBg, color: theme.color.accent, boxShadow: `inset 0 0 0 1px ${theme.color.accent}` }
        : { background: 'transparent', color: theme.color.inkMuted, boxShadow: `inset 0 0 0 1px ${theme.color.border}` };
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 20,
        padding: `0 ${theme.space[2]}px`,
        borderRadius: theme.radius.pill,
        fontSize: theme.type.size.xs,
        fontWeight: theme.type.weight.medium,
        letterSpacing: theme.type.tracking.tight,
        ...styles,
      }}
    >
      {children}
    </span>
  );
}

// Read-only summary of the staff member's invite + sign-in
// lifecycle, with a copyable invite URL surfaced for pending staff
// so admins have a manual fallback when Resend silently accepts an
// email that never reaches the inbox.
//
// Rows:
//   - Invite sent → expires (when never accepted) OR Invite
//     accepted (when accepted)
//   - Last signed in (when present)
//   - Joined Lounge (always — derived from hired_at)
//
// When invite_accepted_at is null and a token is still on file, a
// "Active invite link" card renders below the grid with the
// /welcome?invite=... URL in a read-only textarea + Copy button —
// same pattern as the Add Staff "could not be delivered" surface.
function InviteStatusPanel({
  inviteSentAt,
  inviteExpiresAt,
  inviteAcceptedAt,
  lastSignInAt,
  hiredAt,
  pendingInviteLink,
}: {
  inviteSentAt: string | null;
  inviteExpiresAt: string | null;
  inviteAcceptedAt: string | null;
  lastSignInAt: string | null;
  hiredAt: string;
  pendingInviteLink:
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'ready'; url: string | null; expired: boolean; expiresAt: string | null }
    | { kind: 'error'; message: string };
}) {
  const rows: Array<{ label: string; value: string; tone?: 'muted' | 'alert' }> = [];
  if (inviteAcceptedAt) {
    rows.push({ label: 'Invite accepted', value: formatLifecycleStamp(inviteAcceptedAt) });
  } else if (inviteSentAt) {
    rows.push({ label: 'Invite sent', value: formatLifecycleStamp(inviteSentAt) });
    if (inviteExpiresAt) {
      const expiresMs = new Date(inviteExpiresAt).getTime();
      const expired = Number.isFinite(expiresMs) && expiresMs < Date.now();
      rows.push({
        label: expired ? 'Invite expired' : 'Invite expires',
        value: formatLifecycleStamp(inviteExpiresAt),
        tone: expired ? 'alert' : 'muted',
      });
    }
  } else {
    rows.push({
      label: 'Invite',
      value: 'Never sent (pre-feature account)',
      tone: 'muted',
    });
  }
  rows.push({
    label: 'Last signed in',
    value: lastSignInAt ? formatLifecycleStamp(lastSignInAt) : 'Not yet',
    tone: lastSignInAt ? undefined : 'muted',
  });
  rows.push({
    label: 'Joined Lounge',
    value: formatLifecycleStamp(hiredAt),
  });
  // Only render the copy-link card when the row is pending AND we
  // have an actual URL (kind === 'ready' && url). Loading shows a
  // muted hint so the admin knows the fetch is in flight; error
  // surfaces the message in alert tone. Accepted staff and pre-
  // feature accounts (no token on file) get nothing here.
  const showLinkSection = !inviteAcceptedAt && pendingInviteLink.kind !== 'idle';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'max-content 1fr',
          columnGap: theme.space[5],
          rowGap: theme.space[2],
          padding: theme.space[4],
          background: theme.color.bg,
          border: `1px solid ${theme.color.border}`,
          borderRadius: theme.radius.input,
        }}
      >
        {rows.map((r, i) => (
          <Fragment key={`${r.label}|${i}`}>
            <span
              style={{
                fontSize: theme.type.size.xs,
                color: theme.color.inkMuted,
                fontWeight: theme.type.weight.medium,
                alignSelf: 'baseline',
              }}
            >
              {r.label}
            </span>
            <span
              style={{
                fontSize: theme.type.size.sm,
                color: r.tone === 'alert' ? theme.color.alert : theme.color.ink,
                fontWeight: theme.type.weight.medium,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {r.value}
            </span>
          </Fragment>
        ))}
      </div>
      {showLinkSection ? <PendingInviteLinkCard state={pendingInviteLink} /> : null}
    </div>
  );
}

// Renders the active /welcome?invite=... URL with a Copy button for
// staff who have a pending (un-accepted) invite. Same accent-bg
// pattern as the Add Staff manual-link card. Three states:
//   - loading: muted hint, no textarea
//   - error: alert text, retry hint
//   - ready (url present): readonly textarea + Copy button
//   - ready (url null): "no active token" hint with a "Resend invite"
//     pointer (the Action Row below still handles the actual send)
function PendingInviteLinkCard({
  state,
}: {
  state:
    | { kind: 'loading' }
    | { kind: 'ready'; url: string | null; expired: boolean; expiresAt: string | null }
    | { kind: 'error'; message: string };
}) {
  if (state.kind === 'loading') {
    return (
      <div
        style={{
          padding: theme.space[4],
          background: theme.color.accentBg,
          border: `1px solid ${theme.color.border}`,
          borderRadius: theme.radius.input,
          fontSize: theme.type.size.sm,
          color: theme.color.inkMuted,
        }}
      >
        Loading the active invite link…
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div
        style={{
          padding: theme.space[4],
          background: 'rgba(184, 58, 42, 0.06)',
          border: '1px solid rgba(184, 58, 42, 0.18)',
          borderRadius: theme.radius.input,
          fontSize: theme.type.size.sm,
          color: theme.color.alert,
        }}
      >
        Could not load the invite link: {state.message}
      </div>
    );
  }
  if (!state.url) {
    return (
      <div
        style={{
          padding: theme.space[4],
          background: theme.color.bg,
          border: `1px dashed ${theme.color.border}`,
          borderRadius: theme.radius.input,
          fontSize: theme.type.size.sm,
          color: theme.color.inkMuted,
          lineHeight: theme.type.leading.relaxed,
        }}
      >
        No active invite link on file. Use Resend invite below to mint a fresh 7-day link.
      </div>
    );
  }
  return (
    <div
      style={{
        padding: theme.space[4],
        background: theme.color.accentBg,
        border: `1px solid ${theme.color.border}`,
        borderRadius: theme.radius.input,
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[3],
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: theme.type.size.sm, fontWeight: theme.type.weight.semibold, color: theme.color.ink }}>
          Active invite link
        </span>
        <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkMuted, lineHeight: theme.type.leading.relaxed }}>
          {state.expired
            ? 'This invite has expired. Resend invite below to mint a fresh 7-day link.'
            : 'Same URL as the email. Copy this and hand-deliver via Slack, WhatsApp, or SMS if the email never lands in the inbox. Clicking Resend invite below mints a new URL and voids this one.'}
        </span>
      </div>
      <textarea
        readOnly
        value={state.url}
        onFocus={(e) => e.currentTarget.select()}
        style={{
          width: '100%',
          minHeight: 64,
          padding: theme.space[3],
          border: `1px solid ${theme.color.border}`,
          borderRadius: theme.radius.input,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: theme.type.size.xs,
          background: theme.color.surface,
          color: theme.color.ink,
          resize: 'vertical',
          boxSizing: 'border-box',
        }}
      />
      <div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            if (state.url) {
              void navigator.clipboard?.writeText(state.url).catch(() => {});
            }
          }}
        >
          Copy link
        </Button>
      </div>
    </div>
  );
}

function formatLifecycleStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Vertical layout for one section inside the Manage sheet. Title +
// description on top, content below. Keeps the rhythm consistent
// across six sections without forcing a single mega-Card per section.
function ManageSection({
  title,
  description,
  icon,
  tone = 'default',
  children,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  tone?: 'default' | 'alert';
  children: ReactNode;
}) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[1] }}>
        <h3
          style={{
            margin: 0,
            fontSize: theme.type.size.base,
            fontWeight: theme.type.weight.semibold,
            color: tone === 'alert' ? theme.color.alert : theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
            display: 'inline-flex',
            alignItems: 'center',
            gap: theme.space[2],
          }}
        >
          {icon}
          {title}
        </h3>
        {description ? (
          <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted, lineHeight: theme.type.leading.relaxed }}>
            {description}
          </p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

// Single row in the Account actions sheet. Renders as either a
// "title + description + button" affordance, OR with a toggle in
// place of the button when toggleChecked is supplied. Mirrors the
// PermissionRow pattern but with primary actions instead of policy
// flags so the visual rhythm in the sheet stays consistent.
function ActionRow({
  icon,
  title,
  description,
  cta,
  ctaTone = 'default',
  loading = false,
  disabled = false,
  onClick,
  secondaryCta,
  onSecondary,
  toggleChecked,
  onToggle,
  toggleDisabled,
  toggleLoading,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  cta?: string;
  ctaTone?: 'default' | 'alert';
  loading?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  secondaryCta?: string;
  onSecondary?: () => void;
  toggleChecked?: boolean;
  onToggle?: (next: boolean) => void;
  toggleDisabled?: boolean;
  toggleLoading?: boolean;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: theme.space[3] }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            borderRadius: theme.radius.input,
            background: theme.color.accentBg,
            color: theme.color.accent,
            flex: '0 0 auto',
          }}
        >
          {icon}
        </span>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <p style={{ margin: 0, fontSize: theme.type.size.sm, fontWeight: theme.type.weight.semibold, color: theme.color.ink }}>
            {title}
          </p>
          <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted, lineHeight: theme.type.leading.relaxed }}>
            {description}
          </p>
        </div>
      </div>
      <div style={{ display: 'flex', gap: theme.space[2], paddingLeft: 40 }}>
        {typeof toggleChecked === 'boolean' && onToggle ? (
          <Checkbox
            checked={toggleChecked}
            onChange={onToggle}
            disabled={toggleDisabled || toggleLoading}
            label={toggleChecked ? 'Required' : 'Not required'}
          />
        ) : null}
        {cta ? (
          <Button
            variant={ctaTone === 'alert' ? 'primary' : 'secondary'}
            size="sm"
            loading={loading}
            disabled={disabled}
            onClick={onClick}
          >
            {cta}
          </Button>
        ) : null}
        {secondaryCta && onSecondary ? (
          <Button variant="tertiary" size="sm" disabled={disabled} onClick={onSecondary}>
            {secondaryCta}
          </Button>
        ) : null}
      </div>
    </div>
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
                  {`${new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(f.occurred_at))} ${fmtTzAbbr(f.occurred_at)}`}
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
  // Local row order for optimistic drag-and-drop. Synced from filteredRows
  // after every DB refresh; diverges only during / immediately after a drag.
  const [localRows, setLocalRows] = useState<CatalogueRow[]>([]);

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

  useEffect(() => {
    setLocalRows(filteredRows);
  }, [filteredRows]);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = localRows.findIndex((r) => r.id === String(active.id));
    const newIndex = localRows.findIndex((r) => r.id === String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(localRows, oldIndex, newIndex);
    setLocalRows(reordered);
    try {
      await batchUpdateSortOrders(reordered.map((r, i) => ({ id: r.id, sort_order: i * 10 })));
      refresh();
    } catch (e) {
      setToast({ tone: 'error', title: 'Sort order save failed', description: e instanceof Error ? e.message : String(e) });
      setLocalRows(filteredRows);
    }
  };

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
        is_virtual: draft.is_virtual,
        meeting_platform: draft.is_virtual && draft.meeting_platform ? draft.meeting_platform : null,
        fulfilment_required: draft.fulfilment_required,
        sold_on_shopify: draft.sold_on_shopify,
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

  // Use localRows when populated (covers optimistic drag reorder), otherwise
  // fall back to filteredRows to avoid a blank frame after initial load.
  const displayRows = localRows.length > 0 ? localRows : filteredRows;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
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
            {isServices ? 'Services' : 'Products'}
          </h2>
          <p style={{ margin: `${theme.space[1]}px 0 0`, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
            {isServices
              ? 'Treatments and appointments your team books in. Shared with Checkpoint.'
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
        isServices ? (
          <ServiceForm initial={emptyDraft(mode)} onSave={onSave} onCancel={() => setAdding(false)} />
        ) : (
          <CatalogueRowEditor mode={mode} initial={emptyDraft(mode)} onSave={onSave} onCancel={() => setAdding(false)} />
        )
      ) : isServices ? (
        filteredRows.length === 0 ? (
          <EmptyState
            icon={<Package size={24} />}
            title="No services yet"
            description="Tap Add service to seed your treatments."
          />
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext
              items={displayRows.filter((r) => r.id !== editingId).map((r) => r.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
                {displayRows.map((row) =>
                  editingId === row.id ? (
                    <li key={row.id} style={{ listStyle: 'none' }}>
                      <ServiceForm initial={draftFromRow(row)} onSave={onSave} onCancel={() => setEditingId(null)} />
                    </li>
                  ) : (
                    <SortableServiceRow
                      key={row.id}
                      row={row}
                      onEdit={() => setEditingId(row.id)}
                      onToggleActive={() => onToggleActive(row)}
                    />
                  )
                )}
              </ul>
            </SortableContext>
          </DndContext>
        )
      ) : grouped.length === 0 ? (
        <EmptyState
          icon={<Package size={24} />}
          title="No products yet"
          description="Tap Add product to seed care products that show up as cart upsells."
        />
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
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
    </div>
  );
}

// ── Meet hosts ──────────────────────────────────────────────────────────────
// Manages the per-host Google Meet integration. Admin connects one or
// more Google accounts; native Lounge virtual appointments create their
// Meet space under the chosen host's OAuth grant so attendance can be
// Seven closed days — the starting point for a clinician with no hours.
const CLINICIAN_EMPTY_WEEK = [
  { closed: true }, { closed: true }, { closed: true }, { closed: true },
  { closed: true }, { closed: true }, { closed: true },
] as unknown as OpeningHoursWeek;

// ClinicianHoursSheet — the polished hours editor for a virtual
// impression clinician. Reuses the clinic opening-hours WorkingHoursEditor
// for the weekly grid (so it matches exactly) and adds a calm one-off
// overrides section below. Reads/writes lng_clinician_hours +
// lng_clinician_overrides via the is_admin RPCs.
export function ClinicianHoursSheet({
  staff,
  onClose,
  onError,
  selfEdit = false,
}: {
  // Minimal shape so this works for admin (a StaffRow) and for a
  // clinician editing their own hours (just id + name).
  staff: { staff_member_id: string; display_name: string } | null;
  onClose: () => void;
  onError: (message: string) => void;
  // When true, write through the self-edit RPCs (the signed-in clinician
  // editing their own availability) instead of the admin RPCs.
  selfEdit?: boolean;
}) {
  const [week, setWeek] = useState<OpeningHoursWeek>(CLINICIAN_EMPTY_WEEK);
  const [overrides, setOverrides] = useState<ClinicianOverride[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingHours, setSavingHours] = useState(false);
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; title: string } | null>(null);

  // New-override draft.
  const [ovDate, setOvDate] = useState('');
  const [ovDateOpen, setOvDateOpen] = useState(false);
  const ovDateRef = useRef<HTMLButtonElement>(null);
  const [ovKind, setOvKind] = useState<'available' | 'off'>('available');
  const [ovStart, setOvStart] = useState('10:00');
  const [ovEnd, setOvEnd] = useState('14:00');
  const [ovAllDay, setOvAllDay] = useState(true);
  const [ovBusy, setOvBusy] = useState(false);

  // How the clinician wants to set availability: a repeating weekly
  // pattern, or specific dates only (the override calendar). Defaults to
  // weekly — the familiar primary view.
  const [mode, setMode] = useState<'weekly' | 'dates'>('weekly');

  const staffId = staff?.staff_member_id ?? null;

  useEffect(() => {
    if (!staffId) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const s = await fetchClinicianSchedule(staffId);
        if (cancelled) return;
        setWeek(s.weekly);
        setOverrides(s.overrides);
      } catch (e) {
        if (!cancelled) onError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [staffId, onError]);

  const saveHours = async () => {
    if (!staffId) return;
    setSavingHours(true);
    try {
      if (selfEdit) await setOwnClinicianHours(week);
      else await setClinicianHours(staffId, week);
      setToast({ tone: 'success', title: 'Hours saved' });
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingHours(false);
    }
  };

  const addOverride = async () => {
    if (!staffId) return;
    if (!ovDate) {
      setToast({ tone: 'error', title: 'Pick a date first' });
      return;
    }
    const useWindow = ovKind === 'available' || !ovAllDay;
    if (useWindow && ovEnd <= ovStart) {
      setToast({ tone: 'error', title: 'End time must be after the start' });
      return;
    }
    setOvBusy(true);
    try {
      if (selfEdit) {
        await addOwnClinicianOverride({
          date: ovDate,
          kind: ovKind,
          start: useWindow ? ovStart : null,
          end: useWindow ? ovEnd : null,
        });
      } else {
        await addClinicianOverride({
          staffMemberId: staffId,
          date: ovDate,
          kind: ovKind,
          start: useWindow ? ovStart : null,
          end: useWindow ? ovEnd : null,
        });
      }
      const s = await fetchClinicianSchedule(staffId);
      setOverrides(s.overrides);
      setOvDate('');
      setToast({ tone: 'success', title: 'One-off saved' });
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setOvBusy(false);
    }
  };

  const removeOverride = async (ov: ClinicianOverride) => {
    if (!staffId) return;
    try {
      if (selfEdit) await deleteOwnClinicianOverride(ov.id);
      else await deleteClinicianOverride(ov.id);
      setOverrides((prev) => prev.filter((o) => o.id !== ov.id));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  const title = staff ? `Hours · ${staff.display_name}` : 'Hours';
  const formatOvDate = (iso: string): string => {
    const [y, m, d] = iso.split('-');
    return y && m && d ? `${d}/${m}/${y}` : iso;
  };

  return (
    <BottomSheet
      open={!!staff}
      onClose={savingHours ? () => undefined : onClose}
      title={title}
      footer={
        mode === 'weekly' ? (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: theme.space[2] }}>
            <Button variant="tertiary" onClick={onClose} disabled={savingHours}>
              Close
            </Button>
            <Button variant="primary" onClick={saveHours} disabled={savingHours || loading}>
              {savingHours ? 'Saving…' : 'Save weekly hours'}
            </Button>
          </div>
        ) : (
          // Specific dates save the moment they're added, so there's
          // nothing to commit here — just close.
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        )
      }
    >
      {loading ? (
        <Skeleton height={320} radius={12} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
          {/* Choose the approach first: a repeating weekly pattern, or
              availability set per specific date. Plus a persistent
              reminder that every time on this sheet is UK time (BST) —
              a clinician may be working from another timezone. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
            <div>
              <h3 style={{ margin: 0, fontSize: theme.type.size.md, fontWeight: theme.type.weight.semibold }}>
                How would you like to set {selfEdit ? 'your' : 'these'} hours?
              </h3>
              <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.sm, color: theme.color.inkMuted, maxWidth: 560 }}>
                Use a repeating weekly pattern, or set availability for specific dates only.
              </p>
            </div>
            <SegmentedControl<'weekly' | 'dates'>
              options={[
                { value: 'weekly', label: 'Repeating weekly' },
                { value: 'dates', label: 'Specific dates' },
              ]}
              value={mode}
              onChange={setMode}
              fullWidth
            />
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: theme.space[2],
                padding: `${theme.space[2]}px ${theme.space[3]}px`,
                borderRadius: theme.radius.input,
                background: theme.color.accentBg,
                color: theme.color.accent,
                fontSize: theme.type.size.sm,
                fontWeight: theme.type.weight.medium,
              }}
            >
              <Clock size={15} aria-hidden /> All times are UK time (BST).
            </div>
          </div>

          {mode === 'weekly' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
            <div>
              <h3 style={{ margin: 0, fontSize: theme.type.size.md, fontWeight: theme.type.weight.semibold }}>
                Repeating weekly hours
              </h3>
              <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.sm, color: theme.color.inkMuted, maxWidth: 560 }}>
                Tick a day to set when {selfEdit ? 'you take' : 'this clinician takes'} virtual calls (UK time). Add a lunch break for a midday pause. A day left unticked means {selfEdit ? 'you are' : 'they are'} not working it.
              </p>
            </div>
            <WorkingHoursEditor value={week} onChange={setWeek} />
          </div>
          ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
            <div>
              <h3 style={{ margin: 0, fontSize: theme.type.size.md, fontWeight: theme.type.weight.semibold }}>
                Specific dates
              </h3>
              <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.sm, color: theme.color.inkMuted, maxWidth: 560 }}>
                {selfEdit
                  ? 'Pick the dates you can take calls and set the times (UK time), or mark a date off. Anything here wins over your weekly pattern.'
                  : 'Switch this clinician on for a single date (a picked-up shift) or off for a holiday or sick day. These win over the weekly pattern.'}
              </p>
            </div>

            {overrides.length > 0 ? (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
                {overrides.map((ov) => (
                  <li
                    key={ov.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: theme.space[3],
                      padding: `${theme.space[3]}px ${theme.space[4]}px`,
                      borderRadius: theme.radius.input,
                      border: `1px solid ${theme.color.border}`,
                      background: theme.color.surface,
                    }}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2], fontSize: theme.type.size.sm, color: theme.color.ink }}>
                      <span
                        style={{
                          fontSize: theme.type.size.xs,
                          fontWeight: theme.type.weight.semibold,
                          color: ov.kind === 'available' ? theme.color.accent : theme.color.warn,
                          background: ov.kind === 'available' ? theme.color.accentBg : 'rgba(179, 104, 21, 0.1)',
                          padding: '2px 8px',
                          borderRadius: theme.radius.pill,
                          textTransform: 'uppercase',
                          letterSpacing: theme.type.tracking.wide,
                        }}
                      >
                        {ov.kind === 'available' ? 'Available' : 'Off'}
                      </span>
                      <strong>{formatOvDate(ov.override_date)}</strong>
                      <span style={{ color: theme.color.inkMuted }}>
                        {ov.start_local && ov.end_local ? `${ov.start_local} to ${ov.end_local}` : 'all day'}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => removeOverride(ov)}
                      aria-label="Remove one-off"
                      style={{
                        appearance: 'none',
                        border: `1px solid ${theme.color.border}`,
                        background: theme.color.surface,
                        color: theme.color.alert,
                        cursor: 'pointer',
                        width: 30,
                        height: 30,
                        borderRadius: theme.radius.pill,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontFamily: 'inherit',
                      }}
                    >
                      <Trash2 size={14} aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: theme.space[3],
                padding: theme.space[4],
                borderRadius: theme.radius.input,
                border: `1px solid ${theme.color.border}`,
                background: theme.color.bg,
              }}
            >
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: theme.space[3] }}>
                <FieldTrigger
                  ref={ovDateRef}
                  label="Date"
                  icon={<CalendarClock size={16} aria-hidden />}
                  value={ovDate ? formatOvDate(ovDate) : ''}
                  placeholder="Pick a date"
                  open={ovDateOpen}
                  onClick={() => setOvDateOpen((v) => !v)}
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[1] }}>
                  <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkMuted, fontWeight: theme.type.weight.medium }}>
                    Working or off
                  </span>
                  <SegmentedControl<'available' | 'off'>
                    options={[
                      { value: 'available', label: 'Working' },
                      { value: 'off', label: 'Off' },
                    ]}
                    value={ovKind}
                    onChange={setOvKind}
                    size="sm"
                    fullWidth
                  />
                </div>
              </div>
              <DatePicker
                open={ovDateOpen}
                onClose={() => setOvDateOpen(false)}
                value={ovDate}
                onChange={(iso) => setOvDate(iso)}
                anchorRef={ovDateRef}
                title="Pick the date"
                minIso={todayIso()}
              />
              {ovKind === 'off' ? (
                <Checkbox checked={ovAllDay} onChange={setOvAllDay} size={18} label="Off the whole day" />
              ) : null}
              {ovKind === 'available' || !ovAllDay ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2] }}>
                  <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted, width: 48 }}>From</span>
                  <TimeField value={ovStart} onChange={setOvStart} ariaLabel="Override start time" />
                  <span aria-hidden style={{ color: theme.color.inkSubtle }}>—</span>
                  <TimeField value={ovEnd} onChange={setOvEnd} ariaLabel="Override end time" />
                </div>
              ) : null}
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button variant="secondary" size="sm" onClick={addOverride} disabled={ovBusy}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
                    <Plus size={15} aria-hidden /> {ovBusy ? 'Adding…' : 'Add one-off'}
                  </span>
                </Button>
              </div>
            </div>
          </div>
          )}
        </div>
      )}
      {toast ? (
        <div style={{ position: 'fixed', bottom: theme.space[6], left: '50%', transform: 'translateX(-50%)', zIndex: 1200 }}>
          <Toast tone={toast.tone} title={toast.title} duration={3000} onDismiss={() => setToast(null)} />
        </div>
      ) : null}
    </BottomSheet>
  );
}

// The dedicated "Virtual impressions" admin section: the clinicians who
// run virtual impression calls (and their hours) + the Google accounts
// that own the Meet rooms, together in one place.
function VirtualImpressionsTab() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <CliniciansCard />
      <MeetHostsCard />
    </div>
  );
}

// CliniciansCard — manage who is a virtual impression clinician. Add a
// staff member, set their hours, choose public vs staff-only, remove.
function CliniciansCard() {
  const staff = useStaff();
  const { hosts: meetHosts, refresh: refreshHosts } = useMeetHosts({ activeOnly: true });
  const [hoursTarget, setHoursTarget] = useState<StaffRow | null>(null);
  const [addStaffId, setAddStaffId] = useState<string>('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A clinician must also be a Meet host (Google room owner or a
  // recognised name) or their video call can't be created.
  const hasMeetHost = (staffMemberId: string) => meetHosts.some((h) => h.staff_member_id === staffMemberId);

  const clinicians = staff.data.filter((s) => s.is_virtual_impression_clinician && s.status === 'active');
  const addable = staff.data
    .filter((s) => !s.is_virtual_impression_clinician && s.status === 'active')
    .sort((a, b) => a.display_name.localeCompare(b.display_name, 'en-GB'));

  const run = async (id: string, fn: () => Promise<void>) => {
    setBusyId(id);
    setError(null);
    try {
      await fn();
      staff.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const pillBtn = (extra: CSSProperties = {}): CSSProperties => ({
    appearance: 'none',
    border: `1px solid ${theme.color.border}`,
    background: theme.color.surface,
    color: theme.color.ink,
    cursor: 'pointer',
    padding: '6px 12px',
    borderRadius: theme.radius.pill,
    fontSize: theme.type.size.xs,
    fontWeight: theme.type.weight.semibold,
    fontFamily: 'inherit',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    ...extra,
  });

  return (
    <Card padding="md">
      <div style={{ marginBottom: theme.space[4] }}>
        <h2 style={{ margin: 0, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold }}>
          Clinicians
        </h2>
        <p style={{ margin: `${theme.space[1]}px 0 0`, color: theme.color.inkMuted, fontSize: theme.type.size.sm, maxWidth: 620 }}>
          Staff who run virtual impression video calls. A clinician's hours, not the clinic's, decide when a virtual impression can be booked, so set their hours below. They can be on different hours to the clinic (a different office or timezone).
        </p>
      </div>

      {error ? <p style={{ color: theme.color.alert, margin: `0 0 ${theme.space[3]}px` }}>{error}</p> : null}

      {staff.loading ? (
        <Skeleton height={64} radius={12} />
      ) : clinicians.length === 0 ? (
        <EmptyState
          icon={<Video size={24} />}
          title="No clinicians yet"
          description="Add a staff member below to let them run virtual impression calls and be booked for them."
        />
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
          {clinicians.map((c) => (
            <li
              key={c.staff_member_id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: theme.space[3],
                padding: `${theme.space[3]}px ${theme.space[4]}px`,
                borderRadius: theme.radius.input,
                background: theme.color.surface,
                border: `1px solid ${theme.color.border}`,
                flexWrap: 'wrap',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: theme.type.size.base, fontWeight: theme.type.weight.semibold, color: theme.color.ink }}>
                  {c.display_name}
                  {c.clinician_self_serve ? null : (
                    <span style={{ marginLeft: 8, fontSize: theme.type.size.xs, color: theme.color.inkMuted, fontWeight: theme.type.weight.medium }}>· Staff only</span>
                  )}
                </p>
                <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
                  {c.login_email}
                </p>
                {hasMeetHost(c.staff_member_id) ? null : (
                  <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.warn, fontWeight: theme.type.weight.semibold }}>
                    Not set up to run calls yet. Make them a Meet host.
                  </p>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {hasMeetHost(c.staff_member_id) ? null : (
                  <button
                    type="button"
                    disabled={busyId === c.staff_member_id}
                    onClick={() => run(c.staff_member_id, async () => {
                      await addStaffMeetHost({ staffMemberId: c.staff_member_id, displayName: c.display_name });
                      refreshHosts();
                    })}
                    style={pillBtn({ border: `1px solid ${theme.color.accent}`, background: theme.color.accentBg, color: theme.color.accent })}
                  >
                    <Video size={13} aria-hidden /> Make a host
                  </button>
                )}
                <button type="button" onClick={() => setHoursTarget(c)} style={pillBtn()}>
                  <Clock size={13} aria-hidden /> Edit hours
                </button>
                <button
                  type="button"
                  disabled={busyId === c.staff_member_id}
                  onClick={() => run(c.staff_member_id, () => setClinicianCanEditOwnHours(c.staff_member_id, !c.clinician_can_edit_own_hours))}
                  title={c.clinician_can_edit_own_hours ? 'This clinician can edit their own availability. Tap to stop that.' : 'Let this clinician edit their own availability from their profile. Tap to allow.'}
                  style={pillBtn(
                    c.clinician_can_edit_own_hours
                      ? { border: `1px solid ${theme.color.accent}`, background: theme.color.accentBg, color: theme.color.accent }
                      : {},
                  )}
                >
                  {c.clinician_can_edit_own_hours ? 'Self-edit on' : 'Self-edit off'}
                </button>
                <button
                  type="button"
                  disabled={busyId === c.staff_member_id}
                  onClick={() => run(c.staff_member_id, () => setClinicianSelfServe(c.staff_member_id, !c.clinician_self_serve))}
                  title={c.clinician_self_serve ? 'Customers can book this clinician. Tap to make staff-only.' : 'Only staff can place a customer with this clinician. Tap to allow customer bookings.'}
                  style={pillBtn(
                    c.clinician_self_serve
                      ? {}
                      : { border: `1px solid ${theme.color.accent}`, background: theme.color.accentBg, color: theme.color.accent },
                  )}
                >
                  {c.clinician_self_serve ? 'Bookable by customers' : 'Staff only'}
                </button>
                <button
                  type="button"
                  disabled={busyId === c.staff_member_id}
                  onClick={() => run(c.staff_member_id, () => setIsVirtualImpressionClinician(c.staff_member_id, false))}
                  aria-label={`Remove ${c.display_name} as a clinician`}
                  style={pillBtn({ color: theme.color.alert, width: 30, height: 30, padding: 0, justifyContent: 'center' })}
                >
                  <Trash2 size={14} aria-hidden />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Add a clinician */}
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], marginTop: theme.space[4], flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <DropdownSelect<string>
            ariaLabel="Add a clinician"
            value={addStaffId}
            onChange={(v) => setAddStaffId(v)}
            options={addable.map((s) => ({ value: s.staff_member_id, label: s.display_name }))}
            placeholder={addable.length === 0 ? 'All staff are clinicians' : 'Pick a staff member'}
            disabled={addable.length === 0}
          />
        </div>
        <Button
          variant="secondary"
          size="md"
          disabled={!addStaffId || busyId !== null}
          onClick={() => run(addStaffId, async () => {
            await setIsVirtualImpressionClinician(addStaffId, true);
            // A clinician must also be a Meet host or the call can't be
            // created. Register them as a recognised host if they aren't
            // one already (they can connect their own Google later).
            if (!hasMeetHost(addStaffId)) {
              const row = staff.data.find((s) => s.staff_member_id === addStaffId);
              if (row) {
                await addStaffMeetHost({ staffMemberId: addStaffId, displayName: row.display_name });
                refreshHosts();
              }
            }
            setAddStaffId('');
          })}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
            <Plus size={16} aria-hidden /> Add clinician
          </span>
        </Button>
      </div>

      <ClinicianHoursSheet
        staff={hoursTarget}
        onClose={() => setHoursTarget(null)}
        onError={(msg) => setError(msg)}
      />
    </Card>
  );
}

function MeetHostsCard() {
  const { hosts, loading, error, refresh } = useMeetHosts({ activeOnly: false });
  const staff = useStaff();
  const [busyConnect, setBusyConnect] = useState(false);
  // Configured OAuth workspaces (Venneir, Lanquez, ...). When more than
  // one is set up the Connect control offers a choice; otherwise it's a
  // single button using the default workspace.
  const [oauthClients, setOauthClients] = useState<MeetOAuthClient[]>([]);
  // "Send a connect link" flow for remote hosts.
  const [inviteClient, setInviteClient] = useState('');
  const [inviteLabel, setInviteLabel] = useState('');
  const [busyInvite, setBusyInvite] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  const onGenerateInvite = async () => {
    const client = inviteClient || oauthClients[0]?.key || 'venneir';
    setBusyInvite(true);
    setInviteUrl(null);
    try {
      const res = await createMeetHostInvite({ client, label: inviteLabel.trim() || null });
      if (res.ok && res.url) {
        setInviteUrl(res.url);
      } else {
        setToast({ tone: 'error', title: 'Could not create connect link', description: res.error });
      }
    } finally {
      setBusyInvite(false);
    }
  };

  const onCopyInvite = async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setToast({ tone: 'success', title: 'Connect link copied' });
    } catch {
      setToast({ tone: 'error', title: 'Could not copy', description: 'Select the link and copy it manually.' });
    }
  };
  const [reordering, setReordering] = useState(false);
  // Move a host up/down in the display order. Reorders the local list and
  // persists sort_order = new index × 10. The list drives both the admin
  // list and the booking host dropdown.
  const onMoveHost = async (index: number, dir: -1 | 1) => {
    const next = index + dir;
    if (next < 0 || next >= hosts.length) return;
    const moved = hosts[index];
    if (!moved) return;
    const arr = [...hosts];
    arr.splice(index, 1);
    arr.splice(next, 0, moved);
    setReordering(true);
    try {
      await batchUpdateMeetHostSortOrders(arr.map((h, i) => ({ id: h.id, sort_order: i * 10 })));
      refresh();
    } catch (e) {
      setToast({
        tone: 'error',
        title: 'Could not reorder hosts',
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setReordering(false);
    }
  };
  const [selectedStaffId, setSelectedStaffId] = useState('');
  const [busyAddStaff, setBusyAddStaff] = useState(false);
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; title: string; description?: string } | null>(null);
  // BottomSheet-driven removal flow. window.confirm would have
  // launched the OS-native modal which violates the no-system-UI rule
  // and breaks the May 2026 visual language. State holds the host
  // we're about to remove so the sheet can render its label.
  const [removeTarget, setRemoveTarget] = useState<{ id: string; name: string; email: string | null; isStaff: boolean } | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const navigate = useNavigate();

  // Staff members not already registered as a recognition host, active
  // only. Drives the "add a staff member" picker.
  const existingStaffHostIds = new Set(
    hosts.filter((h) => h.kind === 'staff' && h.staff_member_id).map((h) => h.staff_member_id as string),
  );
  const addableStaff = staff.data
    .filter((s) => s.status === 'active' && !existingStaffHostIds.has(s.staff_member_id));

  const onAddStaffHost = async () => {
    const member = staff.data.find((s) => s.staff_member_id === selectedStaffId);
    if (!member) return;
    setBusyAddStaff(true);
    try {
      await addStaffMeetHost({ staffMemberId: member.staff_member_id, displayName: member.display_name });
      setSelectedStaffId('');
      refresh();
      setToast({ tone: 'success', title: `${member.display_name} added as a recognised host` });
    } catch (e) {
      setToast({
        tone: 'error',
        title: 'Could not add staff host',
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusyAddStaff(false);
    }
  };

  // Surface a success toast after the /auth/google/callback page
  // routes back with ?meet_connected=1. Pull the flag once and strip
  // it so a page refresh doesn't replay the toast.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('meet_connected') === '1') {
      setToast({ tone: 'success', title: 'Meet host connected' });
      url.searchParams.delete('meet_connected');
      navigate(`${url.pathname}?${url.searchParams.toString()}`, { replace: true });
    }
  }, [navigate]);

  // Load which workspaces are connectable so the Connect control can
  // offer a choice. Best-effort: on failure we fall back to a single
  // default Connect button.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const clients = await listMeetOAuthClients();
      if (!cancelled) setOauthClients(clients);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onConnect = async (client: string | null) => {
    setBusyConnect(true);
    try {
      const result = await startMeetHostOAuth(window.location.pathname + window.location.search, client);
      if (!result.ok || !result.url) {
        setToast({
          tone: 'error',
          title: 'Could not start Google sign-in',
          description: result.error ?? undefined,
        });
        setBusyConnect(false);
        return;
      }
      window.location.assign(result.url);
    } catch (e) {
      setToast({
        tone: 'error',
        title: 'Could not start Google sign-in',
        description: e instanceof Error ? e.message : String(e),
      });
      setBusyConnect(false);
    }
  };

  const onToggleActive = async (id: string, nextActive: boolean) => {
    try {
      await setMeetHostActive(id, nextActive);
      refresh();
    } catch (e) {
      setToast({
        tone: 'error',
        title: nextActive ? 'Could not reactivate host' : 'Could not deactivate host',
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const confirmRemove = async () => {
    if (!removeTarget) return;
    setRemoveBusy(true);
    try {
      await deleteMeetHost(removeTarget.id);
      setRemoveTarget(null);
      refresh();
      setToast({ tone: 'success', title: `${removeTarget.name} removed` });
    } catch (e) {
      setToast({
        tone: 'error',
        title: 'Could not remove host',
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setRemoveBusy(false);
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
            Meet hosts
          </h2>
          <p
            style={{
              margin: `${theme.space[1]}px 0 0`,
              color: theme.color.inkMuted,
              fontSize: theme.type.size.sm,
              maxWidth: 620,
            }}
          >
            Google accounts authorised to host virtual appointments. The booking form lets the receptionist pick which host owns each Meet, and attendance is pulled back to the appointment detail page after the meeting ends. You can also add a staff member as a recognised host, so when they run a call under a connected account's Meet they are marked as the host rather than mistaken for the patient.
          </p>
        </div>
        {oauthClients.length > 1 ? (
          <div style={{ display: 'flex', gap: theme.space[2], flexWrap: 'wrap' }}>
            {oauthClients.map((c) => (
              <Button key={c.key} variant="secondary" size="sm" onClick={() => onConnect(c.key)} disabled={busyConnect}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
                  <Video size={16} /> {busyConnect ? 'Opening Google…' : `Connect ${c.label}`}
                </span>
              </Button>
            ))}
          </div>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onConnect(oauthClients.length === 1 ? oauthClients[0]!.key : null)}
            disabled={busyConnect}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
              <Video size={16} /> {busyConnect ? 'Opening Google…' : 'Connect Google account'}
            </span>
          </Button>
        )}
      </div>

      {error ? (
        <p style={{ color: theme.color.alert, margin: 0 }}>Could not load Meet hosts: {error}</p>
      ) : loading ? (
        <Skeleton height={64} radius={12} />
      ) : hosts.length === 0 ? (
        <EmptyState
          icon={<Video size={24} />}
          title="No Meet hosts connected"
          description="Connect a Google account to enable virtual impression appointments through the per-host flow."
        />
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
          {hosts.map((host, idx) => (
            <li
              key={host.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: theme.space[3],
                padding: `${theme.space[3]}px ${theme.space[4]}px`,
                borderRadius: theme.radius.input,
                background: theme.color.surface,
                border: `1px solid ${theme.color.border}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[3], minWidth: 0 }}>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 36,
                    height: 36,
                    borderRadius: theme.radius.pill,
                    background: host.is_active ? theme.color.accentBg : theme.color.bg,
                    color: host.is_active ? theme.color.accent : theme.color.inkMuted,
                    flexShrink: 0,
                  }}
                  aria-hidden
                >
                  {host.kind === 'staff' ? <Users size={16} /> : <Video size={16} />}
                </span>
                <div style={{ minWidth: 0 }}>
                  <p
                    style={{
                      margin: 0,
                      fontSize: theme.type.size.base,
                      fontWeight: theme.type.weight.semibold,
                      color: theme.color.ink,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {host.display_name}
                  </p>
                  <p
                    style={{
                      margin: `${theme.space[1]}px 0 0`,
                      fontSize: theme.type.size.xs,
                      color: theme.color.inkMuted,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {host.kind === 'staff'
                      ? host.google_user_id
                        ? 'Staff. Recognised by Google ID.'
                        : 'Staff. Recognised by name.'
                      : host.google_email}
                    {host.is_active ? null : <span style={{ marginLeft: 8 }}>· Inactive</span>}
                  </p>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <button
                    type="button"
                    onClick={() => onMoveHost(idx, -1)}
                    disabled={idx === 0 || reordering}
                    aria-label={`Move ${host.display_name} up`}
                    style={{
                      appearance: 'none',
                      border: `1px solid ${theme.color.border}`,
                      background: theme.color.surface,
                      color: idx === 0 ? theme.color.inkSubtle : theme.color.ink,
                      cursor: idx === 0 || reordering ? 'not-allowed' : 'pointer',
                      borderRadius: 8,
                      width: 26,
                      height: 22,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      opacity: idx === 0 ? 0.4 : 1,
                      fontFamily: 'inherit',
                    }}
                  >
                    <ArrowUp size={13} aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => onMoveHost(idx, 1)}
                    disabled={idx === hosts.length - 1 || reordering}
                    aria-label={`Move ${host.display_name} down`}
                    style={{
                      appearance: 'none',
                      border: `1px solid ${theme.color.border}`,
                      background: theme.color.surface,
                      color: idx === hosts.length - 1 ? theme.color.inkSubtle : theme.color.ink,
                      cursor: idx === hosts.length - 1 || reordering ? 'not-allowed' : 'pointer',
                      borderRadius: 8,
                      width: 26,
                      height: 22,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      opacity: idx === hosts.length - 1 ? 0.4 : 1,
                      fontFamily: 'inherit',
                    }}
                  >
                    <ArrowDown size={13} aria-hidden />
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => onToggleActive(host.id, !host.is_active)}
                  style={{
                    appearance: 'none',
                    border: `1px solid ${theme.color.border}`,
                    background: theme.color.surface,
                    color: theme.color.ink,
                    cursor: 'pointer',
                    padding: `6px 12px`,
                    borderRadius: theme.radius.pill,
                    fontSize: theme.type.size.xs,
                    fontWeight: theme.type.weight.semibold,
                    fontFamily: 'inherit',
                  }}
                >
                  {host.is_active ? 'Deactivate' : 'Reactivate'}
                </button>
                <button
                  type="button"
                  onClick={() => setRemoveTarget({ id: host.id, name: host.display_name, email: host.google_email, isStaff: host.kind === 'staff' })}
                  aria-label={`Remove ${host.display_name}`}
                  style={{
                    appearance: 'none',
                    border: `1px solid ${theme.color.border}`,
                    background: theme.color.surface,
                    color: theme.color.alert,
                    cursor: 'pointer',
                    padding: 0,
                    width: 30,
                    height: 30,
                    borderRadius: theme.radius.pill,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontFamily: 'inherit',
                  }}
                >
                  <Trash2 size={14} aria-hidden />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div
        style={{
          marginTop: theme.space[5],
          paddingTop: theme.space[4],
          borderTop: `1px solid ${theme.color.border}`,
          display: 'flex',
          flexDirection: 'column',
          gap: theme.space[3],
        }}
      >
        <div>
          <h3 style={{ margin: 0, fontSize: theme.type.size.base, fontWeight: theme.type.weight.semibold }}>
            Add a staff member as a recognised host
          </h3>
          <p
            style={{
              margin: `${theme.space[1]}px 0 0`,
              color: theme.color.inkMuted,
              fontSize: theme.type.size.sm,
              maxWidth: 620,
            }}
          >
            For staff who run virtual appointments without connecting their own Google account. They are matched by the name shown on their Google Meet profile, then locked to their Google ID the first time they join.
          </p>
        </div>
        <div style={{ display: 'flex', gap: theme.space[2], flexWrap: 'wrap', alignItems: 'center' }}>
          <select
            value={selectedStaffId}
            onChange={(e) => setSelectedStaffId(e.target.value)}
            disabled={staff.loading || addableStaff.length === 0 || busyAddStaff}
            style={{
              appearance: 'none',
              minWidth: 240,
              padding: `${theme.space[2]}px ${theme.space[3]}px`,
              borderRadius: theme.radius.input,
              border: `1px solid ${theme.color.border}`,
              background: theme.color.surface,
              color: theme.color.ink,
              fontFamily: 'inherit',
              fontSize: theme.type.size.sm,
              cursor: staff.loading || addableStaff.length === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            <option value="" disabled>
              {staff.loading
                ? 'Loading staff…'
                : addableStaff.length === 0
                  ? 'All active staff already added'
                  : 'Pick a staff member'}
            </option>
            {addableStaff.map((s) => (
              <option key={s.staff_member_id} value={s.staff_member_id}>
                {s.display_name}
                {s.role_name ? ` (${s.role_name})` : ''}
              </option>
            ))}
          </select>
          <Button variant="secondary" size="sm" onClick={onAddStaffHost} disabled={!selectedStaffId || busyAddStaff}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
              <UserPlus size={16} /> {busyAddStaff ? 'Adding…' : 'Add host'}
            </span>
          </Button>
        </div>
        {staff.error ? (
          <p style={{ margin: 0, color: theme.color.alert, fontSize: theme.type.size.sm }}>
            Could not load staff: {staff.error}
          </p>
        ) : null}
      </div>

      <div
        style={{
          marginTop: theme.space[5],
          paddingTop: theme.space[4],
          borderTop: `1px solid ${theme.color.border}`,
          display: 'flex',
          flexDirection: 'column',
          gap: theme.space[3],
        }}
      >
        <div>
          <h3 style={{ margin: 0, fontSize: theme.type.size.base, fontWeight: theme.type.weight.semibold }}>
            Invite a remote host
          </h3>
          <p
            style={{
              margin: `${theme.space[1]}px 0 0`,
              color: theme.color.inkMuted,
              fontSize: theme.type.size.sm,
              maxWidth: 620,
            }}
          >
            Generate a one time link to send to someone who runs virtual appointments but is not at the clinic. They open it on their own device, sign into their Google, and connect themselves. No Lounge login needed, and the link expires after seven days.
          </p>
        </div>
        <div style={{ display: 'flex', gap: theme.space[2], flexWrap: 'wrap', alignItems: 'center' }}>
          {oauthClients.length > 1 ? (
            <select
              value={inviteClient}
              onChange={(e) => setInviteClient(e.target.value)}
              disabled={busyInvite}
              style={{
                appearance: 'none',
                padding: `${theme.space[2]}px ${theme.space[3]}px`,
                borderRadius: theme.radius.input,
                border: `1px solid ${theme.color.border}`,
                background: theme.color.surface,
                color: theme.color.ink,
                fontFamily: 'inherit',
                fontSize: theme.type.size.sm,
                cursor: 'pointer',
              }}
            >
              <option value="" disabled>
                Pick a workspace
              </option>
              {oauthClients.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          ) : null}
          <input
            value={inviteLabel}
            onChange={(e) => setInviteLabel(e.target.value)}
            placeholder="Who is this for? (optional)"
            disabled={busyInvite}
            style={{
              flex: 1,
              minWidth: 200,
              padding: `${theme.space[2]}px ${theme.space[3]}px`,
              borderRadius: theme.radius.input,
              border: `1px solid ${theme.color.border}`,
              background: theme.color.surface,
              color: theme.color.ink,
              fontFamily: 'inherit',
              fontSize: theme.type.size.sm,
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={onGenerateInvite}
            disabled={busyInvite || (oauthClients.length > 1 && !inviteClient)}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
              <Link2 size={16} /> {busyInvite ? 'Generating…' : 'Generate link'}
            </span>
          </Button>
        </div>
        {inviteUrl ? (
          <div style={{ display: 'flex', gap: theme.space[2], alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              readOnly
              value={inviteUrl}
              onFocus={(e) => e.currentTarget.select()}
              style={{
                flex: 1,
                minWidth: 240,
                padding: `${theme.space[2]}px ${theme.space[3]}px`,
                borderRadius: theme.radius.input,
                border: `1px solid ${theme.color.border}`,
                background: theme.color.bg,
                color: theme.color.ink,
                fontFamily: 'inherit',
                fontSize: theme.type.size.sm,
              }}
            />
            <Button variant="secondary" size="sm" onClick={onCopyInvite}>
              Copy link
            </Button>
          </div>
        ) : null}
      </div>

      {toast ? (
        <div style={{ position: 'fixed', bottom: theme.space[6], left: '50%', transform: 'translateX(-50%)', zIndex: 100 }}>
          <Toast tone={toast.tone} title={toast.title} description={toast.description} duration={4000} onDismiss={() => setToast(null)} />
        </div>
      ) : null}
      <BottomSheet
        open={!!removeTarget}
        onClose={() => (removeBusy ? undefined : setRemoveTarget(null))}
        title="Remove Meet host"
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: theme.space[2] }}>
            <Button variant="tertiary" onClick={() => setRemoveTarget(null)} disabled={removeBusy}>
              Keep host
            </Button>
            <button
              type="button"
              onClick={confirmRemove}
              disabled={removeBusy}
              style={{
                appearance: 'none',
                padding: `${theme.space[3]}px ${theme.space[5]}px`,
                borderRadius: theme.radius.pill,
                border: 'none',
                background: theme.color.alert,
                color: '#fff',
                cursor: removeBusy ? 'wait' : 'pointer',
                fontFamily: 'inherit',
                fontSize: theme.type.size.sm,
                fontWeight: theme.type.weight.semibold,
                opacity: removeBusy ? 0.7 : 1,
              }}
            >
              {removeBusy ? 'Removing…' : 'Remove host'}
            </button>
          </div>
        }
      >
        {removeTarget ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
            <p style={{ margin: 0, fontSize: theme.type.size.base, color: theme.color.ink, lineHeight: 1.5 }}>
              You are about to remove{' '}
              <strong>{removeTarget.name}</strong>
              {removeTarget.email ? ` (${removeTarget.email})` : ''} as a Meet host.
            </p>
            <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted, lineHeight: 1.5 }}>
              {removeTarget.isStaff
                ? 'This staff member will no longer be recognised as a host when they join a Meet. Existing past appointments keep their recorded attendance for the audit trail.'
                : 'Their stored Google credentials will be deleted. Any future appointment that lists them as the meeting host will need a fresh selection on the booking form. Existing past appointments keep their recorded host name for the audit trail.'}
            </p>
            <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted, lineHeight: 1.5 }}>
              If you only want to stop using this host for now, tap Deactivate instead.
            </p>
          </div>
        ) : null}
      </BottomSheet>
    </Card>
  );
}


type PricingModel = 'flat' | 'per_unit' | 'per_arch';

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
  // UI-only: drives the pricing section radio. On save, arch_match and
  // unit_label are written from this value, not persisted directly.
  pricingModel: PricingModel;
  is_service: boolean;
  quantity_enabled: boolean;
  sla_enabled: boolean;
  // Edited as text so the user can clear the field; parseInt on save.
  sla_target_minutes: string;
  include_on_lwo: boolean;
  allocate_job_box: boolean;
  is_virtual: boolean;
  meeting_platform: string;
  fulfilment_required: boolean;
  sold_on_shopify: boolean;
  sort_order: string;
  active: boolean;
}

function derivePricingModel(row: Pick<CatalogueRow, 'arch_match' | 'unit_label'>): PricingModel {
  if (row.arch_match === 'single' || row.arch_match === 'both') return 'per_arch';
  if (row.unit_label) return 'per_unit';
  return 'flat';
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
    pricingModel: 'flat',
    is_service: isService,
    quantity_enabled: !isService,
    sla_enabled: false,
    sla_target_minutes: '',
    include_on_lwo: isService,
    allocate_job_box: isService,
    is_virtual: false,
    meeting_platform: '',
    fulfilment_required: true,
    sold_on_shopify: false,
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
    arch_match: row.arch_match === 'both' ? 'single' : row.arch_match,
    pricingModel: derivePricingModel(row),
    is_service: row.is_service,
    quantity_enabled: row.quantity_enabled,
    sla_enabled: row.sla_enabled,
    sla_target_minutes: row.sla_target_minutes != null ? String(row.sla_target_minutes) : '',
    include_on_lwo: row.include_on_lwo,
    allocate_job_box: row.allocate_job_box,
    is_virtual: row.is_virtual,
    meeting_platform: row.meeting_platform ?? '',
    fulfilment_required: row.fulfilment_required,
    sold_on_shopify: row.sold_on_shopify,
    sort_order: String(row.sort_order),
    active: row.active,
  };
}

// ── Products-tab row (no drag handle) ────────────────────────────────────────
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
        listStyle: 'none',
        border: `1px solid ${theme.color.border}`,
        borderRadius: 14,
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        background: row.active ? theme.color.surface : 'rgba(14, 20, 20, 0.02)',
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
        opacity: row.active ? 1 : 0.65,
      }}
    >
      <CatalogueThumbnail src={row.image_url} alt={row.name} size={44} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: theme.space[2], flexWrap: 'wrap' }}>
          <span style={{ fontWeight: theme.type.weight.semibold, fontSize: theme.type.size.base, color: theme.color.ink }}>
            {row.name}
          </span>
          <span style={{ color: theme.color.inkSubtle, fontSize: theme.type.size.xs, fontFamily: 'monospace' }}>{row.code}</span>
          {!row.active ? <StatusPill tone="cancelled" size="sm">Inactive</StatusPill> : null}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], marginTop: theme.space[1], flexWrap: 'wrap' }}>
          <span style={{ fontSize: theme.type.size.sm, fontWeight: theme.type.weight.medium, fontVariantNumeric: 'tabular-nums' }}>
            {formatPounds(row.unit_price)}
            {row.unit_label ? ` ${row.unit_label}` : ''}
            {row.extra_unit_price != null ? ` (extras ${formatPounds(row.extra_unit_price)})` : ''}
          </span>
          {row.category ? (
            <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>{row.category}</span>
          ) : null}
        </div>
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

// ── Services-tab shared constants ─────────────────────────────────────────────

const PRICING_MODEL_OPTIONS: Array<{ value: PricingModel; label: string }> = [
  { value: 'flat', label: 'Fixed price' },
  { value: 'per_unit', label: 'Per unit' },
  { value: 'per_arch', label: 'Per arch' },
];

const SERVICE_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Any appointment' },
  { value: 'denture_repair', label: 'Denture repair' },
  { value: 'same_day_appliance', label: 'Same-day appliance' },
  { value: 'click_in_veneers', label: 'Click-in veneers' },
  { value: 'impression_appointment', label: 'Impression appointment' },
  { value: 'other', label: 'Other' },
];

const SERVICE_TYPE_LABELS: Record<string, string> = {
  denture_repair: 'Denture repair',
  same_day_appliance: 'Same-day appliance',
  click_in_veneers: 'Click-in veneers',
  impression_appointment: 'Impression appointment',
  other: 'Other',
};

function chipStyle(active: boolean): CSSProperties {
  return {
    padding: `${theme.space[2]}px ${theme.space[3]}px`,
    borderRadius: theme.radius.pill,
    border: `1.5px solid ${active ? theme.color.ink : theme.color.border}`,
    background: active ? theme.color.ink : theme.color.surface,
    color: active ? '#fff' : theme.color.inkMuted,
    fontSize: theme.type.size.sm,
    fontWeight: active ? theme.type.weight.semibold : theme.type.weight.regular,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
  };
}

function ServiceSection({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
      <div style={{ borderBottom: `1px solid ${theme.color.border}`, paddingBottom: theme.space[2] }}>
        <h3 style={{ margin: 0, fontSize: theme.type.size.base, fontWeight: theme.type.weight.semibold, color: theme.color.ink }}>
          {title}
        </h3>
        {hint ? (
          <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
            {hint}
          </p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

// ── Services-tab drag-sortable row ────────────────────────────────────────────
function SortableServiceRow({
  row,
  onEdit,
  onToggleActive,
}: {
  row: CatalogueRow;
  onEdit: () => void;
  onToggleActive: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.id });

  const metaParts: string[] = [];
  if (row.service_type) metaParts.push(SERVICE_TYPE_LABELS[row.service_type] ?? row.service_type);
  if (row.repair_variant) metaParts.push(row.repair_variant);
  if (row.product_key) metaParts.push(row.product_key);
  if (row.arch_match === 'single') metaParts.push('Per arch');
  if (row.include_on_lwo) metaParts.push('LWO');
  if (row.allocate_job_box) metaParts.push('Job box');
  if (row.sla_enabled && row.sla_target_minutes) metaParts.push(`${row.sla_target_minutes} min target`);

  const priceText = row.unit_label
    ? `${formatPounds(row.unit_price)} ${row.unit_label}`
    : formatPounds(row.unit_price);

  return (
    <li
      ref={setNodeRef}
      style={{
        listStyle: 'none',
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
      }}
    >
      <div
        style={{
          border: `1px solid ${isDragging ? theme.color.accent : theme.color.border}`,
          borderRadius: 14,
          padding: `${theme.space[3]}px ${theme.space[4]}px`,
          background: row.active ? theme.color.surface : 'rgba(14, 20, 20, 0.02)',
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[3],
          opacity: row.active ? 1 : 0.65,
          boxShadow: isDragging ? theme.shadow.raised : 'none',
        }}
      >
        <span
          {...attributes}
          {...listeners}
          aria-label="Drag to reorder"
          style={{
            color: theme.color.inkSubtle,
            cursor: isDragging ? 'grabbing' : 'grab',
            flexShrink: 0,
            touchAction: 'none',
            display: 'flex',
            padding: `${theme.space[1]}px`,
            marginLeft: `-${theme.space[1]}px`,
          }}
        >
          <GripVertical size={18} />
        </span>
        <CatalogueThumbnail src={row.image_url} alt={row.name} size={44} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: theme.space[2], flexWrap: 'wrap' }}>
            <span style={{ fontWeight: theme.type.weight.semibold, fontSize: theme.type.size.base, color: theme.color.ink }}>
              {row.name}
            </span>
            <span style={{ color: theme.color.inkSubtle, fontSize: theme.type.size.xs, fontFamily: 'monospace' }}>
              {row.code}
            </span>
            {!row.active ? <StatusPill tone="cancelled" size="sm">Inactive</StatusPill> : null}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], marginTop: theme.space[1], flexWrap: 'wrap' }}>
            <span style={{ fontSize: theme.type.size.sm, fontWeight: theme.type.weight.medium, fontVariantNumeric: 'tabular-nums', color: theme.color.ink }}>
              {priceText}
            </span>
            {metaParts.length > 0 ? (
              <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>
                {metaParts.join(' · ')}
              </span>
            ) : null}
          </div>
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
      </div>
    </li>
  );
}

// ── Service editor form ───────────────────────────────────────────────────────
function ServiceForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: CatalogueDraft;
  onSave: (draft: CatalogueDraft, waiverSectionKeys: string[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<CatalogueDraft>(initial);
  const [busy, setBusy] = useState(false);
  const [imgBusy, setImgBusy] = useState(false);
  const [imgError, setImgError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // Ref-driven file input. The previous label / visually-hidden-input
  // pattern relied on `position: absolute` without a positioning
  // ancestor, which iPad Safari mishandles after the file picker
  // closes — the visualViewport calculation skews and the dvh-sized
  // page chrome below the editor collapses. Rendering the input with
  // display:none and triggering it via .click() avoids the absolute-
  // positioning escape hatch entirely.
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const isDirty = JSON.stringify(draft) !== JSON.stringify(initial);

  const handleCollapse = () => {
    if (isDirty) { setConfirmDiscard(true); } else { onCancel(); }
  };

  const set = <K extends keyof CatalogueDraft>(k: K, v: CatalogueDraft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const setPricingModel = (model: PricingModel) => {
    setDraft((d) => ({
      ...d,
      pricingModel: model,
      arch_match: model === 'per_arch' ? 'single' : 'any',
      unit_label: model === 'flat' ? '' : d.unit_label,
      both_arches_price: model !== 'per_arch' ? '' : d.both_arches_price,
      extra_unit_price: model !== 'per_unit' ? '' : d.extra_unit_price,
    }));
  };

  // Waiver requirements
  const { sections: waiverSections, loading: waiverSectionsLoading } = useWaiverSections();
  const { sectionKeys: existingWaiverKeys, loading: existingWaiverLoading } = useCatalogueWaiverRequirements(initial.id ?? null);
  const [waiverKeys, setWaiverKeys] = useState<string[]>([]);
  const [waiverSeeded, setWaiverSeeded] = useState(false);
  useEffect(() => {
    if (waiverSeeded) return;
    if (!initial.id) { setWaiverSeeded(true); return; }
    if (existingWaiverLoading) return;
    setWaiverKeys(existingWaiverKeys);
    setWaiverSeeded(true);
  }, [initial.id, existingWaiverLoading, existingWaiverKeys, waiverSeeded]);
  const toggleWaiver = (key: string, checked: boolean) =>
    setWaiverKeys((cur) => (checked ? [...new Set([...cur, key])] : cur.filter((k) => k !== key)));

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
    if (!draft.code.trim()) { setImgError('Set a SKU code first.'); return; }
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

  const isValid = draft.code.trim() && draft.name.trim() && draft.category.trim();

  return (
    <div
      style={{
        border: `1.5px solid ${theme.color.ink}`,
        borderRadius: 16,
        background: theme.color.surface,
        overflow: 'hidden',
      }}
    >
      {/* ── Header ── */}
      <div
        style={{
          padding: `${theme.space[4]}px ${theme.space[5]}px`,
          borderBottom: `1px solid ${theme.color.border}`,
          background: 'rgba(14, 20, 20, 0.02)',
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[4],
        }}
      >
        <CatalogueThumbnail src={draft.image_url} alt={draft.name || 'New service'} size={52} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: theme.type.size.xs, color: theme.color.inkSubtle, fontWeight: theme.type.weight.medium, textTransform: 'uppercase', letterSpacing: theme.type.tracking.wide }}>
            {draft.id ? 'Editing service' : 'New service'}
          </p>
          <p style={{ margin: 0, fontSize: theme.type.size.md, fontWeight: theme.type.weight.semibold, color: theme.color.ink }}>
            {draft.name || 'Untitled'}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], flexShrink: 0 }}>
          {confirmDiscard ? (
            <>
              <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>Discard unsaved changes?</span>
              <Button variant="tertiary" size="sm" onClick={() => setConfirmDiscard(false)}>Keep editing</Button>
              <Button variant="secondary" size="sm" onClick={onCancel}>Discard</Button>
            </>
          ) : (
            <button
              type="button"
              onClick={handleCollapse}
              aria-label="Collapse editor"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: `0 ${theme.space[3]}px`,
                height: 34,
                borderRadius: theme.radius.pill,
                border: `1px solid ${theme.color.border}`,
                background: theme.color.surface,
                color: theme.color.inkMuted,
                fontSize: theme.type.size.sm,
                fontWeight: theme.type.weight.medium,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              <ChevronUp size={15} />
              Collapse
              {isDirty && (
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: theme.color.accent, flexShrink: 0 }} />
              )}
            </button>
          )}
        </div>
      </div>

      {/* ── Body ── */}
      <div style={{ padding: `${theme.space[5]}px`, display: 'flex', flexDirection: 'column', gap: theme.space[6] }}>

        {/* 0. Image */}
        <ServiceSection title="Image" hint="Shown in the booking widget and EPOS cart.">
          <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[4] }}>
            <CatalogueThumbnail src={draft.image_url} alt={draft.name || 'Service'} size={72} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                disabled={imgBusy}
                onChange={(e) => onImageFile(e.target.files?.[0] ?? null)}
                // Reset value on click so picking the same file twice
                // still fires onChange (browsers de-dup identical values).
                onClick={(e) => { (e.currentTarget as HTMLInputElement).value = ''; }}
                style={{ display: 'none' }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={imgBusy}
                style={{
                  appearance: 'none',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: `0 ${theme.space[3]}px`,
                  height: 36,
                  borderRadius: theme.radius.pill,
                  border: `1px solid ${theme.color.border}`,
                  background: theme.color.surface,
                  color: theme.color.ink,
                  fontSize: theme.type.size.sm,
                  fontWeight: theme.type.weight.medium,
                  cursor: imgBusy ? 'not-allowed' : 'pointer',
                  opacity: imgBusy ? 0.5 : 1,
                  fontFamily: 'inherit',
                }}
              >
                <ImageIcon size={14} />
                {draft.image_url ? 'Replace image' : 'Upload image'}
              </button>
              {draft.image_url ? (
                <button
                  type="button"
                  onClick={onRemoveImage}
                  disabled={imgBusy}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: `0 ${theme.space[2]}px`,
                    height: 28,
                    border: 'none',
                    background: 'transparent',
                    color: theme.color.inkSubtle,
                    fontSize: theme.type.size.sm,
                    cursor: imgBusy ? 'not-allowed' : 'pointer',
                    fontFamily: 'inherit',
                    opacity: imgBusy ? 0.5 : 1,
                  }}
                >
                  <Trash2 size={13} /> Remove image
                </button>
              ) : null}
            </div>
          </div>
          {imgError ? (
            <p style={{ margin: 0, color: theme.color.alert, fontSize: theme.type.size.xs }}>{imgError}</p>
          ) : null}
        </ServiceSection>

        {/* 1. Basics */}
        <ServiceSection title="Basics">
          <Input
            label="Name"
            value={draft.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="e.g. Click-in Veneers"
          />
          <Input
            label="Description (optional)"
            value={draft.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder="What the patient receives"
          />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: theme.space[3] }}>
            <Input
              label="SKU code"
              value={draft.code}
              onChange={(e) => set('code', e.target.value)}
              placeholder="e.g. civ_upper"
            />
            <Input
              label="Category"
              value={draft.category}
              onChange={(e) => set('category', e.target.value)}
              placeholder="e.g. Veneers"
            />
          </div>
        </ServiceSection>

        {/* 2. Pricing */}
        <ServiceSection title="Pricing" hint="Choose how the price is calculated at booking">
          <div style={{ display: 'flex', gap: theme.space[2], flexWrap: 'wrap' }}>
            {PRICING_MODEL_OPTIONS.map((opt) => (
              <button key={opt.value} type="button" onClick={() => setPricingModel(opt.value)} style={chipStyle(draft.pricingModel === opt.value)}>
                {opt.label}
              </button>
            ))}
          </div>
          <p style={{ margin: 0, fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>
            {draft.pricingModel === 'flat'
              ? 'One price for this service, regardless of quantity or arch.'
              : draft.pricingModel === 'per_unit'
              ? 'Receptionist enters a quantity at booking, e.g. number of teeth.'
              : 'Receptionist picks upper or lower arch at booking. Optional combined price for both.'}
          </p>
          {draft.pricingModel === 'flat' ? (
            <div style={{ maxWidth: 220 }}>
              <Input
                label="Price (£)"
                numericFormat="currency"
                value={draft.unit_price}
                onChange={(e) => set('unit_price', e.target.value)}
                placeholder="0.00"
              />
            </div>
          ) : draft.pricingModel === 'per_unit' ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: theme.space[3] }}>
              <Input
                label="Price per unit (£)"
                numericFormat="currency"
                value={draft.unit_price}
                onChange={(e) => set('unit_price', e.target.value)}
                placeholder="0.00"
              />
              <Input
                label="Unit label"
                value={draft.unit_label}
                onChange={(e) => set('unit_label', e.target.value)}
                placeholder="e.g. per tooth"
              />
              <Input
                label="Extras price (£)"
                numericFormat="currency"
                value={draft.extra_unit_price}
                onChange={(e) => set('extra_unit_price', e.target.value)}
                placeholder="optional"
              />
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: theme.space[3] }}>
              <Input
                label="Price per arch (£)"
                numericFormat="currency"
                value={draft.unit_price}
                onChange={(e) => set('unit_price', e.target.value)}
                placeholder="0.00"
              />
              <Input
                label="Both arches price (£)"
                numericFormat="currency"
                value={draft.both_arches_price}
                onChange={(e) => set('both_arches_price', e.target.value)}
                placeholder="optional"
              />
            </div>
          )}
        </ServiceSection>

        {/* 3. When to suggest */}
        <ServiceSection title="When to suggest" hint="Auto-suggest this service when the patient's booking matches the appointment type below">
          <div style={{ display: 'flex', gap: theme.space[2], flexWrap: 'wrap' }}>
            {SERVICE_TYPE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  set('service_type', opt.value);
                  if (opt.value !== 'denture_repair') set('repair_variant', '');
                }}
                style={chipStyle(draft.service_type === opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {draft.service_type === 'denture_repair' ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: theme.space[3] }}>
              <Input
                label="Repair type"
                value={draft.repair_variant}
                onChange={(e) => set('repair_variant', e.target.value)}
                placeholder="e.g. Snapped denture"
              />
              <Input
                label="Sub-type tag (optional)"
                value={draft.product_key}
                onChange={(e) => set('product_key', e.target.value)}
                placeholder="e.g. partial"
              />
            </div>
          ) : draft.service_type ? (
            <div style={{ maxWidth: 320 }}>
              <Input
                label="Sub-type tag (optional)"
                value={draft.product_key}
                onChange={(e) => set('product_key', e.target.value)}
                placeholder="e.g. retainer, night_guard"
              />
            </div>
          ) : null}
          {draft.product_key && draft.service_type ? (
            <p style={{ margin: 0, fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>
              Narrows matching further. Leave blank to match all {SERVICE_TYPE_LABELS[draft.service_type] ?? 'bookings of this type'}.
            </p>
          ) : null}
        </ServiceSection>

        {/* 4. Lab and operations */}
        <ServiceSection title="Lab and operations">
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
            <Checkbox
              checked={draft.include_on_lwo}
              onChange={(v) => set('include_on_lwo', v)}
              label="Appears on the Lab Work Order (LWO)"
            />
            <Checkbox
              checked={draft.allocate_job_box}
              onChange={(v) => set('allocate_job_box', v)}
              label="Allocate a job box at patient arrival"
            />
            <Checkbox
              checked={draft.quantity_enabled}
              onChange={(v) => set('quantity_enabled', v)}
              label="Allow quantity selector at booking (for services priced per unit)"
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[4], flexWrap: 'wrap' }}>
              <Checkbox
                checked={draft.sla_enabled}
                onChange={(v) => set('sla_enabled', v)}
                label="Enforce a time target from arrival to completion"
              />
              {draft.sla_enabled ? (
                <Input
                  label="Target (minutes)"
                  numericFormat="integer"
                  value={draft.sla_target_minutes}
                  onChange={(e) => set('sla_target_minutes', e.target.value)}
                  placeholder="e.g. 120"
                  style={{ maxWidth: 180 }}
                />
              ) : null}
            </div>
            <Checkbox
              checked={draft.is_virtual}
              onChange={(v) => {
                set('is_virtual', v);
                if (!v) set('meeting_platform', '');
                // Virtual sessions hand nothing over, so flipping
                // virtual on disables the fulfilment question too —
                // keeps the two flags in sync without forcing the
                // admin to tick both. Admin can still tick it back on
                // if they ever want a virtual service to surface the
                // shipping option.
                if (v) set('fulfilment_required', false);
              }}
              label="Virtual service (remote session). Replaces the arrival wizard with Join meeting, Rejoin, and No-show actions."
            />
            {draft.is_virtual ? (
              <DropdownSelect<string>
                label="Meeting platform"
                required
                value={draft.meeting_platform}
                options={[
                  { value: 'google_meet', label: 'Google Meet' },
                  { value: 'zoom', label: 'Zoom' },
                  { value: 'microsoft_teams', label: 'Microsoft Teams' },
                  { value: 'whereby', label: 'Whereby' },
                ]}
                onChange={(v) => set('meeting_platform', v)}
                placeholder="Select a platform"
              />
            ) : null}
            <Checkbox
              checked={!draft.fulfilment_required}
              onChange={(v) => set('fulfilment_required', !v)}
              label="Nothing to hand over or ship. Complete visit finishes straight away with no in-person / shipping question."
            />
            <Checkbox
              checked={draft.sold_on_shopify}
              onChange={(v) => set('sold_on_shopify', v)}
              label="Sold on venneir.com. The booking form will ask for the customer's Shopify order number and credit the amount paid online against the bill at checkout."
            />
          </div>
        </ServiceSection>

        {/* 5. Required waivers */}
        <ServiceSection title="Required waivers" hint="The patient must sign these sections before the service is confirmed. Leave all unchecked to use the service-type default.">
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
        </ServiceSection>

        {/* 6. Upgrades */}
        {draft.id ? (
          <ProductUpgradesEditor catalogueId={draft.id} archEnabled={draft.arch_match !== 'any'} />
        ) : (
          <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted, fontStyle: 'italic' }}>
            Save the service first to attach upgrades.
          </p>
        )}

      </div>

      {/* ── Footer ── */}
      <div
        style={{
          padding: `${theme.space[3]}px ${theme.space[5]}px`,
          borderTop: `1px solid ${theme.color.border}`,
          background: 'rgba(14, 20, 20, 0.02)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: theme.space[3],
        }}
      >
        <Checkbox checked={draft.active} onChange={(v) => set('active', v)} label="Active (visible to receptionist)" />
        <div style={{ display: 'flex', gap: theme.space[2] }}>
          <Button variant="tertiary" onClick={onCancel} disabled={busy}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <X size={16} /> Cancel
            </span>
          </Button>
          <Button variant="primary" onClick={submit} loading={busy} disabled={!isValid || busy}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Check size={16} /> {draft.id ? 'Save changes' : 'Add service'}
            </span>
          </Button>
        </div>
      </div>
    </div>
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
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
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              disabled={imgBusy}
              onChange={(e) => onImageFile(e.target.files?.[0] ?? null)}
              onClick={(e) => { (e.currentTarget as HTMLInputElement).value = ''; }}
              style={{ display: 'none' }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={imgBusy}
              style={{
                appearance: 'none',
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
                fontFamily: 'inherit',
              }}
            >
              <Plus size={14} /> {draft.image_url ? 'Replace image' : 'Upload image'}
            </button>
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
