import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { Info, Layers, Pencil, ShoppingBag, X } from 'lucide-react';
import {
  BeforeAfterGallery,
  Breadcrumb,
  Card,
  EmptyState,
  MarketingGallery,
  Skeleton,
  StatusPill,
} from '../components/index.ts';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../components/KioskStatusBar/KioskStatusBar.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useIsMobile } from '../lib/useIsMobile.ts';
import { properCase } from '../lib/queries/appointments.ts';
import {
  bucketCase,
  usePatientCases,
  usePatientProfile,
  usePatientProfileFiles,
  usePatientVisits,
  type PatientCaseRow,
  type PatientProfileRow,
  type PatientVisitRow,
} from '../lib/queries/patientProfile.ts';
import { formatPence } from '../lib/queries/carts.ts';

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
  const { data: patient, loading: patientLoading, error: patientError } = usePatientProfile(id);
  const { data: files, loading: filesLoading, refresh: refreshFiles } = usePatientProfileFiles(id);
  const { data: visits, loading: visitsLoading } = usePatientVisits(id);
  const { data: cases, loading: casesLoading } = usePatientCases(id);

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
          <Card padding="lg">
            <Skeleton height={120} radius={14} />
          </Card>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
            <Hero patient={patient} cases={cases} isMobile={isMobile} />
            <NotesAndFlags patient={patient} />
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
            <WalkInAppointments
              visits={visits}
              loading={visitsLoading}
              isMobile={isMobile}
              patientId={patient.id}
              patientName={`${properCase(patient.first_name)} ${properCase(patient.last_name)}`.trim() || 'Patient'}
            />
            <CaseHistory cases={cases} loading={casesLoading} />
          </div>
        )}
      </div>
    </main>
  );
}

function Breadcrumbs({ patient }: { patient: PatientProfileRow | null }) {
  const navigate = useNavigate();
  const name = patient ? `${properCase(patient.first_name)} ${properCase(patient.last_name)}`.trim() : 'Patient';
  return (
    <div style={{ margin: `${theme.space[3]}px 0 ${theme.space[6]}px` }}>
      <Breadcrumb
        items={[
          { label: 'Patients', onClick: () => navigate('/patients') },
          { label: name },
        ]}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Hero card — identity block + 12-field grid.
// ─────────────────────────────────────────────────────────────────────────────

function Hero({
  patient,
  cases: _cases,
  isMobile,
}: {
  patient: PatientProfileRow;
  cases: PatientCaseRow[];
  isMobile: boolean;
}) {
  // The earlier "Active / Inactive" pill mapped to whether the
  // patient had any non-terminal Meridian case — useful in Meridian,
  // confusing on the Lounge surface where staff already see a live
  // visit if one is open. Dropped to keep the hero focused on
  // identity. The cases list still drives the case-history section
  // below.
  const fullName = `${properCase(patient.first_name)} ${properCase(patient.last_name)}`.trim() || 'Unnamed patient';
  const initials = `${(patient.first_name?.[0] ?? '').toUpperCase()}${(patient.last_name?.[0] ?? '').toUpperCase()}` || '?';
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
          <div
            aria-hidden
            style={{
              width: 56,
              height: 56,
              borderRadius: '50%',
              background: theme.color.accent,
              color: '#fff',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: theme.type.size.md,
              fontWeight: theme.type.weight.semibold,
              flexShrink: 0,
            }}
          >
            {initials}
          </div>
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
          title="Edit patient details (coming soon)"
          disabled
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
            color: theme.color.inkSubtle,
            cursor: 'not-allowed',
            flexShrink: 0,
          }}
        >
          <Pencil size={14} />
        </button>
      </div>

      <div style={{ height: 1, background: theme.color.border, margin: `${theme.space[5]}px 0` }} />

      <FieldGrid isMobile={isMobile} fields={buildHeroFields(patient)} />
    </Card>
  );
}

// "Linked to Shopify & One Click" pill. Tap or focus the (i) icon to
// reveal a popover explaining where the data comes from and how the
// patient updates it. Mirrors Meridian's identity-pill pattern so the
// two surfaces feel like one product.
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
        aria-label="Linked to Shopify and One Click — show details"
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
        <ShoppingBag size={12} aria-hidden />
        Linked to Shopify &amp; One Click
        <Info size={12} aria-hidden style={{ opacity: 0.75 }} />
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Shopify and One Click linked account"
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
            Linked to Shopify &amp; One Click
          </p>
          <p
            style={{
              margin: `${theme.space[2]}px 0 0`,
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
              lineHeight: 1.55,
            }}
          >
            These details come from the customer&apos;s Shopify &amp; One Click account.
            They can update them any time in the One Click app or on Shopify
            (it&apos;s the same account, so a change in one shows up in the other).
            If anything here is wrong, the customer must update it themselves and
            it&apos;ll reflect here.
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
}

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
    { label: 'Country', value: p.portal_ship_country_code },
    { label: 'Emergency contact', value: p.emergency_contact_name },
    { label: 'Emergency phone', value: p.emergency_contact_phone },
    { label: 'Registered', value: formatDate(p.registered_at) },
    { label: 'Shopify customer', value: p.shopify_customer_id, mono: true },
    { label: 'LWO contact', value: p.lwo_contact_id, mono: true },
    { label: 'Referred by', value: p.referred_by },
    { label: 'Insurance', value: p.insurance },
  ];
}

