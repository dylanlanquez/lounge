import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { CalendarDays, Check, ChevronLeft, ChevronRight, Eye, FileSignature, Files, Info, Layers, Pencil, Shield, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import {
  Avatar,
  BeforeAfterGallery,
  Breadcrumb,
  Card,
  CollapsibleCard,
  EmptyState,
  FinalDeliveries,
  MarketingGallery,
  PatientFilesGrid,
  Skeleton,
  StatusPill,
} from '../components/index.ts';
import { PatientEditModal } from '../components/PatientEditModal/PatientEditModal.tsx';
import { WaiverSheet } from '../components/WaiverSheet/WaiverSheet.tsx';
import { WaiverViewerDialog } from '../components/WaiverViewerDialog/WaiverViewerDialog.tsx';
import type { WaiverDocInput } from '../lib/waiverDocument.ts';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../components/KioskStatusBar/KioskStatusBar.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useIsMobile } from '../lib/useIsMobile.ts';
import { properCase } from '../lib/queries/appointments.ts';
import { patientFullName } from '../lib/queries/patients.ts';
import {
  bucketCase,
  humaniseEventTypeLabel,
  usePatientCases,
  usePatientProfile,
  usePatientProfileFiles,
  usePatientScheduledAppointments,
  usePatientVisits,
  type PatientCaseRow,
  type PatientFileEntry,
  type PatientProfileRow,
  type PatientScheduledAppointmentRow,
  type PatientVisitRow,
  type ScheduledApptStatus,
} from '../lib/queries/patientProfile.ts';
import { formatPence } from '../lib/queries/carts.ts';
import { formatVisitCrumb } from '../lib/queries/visits.ts';
import {
  sectionSignatureState,
  useSignedWaivers,
  useWaiverSections,
  usePatientWaiverState,
  type SignedWaiverRow,
  type WaiverSection,
  type WaiverSignatureSummary,
} from '../lib/queries/waiver.ts';

// ─────────────────────────────────────────────────────────────────────────────
// PatientProfile — the full Meridian-style patient page, dropped into
// Lounge so receptionists can see identity / files / cases / visits in
// one scrollable view at the kiosk.
//
// Read-only for now. Edits (pencil icons) and uploads (file slot tiles)
// are shipped as follow-up phases — putting all 5 sections on the page
// first ensures the surface matches Meridian and gives staff the full
// picture during a visit. Each card degrades to an empty / muted state
// rather than crashing if Meridian's schema is mid-migration.
// ─────────────────────────────────────────────────────────────────────────────

export function PatientProfile() {
  const { id } = useParams<{ id: string }>();
  const { user, loading: authLoading } = useAuth();
  const isMobile = useIsMobile(640);
  const { data: patient, loading: patientLoading, error: patientError, refresh: refreshPatient } = usePatientProfile(id);
  const { data: files, loading: filesLoading, refresh: refreshFiles } = usePatientProfileFiles(id);
  const { data: visits, loading: visitsLoading } = usePatientVisits(id);
  const { data: scheduledAppointments, loading: apptsLoading } =
    usePatientScheduledAppointments(id);
  const { data: cases, loading: casesLoading } = usePatientCases(id);
  // Signed-waiver history lives at the route level so the WaiverStatus
  // card (top of the page) and the SignedWaiversHistory card (further
  // down) can refresh in lockstep when the receptionist signs a section
  // via the inline pencil. Realtime-postgres_changes alone wasn't enough
  // here — the upper card got an imperative refresh on
  // WaiverSheet.onAllSigned, so it updated instantly while the history
  // table waited on the realtime stream and trailed behind.
  const {
    rows: signedWaiverRows,
    loading: signedWaiversLoading,
    error: signedWaiversError,
    refresh: refreshSignedWaivers,
  } = useSignedWaivers(id ?? null);
  // Which section's pencil opened the edit modal — drives which
  // fieldset the modal renders. null when closed.
  const [editSection, setEditSection] = useState<'profile' | 'care' | null>(null);

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
        <Breadcrumbs patient={patient} />

        {patientError ? (
          <Card padding="lg">
            <p style={{ color: theme.color.alert, margin: 0 }}>Could not load patient: {patientError}</p>
          </Card>
        ) : patientLoading || !patient ? (
          <ProfileSkeleton isMobile={isMobile} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
            <Hero patient={patient} cases={cases} onEdit={() => setEditSection('profile')} />
            <CareDetails patient={patient} onEdit={() => setEditSection('care')} />
            <WaiverStatus
              patientId={patient.id}
              patientName={`${properCase(patient.first_name)} ${properCase(patient.last_name)}`.trim() || 'Patient'}
              staffName={
                (user.user_metadata?.name as string | undefined) ??
                user.email ??
                'Staff'
              }
              onSigned={refreshSignedWaivers}
            />
            <BeforeAfterGallery
              patient={patient}
              files={files}
              loading={filesLoading}
              refresh={refreshFiles}
              isMobile={isMobile}
              readOnly
            />
            <MarketingGallery
              patient={patient}
              files={files}
              loading={filesLoading}
              refresh={refreshFiles}
              isMobile={isMobile}
              readOnly
            />
            <PatientFilesPanel
              files={files}
              loading={filesLoading}
              patient={patient}
              refresh={refreshFiles}
            />
            <FinalDeliveries patientId={patient.id} patient={patient} />
            <Appointments
              visits={visits}
              scheduledAppointments={scheduledAppointments}
              loading={visitsLoading || apptsLoading}
              isMobile={isMobile}
              patientId={patient.id}
              patientName={`${properCase(patient.first_name)} ${properCase(patient.last_name)}`.trim() || 'Patient'}
            />
            <CaseHistory cases={cases} loading={casesLoading} />
            <SignedWaiversHistory
              patient={patient}
              patientName={`${properCase(patient.first_name)} ${properCase(patient.last_name)}`.trim() || 'Patient'}
              isMobile={isMobile}
              rows={signedWaiverRows}
              loading={signedWaiversLoading}
              error={signedWaiversError}
            />
          </div>
        )}

        {patient && editSection ? (
          <PatientEditModal
            open
            patient={patient}
            section={editSection}
            onClose={() => setEditSection(null)}
            onSaved={async () => {
              await refreshPatient();
            }}
          />
        ) : null}
      </div>
    </main>
  );
}

// Router state read by Breadcrumbs to render the right trail. When
// the profile is opened via the "View profile" button on a visit
// page, we get a `from: 'visit'` payload that carries the visit id,
// its opened-at timestamp, and the visit's *own* entry state so
// clicking the visit crumb here pops back without losing chain
// context (Schedule / Patients / In clinic).
//
// `patientName` is a *preview* — every caller that already knows
// the patient's name (Patients list, VisitDetail "View profile",
// Schedule "Patient profile") forwards it so the rightmost crumb
// renders the correct name on first paint, before the live patient
// query has resolved. Without this, the breadcrumb would either
// flash a literal placeholder ("Patient") or pop in late once the
// query lands — the exact flicker we're avoiding.
interface PatientEntryState {
  from?: 'visit';
  visitId?: string;
  visitOpenedAt?: string;
  // Mirror of VisitDetail's VisitEntryState. Carrying visitOpenedAt
  // and patientName here means the visit-link in this breadcrumb
  // pops back with enough preview data to render every crumb on
  // first paint without a shimmer transition.
  visitEntry?: {
    from?: 'patient' | 'schedule' | 'in_clinic';
    patientId?: string;
    patientName?: string;
    visitOpenedAt?: string;
  } | null;
  patientName?: string;
}

function Breadcrumbs({ patient }: { patient: PatientProfileRow | null }) {
  const navigate = useNavigate();
  const location = useLocation();
  const entry = (location.state as PatientEntryState | null) ?? {};

  // Priority for the rightmost crumb:
  //   1. live patient row (truth)
  //   2. preview name from router state (caller's hint, used while
  //      the live row is still in flight)
  //   3. NameSkeleton — no preview means we genuinely don't know yet
  //      (e.g. direct URL paste); render a loading shimmer instead
  //      of a fake "Patient" placeholder.
  const liveName = patient ? patientFullName(patient) : '';
  const previewName = entry.patientName?.trim() ?? '';
  const nameLabel: ReactNode = liveName || previewName || <NameSkeleton />;

  const items = (() => {
    if (entry.from === 'visit' && entry.visitId && entry.visitOpenedAt) {
      // The patient name is the current page (last crumb), so the
      // visit crumb sits between origin and the name. Including
      // "[Name]'s" here would repeat the name immediately to its
      // right — drop it. Format: "Appt. 29 Apr".
      const visitLabel = formatVisitCrumb({
        name: liveName || previewName || null,
        openedAtIso: entry.visitOpenedAt,
        includeName: false,
      });
      const visitState = entry.visitEntry ?? null;
      const visitFrom = visitState?.from;
      const baseCrumb =
        visitFrom === 'patient'
          ? { label: 'Patients', onClick: () => navigate('/patients') }
          : visitFrom === 'in_clinic'
            ? { label: 'In clinic', onClick: () => navigate('/in-clinic') }
            : { label: 'Schedule', onClick: () => navigate('/schedule') };
      return [
        baseCrumb,
        {
          label: visitLabel,
          onClick: () =>
            navigate(`/visit/${entry.visitId}`, {
              state: visitState ?? undefined,
            }),
        },
        { label: nameLabel },
      ];
    }
    return [
      { label: 'Patients', onClick: () => navigate('/patients') },
      { label: nameLabel },
    ];
  })();

  return (
    <div style={{ margin: `${theme.space[3]}px 0 ${theme.space[6]}px` }}>
      <Breadcrumb items={items} />
    </div>
  );
}

// Inline shimmer used as the rightmost breadcrumb crumb while the
// patient name is unknown. ~96px width is roughly a two-word name
// at the breadcrumb's font size, so the surrounding chevrons don't
// reflow when the real name lands.
function NameSkeleton() {
  return (
    <>
      {/* Visually-hidden text gives screen readers something to
          announce in place of the shimmer; sighted users see the
          inline rectangle. */}
      <span
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap',
          borderWidth: 0,
        }}
      >
        Loading patient name
      </span>
      <Skeleton width={96} height={14} radius={4} />
    </>
  );
}

// Page-level loading skeleton. Mirrors the actual section layout —
// a tall Hero card up top followed by collapsed-card-height
// shimmers for the surfaces below (Waivers, Notes & flags, Before
// & afters, Marketing content, Files, Final deliveries,
// Appointments, Case history, Signed waivers). Each card renders
// the chrome (title + meta) at the same height a closed
// CollapsibleCard would, so when the patient query resolves the
// real cards swap in without a layout jump.
function ProfileSkeleton({ isMobile }: { isMobile: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <Card padding="lg">
        <div
          style={{
            display: 'flex',
            flexDirection: isMobile ? 'column' : 'row',
            alignItems: isMobile ? 'flex-start' : 'center',
            gap: theme.space[5],
          }}
        >
          <Skeleton width={64} height={64} radius={999} />
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
            <Skeleton width={isMobile ? '70%' : 280} height={32} radius={6} />
            <Skeleton width={isMobile ? '40%' : 160} height={16} radius={4} />
          </div>
        </div>
        <div
          style={{
            marginTop: theme.space[5],
            display: 'grid',
            // Match the real Hero: 3-col grid, 9 short cells.
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: theme.space[4],
          }}
        >
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
              <Skeleton height={12} width="60%" radius={4} />
              <Skeleton height={18} width="80%" radius={4} />
            </div>
          ))}
        </div>
      </Card>
      {/* Collapsed-card-height surfaces. Count matches the real
          section list so the loading height resembles the rendered
          page. Update if a section is added or removed below. */}
      {Array.from({ length: 9 }).map((_, i) => (
        <Card key={i} padding="lg">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: theme.space[3],
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], flex: 1, minWidth: 0 }}>
              <Skeleton width={18} height={18} radius={4} />
              <Skeleton width="35%" height={20} radius={4} />
            </div>
            <Skeleton width={72} height={14} radius={4} />
            <Skeleton width={20} height={20} radius={4} />
          </div>
        </Card>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Hero card — identity block + 12-field grid.
// ─────────────────────────────────────────────────────────────────────────────

function Hero({
  patient,
  cases: _cases,
  onEdit,
}: {
  patient: PatientProfileRow;
  cases: PatientCaseRow[];
  onEdit: () => void;
}) {
  // The earlier "Active / Inactive" pill mapped to whether the
  // patient had any non-terminal Meridian case — useful in Meridian,
  // confusing on the Lounge surface where staff already see a live
  // visit if one is open. Dropped to keep the hero focused on
  // identity. The cases list still drives the case-history section
  // below.
  const fullName = `${properCase(patient.first_name)} ${properCase(patient.last_name)}`.trim() || 'Unnamed patient';
  const linkedToShopify = !!patient.shopify_customer_id;

  return (
    <Card padding="lg">
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: theme.space[4],
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[4], minWidth: 0 }}>
          <Avatar name={fullName} src={patient.avatar_data} size="lg" />
          <div style={{ minWidth: 0 }}>
            <h1
              style={{
                margin: 0,
                fontSize: theme.type.size.xl,
                fontWeight: theme.type.weight.semibold,
                letterSpacing: theme.type.tracking.tight,
                color: theme.color.ink,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {fullName}
            </h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], marginTop: theme.space[2], flexWrap: 'wrap' }}>
              {patient.internal_ref ? (
                <span
                  style={{
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: theme.type.size.xs,
                    background: theme.color.bg,
                    color: theme.color.inkMuted,
                    padding: '2px 7px',
                    borderRadius: 4,
                  }}
                >
                  {patient.internal_ref}
                </span>
              ) : null}
              {linkedToShopify ? <ShopifyLinkedPill /> : null}
            </div>
          </div>
        </div>

        <button
          type="button"
          aria-label="Edit patient details"
          title="Edit patient details"
          onClick={onEdit}
          style={{
            appearance: 'none',
            width: 36,
            height: 36,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: `1px solid ${theme.color.border}`,
            borderRadius: theme.radius.input,
            color: theme.color.inkMuted,
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          <Pencil size={14} />
        </button>
      </div>

      <div style={{ height: 1, background: theme.color.border, margin: `${theme.space[5]}px 0` }} />

      <FieldGrid fields={buildHeroFields(patient)} />
    </Card>
  );
}