function FieldGrid({ fields, isMobile }: { fields: FieldDef[]; isMobile: boolean }) {
  const monoStack = 'ui-monospace, SFMono-Regular, Menlo, monospace';
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, minmax(0, 1fr))',
        columnGap: theme.space[6],
        rowGap: theme.space[4],
        minWidth: 0,
      }}
    >
      {fields.map((f) => {
        const empty = f.value == null || f.value === '';
        return (
          <div key={f.label} style={{ minWidth: 0 }}>
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
                // Allow long values (emails, addresses) to wrap rather
                // than ellipsis-truncate. wordBreak handles single
                // unbroken tokens like long email locals.
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
// Notes and flags — three muted read-only fields.
// ─────────────────────────────────────────────────────────────────────────────

function NotesAndFlags({ patient }: { patient: PatientProfileRow }) {
  const allergies = (patient.allergies ?? '').trim();
  const comms = (patient.communication_preferences ?? '').trim();
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
          Notes &amp; flags
        </h2>
        <button
          type="button"
          aria-label="Edit notes and flags"
          title="Edit notes and flags (coming soon)"
          disabled
          style={{
            appearance: 'none',
            width: 32,
            height: 32,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: `1px solid ${theme.color.border}`,
            borderRadius: theme.radius.input,
            color: theme.color.inkSubtle,
            cursor: 'not-allowed',
          }}
        >
          <Pencil size={14} />
        </button>
      </div>

      <div style={{ height: 1, background: theme.color.border, margin: `${theme.space[4]}px 0 ${theme.space[5]}px` }} />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          columnGap: theme.space[6],
          rowGap: theme.space[4],
        }}
      >
        <NotesField label="Allergies & sensitivities" value={allergies} />
        <NotesField label="Communication preferences" value={comms} />
        <NotesField label="Permanent notes" value={permanent} multiline />
      </div>
    </Card>
  );
}

function NotesField({ label, value, multiline = false }: { label: string; value: string; multiline?: boolean }) {
  const empty = !value;
  return (
    <div style={{ minWidth: 0 }}>
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
// Walk-in appointments table — per-visit row.
// ─────────────────────────────────────────────────────────────────────────────

function WalkInAppointments({
  visits,
  loading,
  isMobile,
  patientId,
  patientName,
}: {
  visits: PatientVisitRow[];
  loading: boolean;
  isMobile: boolean;
  patientId: string;
  patientName: string;
}) {
  const navigate = useNavigate();
  // Tell the visit page where the user came from. VisitDetail's
  // breadcrumb uses this to render "Patients › Name › Visit" instead
  // of "Schedule › Visit", so back-navigation lands on this profile.
  const openVisit = (id: string) =>
    navigate(`/visit/${id}`, { state: { from: 'patient', patientId, patientName } });
  return (
    <Card padding="lg">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2] }}>
          <h2
            style={{
              margin: 0,
              fontSize: theme.type.size.lg,
              fontWeight: theme.type.weight.semibold,
              letterSpacing: theme.type.tracking.tight,
              color: theme.color.ink,
            }}
          >
            Appointments
          </h2>
        </div>
        <span
          style={{
            color: theme.color.inkMuted,
            fontSize: theme.type.size.sm,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {visits.length} {visits.length === 1 ? 'appointment' : 'appointments'}
        </span>
      </div>

      <div style={{ height: 1, background: theme.color.border, margin: `${theme.space[4]}px 0 ${theme.space[5]}px` }} />

      {loading ? (
        <Skeleton height={120} radius={14} />
      ) : visits.length === 0 ? (
        <EmptyState title="No appointments yet" description="Walk-ins and arrivals will list here." />
      ) : isMobile ? (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
          {visits.map((v) => (
            <li key={v.id}>
              <VisitRowMobile visit={v} onClick={() => openVisit(v.id)} />
            </li>
          ))}
        </ul>
      ) : (
        <VisitsTable visits={visits} onRowClick={(v) => openVisit(v.id)} />
      )}
    </Card>
  );
}

function VisitsTable({ visits, onRowClick }: { visits: PatientVisitRow[]; onRowClick: (v: PatientVisitRow) => void }) {
  const headerStyle: React.CSSProperties = {
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
  const cellStyle: React.CSSProperties = {
    padding: `${theme.space[3]}px ${theme.space[3]}px`,
    fontSize: theme.type.size.sm,
    color: theme.color.ink,
    borderBottom: `1px solid ${theme.color.border}`,
    verticalAlign: 'middle',
  };
  return (
    <div style={{ overflowX: 'auto', margin: `0 -${theme.space[3]}px` }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontVariantNumeric: 'tabular-nums' }}>
        <thead>
          <tr>
            <th style={headerStyle}>Date</th>
            <th style={headerStyle}>LWO ref</th>
            <th style={headerStyle}>Service</th>
            <th style={headerStyle}>Status</th>
            <th style={{ ...headerStyle, textAlign: 'right' }}>Payment</th>
          </tr>
        </thead>
        <tbody>
          {visits.map((v) => (
            <tr
              key={v.id}
              onClick={() => onRowClick(v)}
              style={{ cursor: 'pointer' }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLTableRowElement).style.background = theme.color.bg;
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLTableRowElement).style.background = 'transparent';
              }}
            >
              <td style={cellStyle}>{formatDateTime(v.opened_at)}</td>
              <td style={{ ...cellStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: theme.color.inkMuted }}>
                {v.lwo_ref ?? '—'}
              </td>
              <td style={cellStyle}>{v.service_label ?? '—'}</td>
              <td style={cellStyle}>
                <VisitStatusPill visit={v} />
              </td>
              <td style={{ ...cellStyle, textAlign: 'right', color: v.cart_status === 'paid' ? theme.color.ink : theme.color.inkMuted }}>
                {paymentLabel(v)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VisitRowMobile({ visit, onClick }: { visit: PatientVisitRow; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: 'none',
        width: '100%',
        textAlign: 'left',
        padding: theme.space[3],
        borderRadius: theme.radius.card,
        border: `1px solid ${theme.color.border}`,
        background: theme.color.surface,
        cursor: 'pointer',
        fontFamily: 'inherit',
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: theme.type.size.sm, fontWeight: theme.type.weight.semibold, color: theme.color.ink }}>
          {visit.service_label ?? 'Appointment'}
        </p>
        <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.inkMuted, fontVariantNumeric: 'tabular-nums' }}>
          {formatDateTime(visit.opened_at)} · {visit.lwo_ref ?? 'no LWO ref'}
        </p>
      </div>
      <VisitStatusPill visit={visit} />
      <span style={{ fontVariantNumeric: 'tabular-nums', color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
        {paymentLabel(visit)}
      </span>
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
  const groups = useMemo(() => {
    const buckets: Record<string, PatientCaseRow[]> = { active: [], paused: [], completed: [] };
    for (const c of cases) buckets[bucketCase(c)]!.push(c);
    return [
      { key: 'active' as const, label: 'Active', dot: '#1d4ed8', cases: buckets.active! },
      { key: 'paused' as const, label: 'Paused', dot: '#a16207', cases: buckets.paused! },
      { key: 'completed' as const, label: 'Completed', dot: '#16a34a', cases: buckets.completed! },
    ].filter((g) => g.cases.length > 0);
  }, [cases]);

  return (
    <Card padding="lg">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2] }}>
          <Layers size={18} color={theme.color.ink} aria-hidden />
          <h2
            style={{
              margin: 0,
              fontSize: theme.type.size.lg,
              fontWeight: theme.type.weight.semibold,
              letterSpacing: theme.type.tracking.tight,
              color: theme.color.ink,
            }}
          >
            Case history
          </h2>
        </div>
        <span style={{ color: theme.color.inkMuted, fontSize: theme.type.size.sm, fontVariantNumeric: 'tabular-nums' }}>
          {cases.length} {cases.length === 1 ? 'case' : 'cases'}
        </span>
      </div>

      <div style={{ height: 1, background: theme.color.border, margin: `${theme.space[4]}px 0 ${theme.space[5]}px` }} />

      {loading ? (
        <Skeleton height={80} radius={14} />
      ) : cases.length === 0 ? (
        <EmptyState title="No cases yet" description="Cases raised in Meridian for this patient will appear here." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
          {groups.map((g) => (
            <div key={g.key}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: theme.space[2],
                  fontSize: theme.type.size.xs,
                  fontWeight: theme.type.weight.semibold,
                  color: theme.color.inkMuted,
                  textTransform: 'uppercase',
                  letterSpacing: theme.type.tracking.tight,
                  marginBottom: theme.space[3],
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: g.dot, display: 'inline-block' }} />
                {g.label} ({g.cases.length})
              </div>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
                {g.cases.map((c) => (
                  <li key={c.id}>
                    <CaseRow row={c} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

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