// "Linked to venneir.com & One Click" pill. Tap or focus the (i) icon to
// reveal a popover explaining where the data comes from and how the
// patient updates it. Mirrors Meridian's identity-pill pattern so the
// two surfaces feel like one product. Two icons: One Click first
// (the customer-facing app the customer actually signs in to) then the
// Shopify mark (the account system behind it).
function ShopifyLinkedPill() {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement | null>(null);

  // Click-outside + Escape close. Re-runs the listener every time
  // `open` toggles so we don't pay for it when the popover is closed.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span ref={wrapperRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Linked to venneir.com and One Click, show details"
        style={{
          appearance: 'none',
          display: 'inline-flex',
          alignItems: 'center',
          gap: theme.space[1],
          padding: `2px ${theme.space[2]}px 2px ${theme.space[2]}px`,
          borderRadius: theme.radius.pill,
          background: theme.color.accentBg,
          color: theme.color.accent,
          fontSize: theme.type.size.xs,
          fontWeight: theme.type.weight.semibold,
          border: 'none',
          cursor: 'pointer',
          fontFamily: 'inherit',
          letterSpacing: 0.1,
        }}
      >
        <img
          src="/one-click-logo-icon.png"
          alt=""
          aria-hidden
          width={12}
          height={12}
          style={{ display: 'block', flexShrink: 0 }}
        />
        <img
          src="/shopify.svg"
          alt=""
          aria-hidden
          width={12}
          height={12}
          style={{ display: 'block', flexShrink: 0, marginLeft: -1 }}
        />
        Linked to venneir.com &amp; One Click
        <Info size={12} aria-hidden style={{ opacity: 0.75 }} />
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="venneir.com and One Click linked account"
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            left: 0,
            zIndex: 30,
            width: 320,
            maxWidth: '90vw',
            padding: theme.space[4],
            borderRadius: theme.radius.card,
            background: theme.color.surface,
            border: `1px solid ${theme.color.border}`,
            boxShadow: theme.shadow.overlay,
          }}
        >
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            style={{
              appearance: 'none',
              position: 'absolute',
              top: theme.space[2],
              right: theme.space[2],
              width: 28,
              height: 28,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'transparent',
              border: 'none',
              borderRadius: theme.radius.pill,
              cursor: 'pointer',
              color: theme.color.inkSubtle,
            }}
          >
            <X size={14} />
          </button>
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.sm,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              paddingRight: theme.space[5],
            }}
          >
            Linked to venneir.com &amp; One Click
          </p>
          <p
            style={{
              margin: `${theme.space[2]}px 0 0`,
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
              lineHeight: 1.55,
            }}
          >
            These details come from the customer&apos;s venneir.com / One Click account.
            They can update them any time in the One Click app or on Shopify (it&apos;s
            the same account, so a change in one shows up in the other). If you
            edit them here at the lab, the change syncs back to the customer&apos;s
            online account too — only edit when the customer is in front of you and
            has agreed.
          </p>
        </div>
      ) : null}
    </span>
  );
}

interface FieldDef {
  label: string;
  value: string | null;
  mono?: boolean;
  // True = the cell takes the whole row (all cols). Default false.
  // Used for the trailing Shopify id so the orphan reads as a
  // dedicated admin row rather than a lone cell next to gaps.
  fullRow?: boolean;
}

// Profile-card fields. Emergency contact + phone live in Care
// details (kin info, not identity). DoB and Sex stay here on the
// profile — they're vitals staff scan alongside the name. Country
// is dropped entirely from the UI: Shopify sync owns it.
//
//   Row 1: First name      | Last name      | Date of birth
//   Row 2: Sex             | Email          | Phone
//   Row 3: Address line 1  | Address line 2 | City
//   Row 4: Postcode        | Registered     | Shopify customer
//
// 12 fields in 4 rows of 3 — no orphans, no full-row spans needed.
function buildHeroFields(p: PatientProfileRow): FieldDef[] {
  return [
    { label: 'First name', value: properCase(p.first_name) || null },
    { label: 'Last name', value: properCase(p.last_name) || null },
    { label: 'Date of birth', value: formatDate(p.date_of_birth) },
    { label: 'Sex', value: p.sex ? properCase(p.sex) : null },
    { label: 'Email', value: p.email },
    { label: 'Phone', value: p.phone },
    { label: 'Address line 1', value: p.portal_ship_line1 },
    { label: 'Address line 2', value: p.portal_ship_line2 },
    { label: 'City', value: p.portal_ship_city },
    { label: 'Postcode', value: p.portal_ship_postcode },
    { label: 'Registered', value: formatDate(p.registered_at) },
    { label: 'Shopify customer', value: p.shopify_customer_id, mono: true },
  ];
}

function FieldGrid({ fields }: { fields: FieldDef[] }) {
  const monoStack = 'ui-monospace, SFMono-Regular, Menlo, monospace';
  return (
    <div
      style={{
        display: 'grid',
        // Uniform 3-col grid. Two columns made the page feel
        // sparse and pushed everything down; four with selective
        // span:2s oscillated visually. Three is the goldilocks
        // for the trimmed field list — 9 short cells in 3 neat
        // rows plus a full-row Shopify id at the bottom. Long
        // emails / addresses still fit at ~33% width with
        // wordBreak as a fallback for the rare overrun.
        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
        columnGap: theme.space[6],
        rowGap: theme.space[4],
        minWidth: 0,
      }}
    >
      {fields.map((f) => {
        const empty = f.value == null || f.value === '';
        return (
          <div
            key={f.label}
            style={{
              minWidth: 0,
              // fullRow: true takes the whole row (both columns).
              // Used for the Shopify customer id at the bottom so
              // the trailing orphan doesn't render as a lone cell
              // next to empty space.
              gridColumn: f.fullRow ? '1 / -1' : undefined,
            }}
          >
            <div
              style={{
                fontSize: theme.type.size.xs,
                fontWeight: theme.type.weight.medium,
                color: theme.color.inkMuted,
                marginBottom: theme.space[1],
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {f.label}
            </div>
            <div
              style={{
                fontSize: f.mono ? theme.type.size.sm : theme.type.size.base,
                fontFamily: f.mono ? monoStack : 'inherit',
                fontWeight: theme.type.weight.medium,
                color: empty ? theme.color.inkSubtle : theme.color.ink,
                // Long unbroken tokens (a 35-char email local, say)
                // still need a wrap escape hatch even at 50% width.
                wordBreak: 'break-word',
                lineHeight: 1.4,
              }}
            >
              {empty ? '—' : f.value}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ─────────────────────────────────────────────────────────────────────────────
// WaiverStatus — compact signed-waiver chip row at the top of the
// profile. One chip per active section: green when current, amber when
// the patient signed a previous version (stale), grey-outlined when
// they have not signed at all. Lets reception spot in one glance
// whether the patient is paperwork-clear before bringing them through.
// ─────────────────────────────────────────────────────────────────────────────

function WaiverStatus({
  patientId,
  patientName,
  staffName,
  onSigned,
}: {
  patientId: string;
  patientName: string;
  // Pre-fill for the WaiverSheet's "Witnessed by" field — the
  // signed-in receptionist viewing the profile. Threaded from the
  // route-level useAuth() instead of re-resolving here so a future
  // kiosk-mode parent can override it.
  staffName: string;
  // Sibling-state hook on PatientProfile (the Signed waivers history
  // table) needs to refresh in lockstep with this card whenever a
  // section gets signed. Calling the parent's refresh imperatively
  // sidesteps the realtime stream's variable lag — the user sees
  // both surfaces update on the same paint as the WaiverSheet
  // closes, the way the rest of the app behaves.
  onSigned?: () => void;
}) {
  const { sections, loading: sectionsLoading } = useWaiverSections();
  const { latest, loading: latestLoading, refresh } = usePatientWaiverState(patientId);

  // Section currently being signed via the pencil shortcut. Single-
  // section flow (the receptionist taps the pencil for one row at a
  // time); WaiverSheet handles the actual pad + persistence.
  const [signingSection, setSigningSection] = useState<WaiverSection | null>(null);

  const activeSections = useMemo(() => sections.filter((s) => s.active), [sections]);
  const counts = useMemo(() => {
    let current = 0;
    let stale = 0;
    let missing = 0;
    for (const sec of activeSections) {
      const state = sectionSignatureState(sec, latest);
      if (state === 'current') current++;
      else if (state === 'stale') stale++;
      else missing++;
    }
    return { current, stale, missing };
  }, [activeSections, latest]);

  const loading = sectionsLoading || latestLoading;

  return (
    <Card padding="lg">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: theme.space[3], flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2] }}>
          <FileSignature size={18} color={theme.color.ink} aria-hidden />
          <h2
            style={{
              margin: 0,
              fontSize: theme.type.size.lg,
              fontWeight: theme.type.weight.semibold,
              letterSpacing: theme.type.tracking.tight,
              color: theme.color.ink,
            }}
          >
            Waivers
          </h2>
        </div>
        {!loading && activeSections.length > 0 ? (
          <span style={{ color: theme.color.inkMuted, fontSize: theme.type.size.sm, fontVariantNumeric: 'tabular-nums' }}>
            {counts.current} of {activeSections.length} current
          </span>
        ) : null}
      </div>

      <div style={{ height: 1, background: theme.color.border, margin: `${theme.space[4]}px 0 0` }} />

      {loading ? (
        <div style={{ paddingTop: theme.space[4] }}>
          <Skeleton height={48} radius={10} />
        </div>
      ) : activeSections.length === 0 ? (
        <p style={{ margin: `${theme.space[4]}px 0 0`, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
          No waiver sections configured.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {activeSections.map((sec, i) => (
            <WaiverRow
              key={sec.key}
              section={sec}
              latest={latest}
              isLast={i === activeSections.length - 1}
              onSign={() => setSigningSection(sec)}
            />
          ))}
        </ul>
      )}

      <WaiverSheet
        open={signingSection !== null}
        onClose={() => setSigningSection(null)}
        patientId={patientId}
        visitId={null}
        sections={signingSection ? [signingSection] : []}
        patientName={patientName}
        defaultWitnessName={staffName}
        onAllSigned={() => {
          setSigningSection(null);
          refresh();
          onSigned?.();
        }}
      />
    </Card>
  );
}

// One row per active waiver section. Symmetric three-column layout:
// shield icon (left, status-coloured) — section title (centre, takes
// flex slack) — single status line (right). No nested pills, no
// version chip; the detailed Signed waivers table further down owns
// the audit copy. Hairline between rows; the last row sits flush so
// the card doesn't end on a doubled border.
function WaiverRow({
  section,
  latest,
  isLast,
  onSign,
}: {
  section: WaiverSection;
  latest: Map<string, WaiverSignatureSummary>;
  isLast: boolean;
  onSign: () => void;
}) {
  const state = sectionSignatureState(section, latest);
  const sig = latest.get(section.key);

  // Visual weight lives on the LEFT (icon + title) so the signed row
  // reads as the heavier item even before the eye reaches the date on
  // the right. Status text keeps its green colour but stays at a
  // moderate weight so it doesn't fight the title.
  let icon;
  let statusText: string;
  let statusColor: string;
  let titleColor: string;
  let titleWeight: number;
  if (state === 'current') {
    icon = <ShieldCheck size={20} color={theme.color.accent} strokeWidth={2.5} aria-hidden />;
    statusText = sig ? `Signed ${formatShortDate(sig.signed_at)}` : 'Signed';
    statusColor = theme.color.accent;
    titleColor = theme.color.ink;
    titleWeight = theme.type.weight.bold;
  } else if (state === 'stale') {
    icon = <ShieldAlert size={18} color={theme.color.warn} aria-hidden />;
    statusText = 'Re-sign needed';
    statusColor = theme.color.warn;
    titleColor = theme.color.inkMuted;
    titleWeight = theme.type.weight.regular;
  } else {
    icon = <Shield size={18} color={theme.color.inkSubtle} aria-hidden />;
    statusText = 'Not signed';
    statusColor = theme.color.inkSubtle;
    titleColor = theme.color.inkMuted;
    titleWeight = theme.type.weight.regular;
  }

  return (
    <li
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
        padding: `${theme.space[3]}px 0`,
        borderBottom: isLast ? 'none' : `1px solid ${theme.color.border}`,
      }}
    >
      <span style={{ display: 'inline-flex', flexShrink: 0 }}>{icon}</span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: theme.type.size.base,
          fontWeight: titleWeight,
          color: titleColor,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {section.title}
      </span>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: theme.space[2],
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.medium,
            color: statusColor,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {statusText}
        </span>
        {state !== 'current' ? (
          <button
            type="button"
            onClick={onSign}
            aria-label={`Sign ${section.title}`}
            title={`Sign ${section.title}`}
            style={{
              appearance: 'none',
              border: `1px solid ${theme.color.border}`,
              background: theme.color.surface,
              color: theme.color.inkMuted,
              borderRadius: theme.radius.input,
              width: 28,
              height: 28,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              padding: 0,
              flexShrink: 0,
            }}
          >
            <Pencil size={14} aria-hidden />
          </button>
        ) : null}
      </span>
    </li>
  );
}

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Patient files — view-only mirror of Meridian's file library.
// Lounge runs on Samsung tablets at the desk; staff never upload, edit
// or delete. The PatientFilesGrid component renders the same eight
// fixed slots Meridian uses (Upper Arch, Lower Arch, Bite Reg, Full
// Face, Smile front/left/right, X-Ray) plus per-label "other" cards,
// in a horizontal scroll row. Click a filled card → preview modal;
// click 'View history' → version list.
// ─────────────────────────────────────────────────────────────────────────────

function PatientFilesPanel({
  files,
  loading,
  patient,
  refresh,
}: {
  files: PatientFileEntry[];
  loading: boolean;
  patient: PatientProfileRow;
  refresh: () => void;
}) {
  return (
    <CollapsibleCard
      icon={<Files size={18} color={theme.color.ink} aria-hidden />}
      title="Patient files"
      meta={`${files.length} ${files.length === 1 ? 'file' : 'files'}`}
    >
      <PatientFilesGrid
        files={files}
        loading={loading}
        patientId={patient.id}
        patientName={`${properCase(patient.first_name)} ${properCase(patient.last_name)}`.trim() || 'Patient'}
        patient={patient}
        onUploaded={refresh}
      />
    </CollapsibleCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Notes and flags — three muted read-only fields.
// ─────────────────────────────────────────────────────────────────────────────

// Care details — vitals, kin, and operational notes the clinic
// needs at hand but that don't belong on the profile-identity card.
// Renamed from "Notes & flags" once DoB / Sex / Emergency contact
// fields moved here from the Hero — the section is now broader
// than just notes. Pencil opens the edit modal scoped to 'care'.
function CareDetails({
  patient,
  onEdit,
}: {
  patient: PatientProfileRow;
  onEdit: () => void;
}) {
  const emergencyName = (patient.emergency_contact_name ?? '').trim();
  const emergencyPhone = (patient.emergency_contact_phone ?? '').trim();
  const allergies = (patient.allergies ?? '').trim();
  const permanent = (patient.notes ?? '').trim();

  return (
    <Card padding="lg">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2
          style={{
            margin: 0,
            fontSize: theme.type.size.lg,
            fontWeight: theme.type.weight.semibold,
            letterSpacing: theme.type.tracking.tight,
            color: theme.color.ink,
          }}
        >
          Care details
        </h2>
        <button
          type="button"
          aria-label="Edit care details"
          title="Edit care details"
          onClick={onEdit}
          style={{
            appearance: 'none',
            width: 36,
            height: 36,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: `1px solid ${theme.color.border}`,
            borderRadius: theme.radius.input,
            color: theme.color.inkMuted,
            cursor: 'pointer',
          }}
        >
          <Pencil size={14} />
        </button>
      </div>

      <div style={{ height: 1, background: theme.color.border, margin: `${theme.space[4]}px 0 ${theme.space[5]}px` }} />

      <div
        style={{
          display: 'grid',
          // 3-col to match the Hero's rhythm above. Allergies is
          // typically a short value ("Penicillin", "None known")
          // so it slots into the third cell of row 1 alongside
          // the emergency pair — that way every visible row has
          // three filled cells rather than the contact pair
          // leaving a phantom gap. Permanent notes stays full
          // row because it's paragraph content.
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          columnGap: theme.space[6],
          rowGap: theme.space[4],
        }}
      >
        <NotesField label="Emergency contact" value={emergencyName} />
        <NotesField label="Emergency phone" value={emergencyPhone} />
        <NotesField label="Allergies & sensitivities" value={allergies} />
        <NotesField label="Permanent notes" value={permanent} multiline fullRow />
      </div>
    </Card>
  );
}

function NotesField({
  label,
  value,
  multiline = false,
  fullRow = false,
}: {
  label: string;
  value: string;
  multiline?: boolean;
  fullRow?: boolean;
}) {
  const empty = !value;
  return (
    <div style={{ minWidth: 0, gridColumn: fullRow ? '1 / -1' : undefined }}>
      <div
        style={{
          fontSize: theme.type.size.xs,
          fontWeight: theme.type.weight.medium,
          color: theme.color.inkMuted,
          marginBottom: theme.space[1],
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: theme.type.size.base,
          color: empty ? theme.color.inkSubtle : theme.color.ink,
          whiteSpace: multiline ? 'pre-wrap' : 'nowrap',
          overflow: multiline ? 'visible' : 'hidden',
          textOverflow: multiline ? 'clip' : 'ellipsis',
          lineHeight: 1.5,
        }}
      >
        {empty ? '—' : value}
      </div>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// Appointments — unified timeline.
//
// Past-and-present visits in lng_visits represent appointments that DID
// get booked in (the receptionist hit Arrived). Rows in lng_appointments
// represent the booking itself; if a booking was never converted to a
// visit (no_show, cancelled, or a legacy row from before Lounge existed)
// it lives only here. We surface both:
//   - Upcoming  : future bookings (lng_appointments, no visit yet)
//   - Past      : visits + past bookings that were never arrived
// Booking rows whose id appears in any visit.appointment_id are filtered
// out — the visit row already represents them.
// ─────────────────────────────────────────────────────────────────────────────

interface UnifiedApptRow {
  // Stable key for the table row.
  key: string;
  // Whether this row originates from lng_visits (the patient was booked
  // in) or lng_appointments (still scheduled, or never arrived).
  kind: 'visit' | 'appointment';
  // The visit, when kind === 'visit'.
  visit?: PatientVisitRow;
  // The appointment, when kind === 'appointment'.
  appointment?: PatientScheduledAppointmentRow;
  // Date used for sorting + display. Visits use opened_at; appointments
  // use start_at.
  sortDate: string;
  // Which side of "now" this row sits — drives the upcoming/past split.
  bucket: 'upcoming' | 'past';
}

function buildUnifiedAppts(
  visits: PatientVisitRow[],
  appointments: PatientScheduledAppointmentRow[]
): UnifiedApptRow[] {
  const now = Date.now();
  // Visits already represent appointments that were arrived. Skip any
  // appointment whose id matches a visit.appointment_id so we don't show
  // both rows for the same slot.
  const visitedApptIds = new Set(visits.map((v) => v.appointment_id).filter(Boolean) as string[]);
  // Walk-in arrivals create a calendar marker in lng_appointments with
  // walk_in_id set (see migration 20260430000005). Drop any appointment
  // whose walk_in_id matches a visit's walk_in_id — the visit row is
  // the canonical surface for that arrival.
  const visitedWalkInIds = new Set(visits.map((v) => v.walk_in_id).filter(Boolean) as string[]);

  const rows: UnifiedApptRow[] = [];

  for (const v of visits) {
    rows.push({
      key: `v-${v.id}`,
      kind: 'visit',
      visit: v,
      sortDate: v.opened_at,
      bucket: 'past',
    });
  }

  for (const a of appointments) {
    if (visitedApptIds.has(a.id)) continue;
    if (a.walk_in_id && visitedWalkInIds.has(a.walk_in_id)) continue;
    const isFuture = new Date(a.start_at).getTime() >= now;
    rows.push({
      key: `a-${a.id}`,
      kind: 'appointment',
      appointment: a,
      sortDate: a.start_at,
      bucket: isFuture ? 'upcoming' : 'past',
    });
  }

  // Past goes newest-first (most recent visit at the top) — Upcoming goes
  // soonest-first (next appointment at the top). The split happens in the
  // render layer; the array stays sorted newest-first so each pager
  // chunks chronologically without further work.
  rows.sort((a, b) => b.sortDate.localeCompare(a.sortDate));
  return rows;
}

function Appointments({
  visits,
  scheduledAppointments,
  loading,
  isMobile,
  patientId,
  patientName,
}: {
  visits: PatientVisitRow[];
  scheduledAppointments: PatientScheduledAppointmentRow[];
  loading: boolean;
  isMobile: boolean;
  patientId: string;
  patientName: string;
}) {
  const navigate = useNavigate();
  // Tell the visit page where the user came from. VisitDetail's
  // breadcrumb uses this to render "Patients › Name › Visit" instead
  // of "Schedule › Visit", so back-navigation lands on this profile.
  // The opened_at preview lets that breadcrumb render its full
  // "Appointment, 29 Apr, 21:43" label on first paint instead of
  // shimmering until the visit query resolves.
  const openVisit = (v: { id: string; opened_at: string }) =>
    navigate(`/visit/${v.id}`, {
      state: {
        from: 'patient',
        patientId,
        patientName,
        visitOpenedAt: v.opened_at,
      },
    });

  const all = useMemo(
    () => buildUnifiedAppts(visits, scheduledAppointments),
    [visits, scheduledAppointments]
  );
  const upcoming = useMemo(
    // Render upcoming soonest-first so the next appointment is at the
    // top of the list (the merged array is newest-first by default).
    () => all.filter((r) => r.bucket === 'upcoming').slice().reverse(),
    [all]
  );
  const past = useMemo(() => all.filter((r) => r.bucket === 'past'), [all]);

  return (
    <CollapsibleCard
      icon={<CalendarDays size={18} color={theme.color.ink} aria-hidden />}
      title="Appointments"
      meta={`${all.length} ${all.length === 1 ? 'appointment' : 'appointments'}`}
    >
      {loading ? (
        <Skeleton height={120} radius={14} />
      ) : all.length === 0 ? (
        <EmptyState
          title="No appointments yet"
          description="Bookings, walk-ins and arrivals will list here."
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
          {upcoming.length > 0 ? (
            <ApptGroup
              eyebrow="Upcoming"
              rows={upcoming}
              isMobile={isMobile}
              onOpenVisit={openVisit}
            />
          ) : null}
          {past.length > 0 ? (
            <ApptGroup
              eyebrow="Past"
              rows={past}
              isMobile={isMobile}
              onOpenVisit={openVisit}
            />
          ) : null}
        </div>
      )}
    </CollapsibleCard>
  );
}

function ApptGroup({
  eyebrow,
  rows,
  isMobile,
  onOpenVisit,
}: {
  eyebrow: string;
  rows: UnifiedApptRow[];
  isMobile: boolean;
  onOpenVisit: (visit: { id: string; opened_at: string }) => void;
}) {
  const pager = usePagedRows(rows, PROFILE_PAGE_SIZE);
  return (
    <div>
      <div
        style={{
          fontSize: theme.type.size.xs,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.inkMuted,
          textTransform: 'uppercase',
          letterSpacing: theme.type.tracking.wide,
          marginBottom: theme.space[2],
        }}
      >
        {eyebrow} <span style={{ color: theme.color.inkSubtle }}>· {rows.length}</span>
      </div>
      {isMobile ? (
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
          {pager.visible.map((r) => (
            <li key={r.key}>
              <ApptRowMobile row={r} onOpenVisit={onOpenVisit} />
            </li>
          ))}
        </ul>
      ) : (
        <ApptTable rows={pager.visible} onOpenVisit={onOpenVisit} />
      )}
      <ListPager
        page={pager.page}
        totalPages={pager.totalPages}
        onPrev={() => pager.setPage((p) => Math.max(0, p - 1))}
        onNext={() => pager.setPage((p) => Math.min(pager.totalPages - 1, p + 1))}
      />
    </div>
  );
}

function ApptTable({
  rows,
  onOpenVisit,
}: {
  rows: UnifiedApptRow[];
  onOpenVisit: (visit: { id: string; opened_at: string }) => void;
}) {
  const headerStyle: CSSProperties = {
    fontSize: theme.type.size.xs,
    fontWeight: theme.type.weight.semibold,
    color: theme.color.inkMuted,
    textTransform: 'uppercase',
    letterSpacing: theme.type.tracking.tight,
    textAlign: 'left',
    padding: `${theme.space[3]}px ${theme.space[3]}px`,
    background: theme.color.bg,
    borderTop: `1px solid ${theme.color.border}`,
    borderBottom: `1px solid ${theme.color.border}`,
  };
  const cellStyle: CSSProperties = {
    padding: `${theme.space[3]}px ${theme.space[3]}px`,
    fontSize: theme.type.size.sm,
    color: theme.color.ink,
    borderBottom: `1px solid ${theme.color.border}`,
    verticalAlign: 'middle',
  };
  return (
    <div style={{ overflowX: 'auto' }}>
      <table
        style={{ width: '100%', borderCollapse: 'collapse', fontVariantNumeric: 'tabular-nums' }}
      >
        <thead>
          <tr>
            <th style={headerStyle}>Date</th>
            <th style={headerStyle}>LAP ref</th>
            <th style={headerStyle}>Service</th>
            <th style={headerStyle}>Status</th>
            <th style={{ ...headerStyle, textAlign: 'right' }}>Payment</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isVisit = r.kind === 'visit';
            const handleClick =
              isVisit && r.visit
                ? () => onOpenVisit({ id: r.visit!.id, opened_at: r.visit!.opened_at })
                : undefined;
            return (
              <tr
                key={r.key}
                onClick={handleClick}
                style={{ cursor: handleClick ? 'pointer' : 'default' }}
                onMouseEnter={(e) => {
                  if (!handleClick) return;
                  (e.currentTarget as HTMLTableRowElement).style.background = theme.color.bg;
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLTableRowElement).style.background = 'transparent';
                }}
              >
                <td style={cellStyle}>{formatDateTime(r.sortDate)}</td>
                <td
                  style={{
                    ...cellStyle,
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    color: theme.color.inkMuted,
                  }}
                >
                  {isVisit ? r.visit?.lap_ref ?? '—' : r.appointment?.appointment_ref ?? '—'}
                </td>
                <td style={cellStyle}>
                  {isVisit
                    ? r.visit?.service_label ?? '—'
                    : humaniseEventTypeLabel(r.appointment?.event_type_label ?? null) ?? '—'}
                </td>
                <td style={cellStyle}>
                  {isVisit ? (
                    <VisitStatusPill visit={r.visit!} />
                  ) : (
                    <ApptStatusPill status={r.appointment!.status} />
                  )}
                </td>
                <td
                  style={{
                    ...cellStyle,
                    textAlign: 'right',
                    color:
                      isVisit && r.visit?.cart_status === 'paid'
                        ? theme.color.ink
                        : theme.color.inkMuted,
                  }}
                >
                  {isVisit ? paymentLabel(r.visit!) : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ApptRowMobile({
  row,
  onOpenVisit,
}: {
  row: UnifiedApptRow;
  onOpenVisit: (visit: { id: string; opened_at: string }) => void;
}) {
  const isVisit = row.kind === 'visit';
  const clickable = isVisit && row.visit;
  const handleClick = clickable
    ? () => onOpenVisit({ id: row.visit!.id, opened_at: row.visit!.opened_at })
    : undefined;
  const service = isVisit
    ? row.visit?.service_label ?? 'Appointment'
    : humaniseEventTypeLabel(row.appointment?.event_type_label ?? null) ?? 'Appointment';
  const ref = isVisit
    ? row.visit?.lap_ref ?? 'no LAP ref'
    : row.appointment?.appointment_ref ?? 'no LAP ref';
  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={!clickable}
      style={{
        appearance: 'none',
        width: '100%',
        textAlign: 'left',
        padding: theme.space[3],
        borderRadius: theme.radius.card,
        border: `1px solid ${theme.color.border}`,
        background: theme.color.surface,
        cursor: clickable ? 'pointer' : 'default',
        fontFamily: 'inherit',
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
          }}
        >
          {service}
        </p>
        <p
          style={{
            margin: `${theme.space[1]}px 0 0`,
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {formatDateTime(row.sortDate)} · {ref}
        </p>
      </div>
      {isVisit ? (
        <VisitStatusPill visit={row.visit!} />
      ) : (
        <ApptStatusPill status={row.appointment!.status} />
      )}
      {isVisit ? (
        <span
          style={{
            fontVariantNumeric: 'tabular-nums',
            color: theme.color.inkMuted,
            fontSize: theme.type.size.sm,
          }}
        >
          {paymentLabel(row.visit!)}
        </span>
      ) : null}
    </button>
  );
}

function VisitStatusPill({ visit }: { visit: PatientVisitRow }) {
  const tone =
    visit.status === 'complete'
      ? 'complete'
      : visit.status === 'cancelled'
        ? 'cancelled'
        : visit.status === 'in_progress'
          ? 'in_progress'
          : 'arrived';
  const label = humaniseVisitStatus(visit.status);
  return <StatusPill tone={tone} size="sm">{label}</StatusPill>;
}

function ApptStatusPill({ status }: { status: ScheduledApptStatus }) {
  // Map lng_appointments.status onto the StatusPill tone vocabulary.
  // Booked + arrived sit on the active rail; complete maps to its
  // muted-green; no_show is the loud one; cancelled / rescheduled both
  // read as inert.
  const tone =
    status === 'complete'
      ? 'complete'
      : status === 'no_show'
        ? 'no_show'
        : status === 'cancelled' || status === 'rescheduled'
          ? 'cancelled'
          : status === 'in_progress'
            ? 'in_progress'
            : status === 'arrived'
              ? 'arrived'
              : 'neutral';
  const label = humaniseApptStatus(status);
  return (
    <StatusPill tone={tone} size="sm">
      {label}
    </StatusPill>
  );
}

function humaniseVisitStatus(s: PatientVisitRow['status']): string {
  switch (s) {
    case 'opened':
      return 'Arrived';
    case 'in_progress':
      return 'In progress';
    case 'complete':
      return 'Complete';
    case 'cancelled':
      return 'Cancelled';
  }
}

function humaniseApptStatus(s: ScheduledApptStatus): string {
  switch (s) {
    case 'booked':
      return 'Booked';
    case 'arrived':
      return 'Arrived';
    case 'in_progress':
      return 'In progress';
    case 'complete':
      return 'Complete';
    case 'no_show':
      return 'No show';
    case 'cancelled':
      return 'Cancelled';
    case 'rescheduled':
      return 'Rescheduled';
  }
}

function paymentLabel(v: PatientVisitRow): string {
  if (v.cart_status === 'paid' && v.cart_total_pence != null) return formatPence(v.cart_total_pence);
  if (v.cart_status === 'voided') return 'Voided';
  return 'Pending';
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Case history — Meridian's `cases` table grouped into Active / Paused /
// Completed buckets. Empty buckets are hidden.
// ─────────────────────────────────────────────────────────────────────────────

function CaseHistory({ cases, loading }: { cases: PatientCaseRow[]; loading: boolean }) {
  // Paginated, flat, newest-first. The bucket grouping that lived here
  // before is preserved per-row via the status pill inside CaseRow —
  // grouping plus pagination both at once read as too busy on a single
  // card.
  const ordered = useMemo(() => {
    return [...cases].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }, [cases]);
  const pager = usePagedRows(ordered, PROFILE_PAGE_SIZE);
  // Bucket counts in the header eyebrow so reception still sees the
  // active / paused / completed split at a glance even though the
  // visible rows are mixed.
  const bucketSummary = useMemo(() => {
    const counts = { active: 0, paused: 0, completed: 0 };
    for (const c of cases) counts[bucketCase(c)]++;
    return counts;
  }, [cases]);

  return (
    <CollapsibleCard
      icon={<Layers size={18} color={theme.color.ink} aria-hidden />}
      title="Case history"
      meta={`${cases.length} ${cases.length === 1 ? 'case' : 'cases'}`}
    >
      {loading ? (
        <Skeleton height={80} radius={14} />
      ) : cases.length === 0 ? (
        <EmptyState title="No cases yet" description="Cases raised in Meridian for this patient will appear here." />
      ) : (
        <>
          <div
            style={{
              display: 'flex',
              gap: theme.space[3],
              fontSize: theme.type.size.xs,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.inkMuted,
              textTransform: 'uppercase',
              letterSpacing: theme.type.tracking.tight,
              marginBottom: theme.space[3],
              flexWrap: 'wrap',
            }}
          >
            <CaseBucketBadge color="#1d4ed8" label="Active" count={bucketSummary.active} />
            <CaseBucketBadge color="#a16207" label="Paused" count={bucketSummary.paused} />
            <CaseBucketBadge color="#16a34a" label="Completed" count={bucketSummary.completed} />
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
            {pager.visible.map((c) => (
              <li key={c.id}>
                <CaseRow row={c} />
              </li>
            ))}
          </ul>
          <ListPager
            page={pager.page}
            totalPages={pager.totalPages}
            onPrev={() => pager.setPage((p) => Math.max(0, p - 1))}
            onNext={() => pager.setPage((p) => Math.min(pager.totalPages - 1, p + 1))}
          />
        </>
      )}
    </CollapsibleCard>
  );
}

function CaseBucketBadge({ color, label, count }: { color: string; label: string; count: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block' }} />
      {label} ({count})
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Signed waivers — full audit table of every signing event for this
// patient. Newest first. Each row exposes Download (raw signature SVG)
// and Print (a clean window with the section title, version, signed-at,
// witness, the terms snapshot the patient agreed to, and the signature
// itself rendered to scale). Audit-grade output — terms_snapshot is the
// frozen copy of what was signed, so re-printing decades later still
// reproduces the exact contract.
// ─────────────────────────────────────────────────────────────────────────────

function SignedWaiversHistory({
  patient,
  patientName,
  isMobile,
  rows,
  loading,
  error,
}: {
  patient: PatientProfileRow;
  patientName: string;
  isMobile: boolean;
  // Lifted up to PatientProfile so the inline-sign flow on
  // WaiverStatus can refresh this list in the same tick it refreshes
  // its own. See the useSignedWaivers call at the route level.
  rows: SignedWaiverRow[];
  loading: boolean;
  error: string | null;
}) {
  const { sections } = useWaiverSections();
  // Single dialog instance for the section. Selecting a row sets the
  // viewer's input; closing it clears the row. The dialog itself is
  // pure rendering — the doc memo lives here so the row → doc
  // transformation is in one place rather than re-derived inside the
  // dialog or each row.
  const [viewerRow, setViewerRow] = useState<SignedWaiverRow | null>(null);
  const viewerDoc = useMemo<WaiverDocInput | null>(
    () => (viewerRow ? buildSignedWaiverDoc(viewerRow, patient, patientName) : null),
    [viewerRow, patient, patientName],
  );
  // Map section_key → the live current version. Used by the table to
  // decide whether each row's version chip should render green (this
  // signature is at the published terms) or muted (the patient signed
  // an earlier version and re-sign would be required).
  const currentByKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of sections) {
      if (s.active) m.set(s.key, s.version);
    }
    return m;
  }, [sections]);
  const pager = usePagedRows(rows, PROFILE_PAGE_SIZE);

  return (
    <CollapsibleCard
      icon={<FileSignature size={18} color={theme.color.ink} aria-hidden />}
      title="Signed waivers"
      meta={`${rows.length} ${rows.length === 1 ? 'signature' : 'signatures'}`}
    >
      {error ? (
        <p style={{ margin: 0, color: theme.color.alert, fontSize: theme.type.size.sm }}>
          Could not load signatures: {error}
        </p>
      ) : loading ? (
        <Skeleton height={120} radius={14} />
      ) : rows.length === 0 ? (
        <EmptyState title="No signatures yet" description="Waivers signed during arrival or consent will list here." />
      ) : (
        <>
          {isMobile ? (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
              {pager.visible.map((r) => (
                <li key={r.id}>
                  <SignedWaiverCard
                    row={r}
                    isCurrent={currentByKey.get(r.section_key) === r.section_version}
                    onView={() => setViewerRow(r)}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <SignedWaiverTable
              rows={pager.visible}
              currentByKey={currentByKey}
              onView={(row) => setViewerRow(row)}
            />
          )}
          <ListPager
            page={pager.page}
            totalPages={pager.totalPages}
            onPrev={() => pager.setPage((p) => Math.max(0, p - 1))}
            onNext={() => pager.setPage((p) => Math.min(pager.totalPages - 1, p + 1))}
          />
        </>
      )}
      <WaiverViewerDialog
        open={viewerRow !== null}
        onClose={() => setViewerRow(null)}
        doc={viewerDoc}
        // No visit context for patient-profile waivers — emails go
        // through the email-waiver function which audits against a
        // visit. Passing null + allowEmail=false keeps the dialog
        // consistent with that constraint instead of letting the
        // user click Email and hit the visit-missing error path.
        visitId={null}
        patientEmail={patient.email}
        allowEmail={false}
      />
    </CollapsibleCard>
  );
}

// Build a waiver-mode WaiverDocInput from a single signed-waiver row.
// "Waiver mode" means the document carries no transaction context
// (no LAP, no items, no totals, no payment) — the right-side header
// shows "Signed" + the date instead of a visit reference, and the
// renderer skips the items table, totals breakdown and payment row
// entirely. Callers compose the full dialog input here so the dialog
// stays a pure renderer regardless of whether it's mounted on
// VisitDetail or PatientProfile.
function buildSignedWaiverDoc(
  row: SignedWaiverRow,
  patient: PatientProfileRow,
  patientName: string,
): WaiverDocInput | null {
  if (!row.terms_snapshot || row.terms_snapshot.length === 0) {
    // Render-time error rather than a silent empty-terms doc — admin
    // can fix the underlying row by re-signing the section.
    return null;
  }
  // Short signed-date label for the right-side header. Keeps the
  // typographic rhythm matched to the visit-mode LAP block (mono,
  // accent, ~13pt) without forcing a real LAP value into the data.
  const signedShort = (() => {
    const d = new Date(row.signed_at);
    if (Number.isNaN(d.getTime())) return row.signed_at;
    return d
      .toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
      .toUpperCase();
  })();
  const slugDate = (() => {
    const d = new Date(row.signed_at);
    if (Number.isNaN(d.getTime())) return 'unknown-date';
    return d.toISOString().slice(0, 10);
  })();
  const sectionSlug = (row.section_title ?? row.section_key)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const nameSlug = patientName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return {
    kind: 'waiver',
    referenceLabel: 'Signed',
    lapRef: signedShort,
    documentSlug: [nameSlug, sectionSlug, slugDate].filter(Boolean).join('-'),
    visitType: row.section_title,
    patient: {
      fullName: patientName,
      dateOfBirth: patient.date_of_birth,
      sex: patient.sex,
      email: patient.email,
      phone: patient.phone,
      addressLine1: patient.portal_ship_line1,
      addressLine2: patient.portal_ship_line2,
      city: patient.portal_ship_city,
      postcode: patient.portal_ship_postcode,
    },
    visitOpenedAt: row.signed_at,
    witnessName: row.witness_name,
    items: [],
    notes: null,
    sections: [
      {
        title: row.section_title ?? row.section_key,
        version: row.section_version,
        terms: row.terms_snapshot,
        signedAt: row.signed_at,
        witnessName: row.witness_name,
      },
    ],
    signatureSvg: row.signature_svg,
    payment: null,
    brand: {
      name: 'Venneir',
      contactEmail: 'cs@venneir.com',
      vatNumber: 'GB406459983',
      logoUrl: window.location.origin + '/black-venneir-logo.png',
      addressLine: null,
    },
    accentColor: theme.color.accent,
  };
}

function SignedWaiverTable({
  rows,
  currentByKey,
  onView,
}: {
  rows: SignedWaiverRow[];
  currentByKey: Map<string, string>;
  onView: (row: SignedWaiverRow) => void;
}) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: theme.type.size.sm,
          color: theme.color.ink,
        }}
      >
        <thead>
          <tr>
            <th style={tableHeaderStyle}>Section</th>
            <th style={tableHeaderStyle}>Version</th>
            <th style={tableHeaderStyle}>Signed</th>
            <th style={tableHeaderStyle}>Witness</th>
            <th style={{ ...tableHeaderStyle, textAlign: 'right' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} style={{ borderTop: `1px solid ${theme.color.border}` }}>
              <td style={tableCellStyle}>
                <span style={{ fontWeight: theme.type.weight.medium }}>
                  {r.section_title ?? r.section_key}
                </span>
              </td>
              <td style={tableCellStyle}>
                <VersionPill
                  version={r.section_version}
                  isCurrent={currentByKey.get(r.section_key) === r.section_version}
                />
              </td>
              <td style={tableCellStyle}>{formatLongDateTime(r.signed_at)}</td>
              <td style={tableCellStyle}>
                {r.witness_name ?? <span style={{ color: theme.color.inkSubtle }}>not recorded</span>}
              </td>
              <td style={{ ...tableCellStyle, textAlign: 'right' }}>
                <SignatureActions onView={() => onView(r)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SignedWaiverCard({
  row,
  isCurrent,
  onView,
}: {
  row: SignedWaiverRow;
  isCurrent: boolean;
  onView: () => void;
}) {
  return (
    <div
      style={{
        padding: theme.space[3],
        borderRadius: theme.radius.card,
        border: `1px solid ${theme.color.border}`,
        background: theme.color.surface,
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[2],
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: theme.space[2] }}>
        <span style={{ fontWeight: theme.type.weight.semibold, color: theme.color.ink }}>
          {row.section_title ?? row.section_key}
        </span>
        <VersionPill version={row.section_version} isCurrent={isCurrent} />
      </div>
      <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
        Signed {formatLongDateTime(row.signed_at)}
        {row.witness_name ? ` · witnessed by ${row.witness_name}` : ''}
      </span>
      <div style={{ display: 'flex', gap: theme.space[2], marginTop: theme.space[1] }}>
        <SignatureActions onView={onView} />
      </div>
    </div>
  );
}

// Tiny pill that flips green-with-tick when the signed version matches
// the section's published version. Muted code-style otherwise so older
// signatures still print the version legibly without competing with
// the live ones.
function VersionPill({ version, isCurrent }: { version: string; isCurrent: boolean }) {
  if (!isCurrent) {
    return (
      <code style={{ fontSize: theme.type.size.xs, color: theme.color.inkMuted, fontVariantNumeric: 'tabular-nums' }}>
        {version}
      </code>
    );
  }
  return (
    <span
      title="Signed at the current published version"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: `2px ${theme.space[2]}px`,
        borderRadius: theme.radius.pill,
        background: theme.color.accentBg,
        color: theme.color.accent,
        fontSize: theme.type.size.xs,
        fontWeight: theme.type.weight.semibold,
        fontVariantNumeric: 'tabular-nums',
        border: `1px solid ${theme.color.accent}`,
      }}
    >
      <Check size={12} strokeWidth={3} aria-hidden />
      {version}
    </span>
  );
}

function SignatureActions({ onView }: { onView: () => void }) {
  return (
    <span style={{ display: 'inline-flex', gap: theme.space[1] }}>
      <button type="button" onClick={onView} style={iconButtonStyle} aria-label="View signed waiver">
        <Eye size={14} />
        <span>View</span>
      </button>
    </span>
  );
}

function formatLongDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const tableHeaderStyle: CSSProperties = {
  textAlign: 'left',
  fontSize: theme.type.size.xs,
  fontWeight: theme.type.weight.semibold,
  textTransform: 'uppercase',
  letterSpacing: theme.type.tracking.wide,
  color: theme.color.inkMuted,
  padding: `${theme.space[2]}px ${theme.space[3]}px`,
};

const tableCellStyle: CSSProperties = {
  padding: `${theme.space[3]}px`,
  verticalAlign: 'top',
  fontSize: theme.type.size.sm,
};

const iconButtonStyle: CSSProperties = {
  appearance: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: `${theme.space[1]}px ${theme.space[3]}px`,
  borderRadius: theme.radius.pill,
  border: `1px solid ${theme.color.border}`,
  background: theme.color.surface,
  color: theme.color.ink,
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: theme.type.size.xs,
  fontWeight: theme.type.weight.medium,
};

function CaseRow({ row }: { row: PatientCaseRow }) {
  return (
    <div
      style={{
        padding: theme.space[3],
        borderRadius: theme.radius.card,
        border: `1px solid ${theme.color.border}`,
        background: theme.color.surface,
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
      }}
    >
      <span
        style={{
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: theme.type.size.sm,
          color: theme.color.ink,
          flexShrink: 0,
        }}
      >
        {row.case_reference}
      </span>
      <span style={{ flex: 1, minWidth: 0, color: theme.color.inkMuted, fontSize: theme.type.size.sm, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {row.type_label ?? '—'}
      </span>
      <StatusPill tone={row.is_terminal ? 'complete' : row.paused_at ? 'no_show' : 'in_progress'} size="sm">
        {row.stage_label ?? row.stage_key ?? 'Unknown'}
      </StatusPill>
      <span
        style={{
          fontSize: theme.type.size.sm,
          color: theme.color.inkMuted,
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
        }}
      >
        {formatDateTime(row.completed_at ?? row.paused_at ?? row.created_at)}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Pagination — shared by Appointments / Case history / Signed waivers.
// 10 rows per page across all three sections so the profile reads
// uniformly: same Prev / Next pill row, same "Page X of N" copy.
// ─────────────────────────────────────────────────────────────────────────────

const PROFILE_PAGE_SIZE = 10;

interface PagedRows<T> {
  page: number;
  setPage: (updater: (p: number) => number) => void;
  totalPages: number;
  visible: T[];
}

function usePagedRows<T>(rows: T[], pageSize: number): PagedRows<T> {
  const [page, setPageRaw] = useState(0);
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  // Clamp the current page back into range when the list shrinks
  // underneath us (e.g. data reloads after a filter / refresh).
  useEffect(() => {
    if (page > totalPages - 1) setPageRaw(0);
  }, [page, totalPages]);
  const start = page * pageSize;
  const visible = rows.slice(start, start + pageSize);
  const setPage = (updater: (p: number) => number) => setPageRaw((p) => updater(p));
  return { page, setPage, totalPages, visible };
}

function ListPager({
  page,
  totalPages,
  onPrev,
  onNext,
}: {
  page: number;
  totalPages: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  if (totalPages <= 1) return null;
  const prevDisabled = page === 0;
  const nextDisabled = page >= totalPages - 1;
  return (
    <nav
      aria-label="Page navigation"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space[3],
        marginTop: theme.space[4],
      }}
    >
      <button type="button" onClick={onPrev} disabled={prevDisabled} style={pagerButtonStyle(prevDisabled)}>
        <ChevronLeft size={16} />
        <span>Previous</span>
      </button>
      <span
        style={{
          fontSize: theme.type.size.sm,
          color: theme.color.inkMuted,
          fontVariantNumeric: 'tabular-nums',
          fontWeight: theme.type.weight.medium,
        }}
      >
        Page {page + 1} of {totalPages}
      </span>
      <button type="button" onClick={onNext} disabled={nextDisabled} style={pagerButtonStyle(nextDisabled)}>
        <span>Next</span>
        <ChevronRight size={16} />
      </button>
    </nav>
  );
}

function pagerButtonStyle(disabled: boolean): CSSProperties {
  return {
    appearance: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.space[1],
    padding: `${theme.space[2]}px ${theme.space[4]}px`,
    borderRadius: theme.radius.pill,
    border: `1px solid ${theme.color.border}`,
    background: theme.color.surface,
    color: disabled ? theme.color.inkSubtle : theme.color.ink,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontFamily: 'inherit',
    fontSize: theme.type.size.sm,
    fontWeight: theme.type.weight.medium,
    opacity: disabled ? 0.55 : 1,
  };
}
