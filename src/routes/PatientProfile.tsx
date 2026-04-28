import { useMemo, useState } from 'react';
import { Navigate, Link, useNavigate, useParams } from 'react-router-dom';
import { ChevronRight, Download, FileText, Image as ImageIcon, Layers, Paperclip, Pencil, Pin } from 'lucide-react';
import { Card, EmptyState, Skeleton, StatusPill } from '../components/index.ts';
import { TopBar } from '../components/TopBar/TopBar.tsx';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../components/KioskStatusBar/KioskStatusBar.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useIsMobile } from '../lib/useIsMobile.ts';
import { properCase } from '../lib/queries/appointments.ts';
import { signedUrlFor } from '../lib/queries/patientFiles.ts';
import {
  PATIENT_FILE_SLOTS,
  bucketCase,
  usePatientCases,
  usePatientProfile,
  usePatientProfileFiles,
  usePatientVisits,
  type PatientCaseRow,
  type PatientFileEntry,
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
  const { data: files, loading: filesLoading } = usePatientProfileFiles(id);
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
      <div style={{ maxWidth: 960, margin: '0 auto' }}>
        <TopBar variant="subpage" backTo="/patients" />

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
            <PatientFiles files={files} loading={filesLoading} isMobile={isMobile} />
            <WalkInAppointments visits={visits} loading={visitsLoading} isMobile={isMobile} />
            <CaseHistory cases={cases} loading={casesLoading} />
          </div>
        )}
      </div>
    </main>
  );
}

function Breadcrumbs({ patient }: { patient: PatientProfileRow | null }) {
  const name = patient ? `${properCase(patient.first_name)} ${properCase(patient.last_name)}`.trim() : 'Patient';
  return (
    <nav
      aria-label="Breadcrumb"
      style={{
        margin: `${theme.space[3]}px 0 ${theme.space[5]}px`,
        fontSize: theme.type.size.sm,
        color: theme.color.inkMuted,
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[1],
      }}
    >
      <Link to="/patients" style={{ color: theme.color.inkMuted, textDecoration: 'none' }}>
        Patients
      </Link>
      <ChevronRight size={14} aria-hidden />
      <span style={{ color: theme.color.ink }}>{name}</span>
    </nav>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Hero card — identity block + 12-field grid.
// ─────────────────────────────────────────────────────────────────────────────

function Hero({
  patient,
  cases,
  isMobile,
}: {
  patient: PatientProfileRow;
  cases: PatientCaseRow[];
  isMobile: boolean;
}) {
  const status = useMemo(() => {
    const open = cases.some((c) => !c.is_terminal);
    return open ? ('arrived' as const) : ('neutral' as const);
  }, [cases]);
  const statusLabel = status === 'arrived' ? 'Active' : 'Inactive';

  const fullName = `${properCase(patient.first_name)} ${properCase(patient.last_name)}`.trim() || 'Unnamed patient';
  const initials = `${(patient.first_name?.[0] ?? '').toUpperCase()}${(patient.last_name?.[0] ?? '').toUpperCase()}` || '?';

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
              <StatusPill tone={status} size="sm">{statusLabel}</StatusPill>
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
    { label: 'Delivery address', value: p.address },
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
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                lineHeight: 1.4,
              }}
              title={empty ? undefined : f.value!}
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
// Patient files — slot grid keyed by file_labels.key. Each slot shows
// the latest active file for that label, or an empty "click to add"
// placeholder.
// ─────────────────────────────────────────────────────────────────────────────

function PatientFiles({
  files,
  loading,
  isMobile,
}: {
  files: PatientFileEntry[];
  loading: boolean;
  isMobile: boolean;
}) {
  // Map: label_key → latest entry. files come ordered by uploaded_at desc.
  const latestByKey = useMemo(() => {
    const map = new Map<string, PatientFileEntry>();
    for (const f of files) {
      if (!f.label_key) continue;
      if (!map.has(f.label_key)) map.set(f.label_key, f);
    }
    return map;
  }, [files]);
  const presentCount = latestByKey.size;

  return (
    <Card padding="lg">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2] }}>
          <Paperclip size={18} color={theme.color.ink} aria-hidden />
          <h2
            style={{
              margin: 0,
              fontSize: theme.type.size.lg,
              fontWeight: theme.type.weight.semibold,
              letterSpacing: theme.type.tracking.tight,
              color: theme.color.ink,
            }}
          >
            Patient Files
          </h2>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: theme.space[3],
            color: theme.color.inkMuted,
            fontSize: theme.type.size.sm,
          }}
        >
          <button
            type="button"
            aria-label="Download all files"
            title="Download all (coming soon)"
            disabled
            style={{
              appearance: 'none',
              border: 'none',
              background: 'transparent',
              cursor: 'not-allowed',
              color: theme.color.inkSubtle,
              padding: theme.space[1],
            }}
          >
            <Download size={18} />
          </button>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            {presentCount} {presentCount === 1 ? 'file' : 'files'}
          </span>
        </div>
      </div>

      <div style={{ height: 1, background: theme.color.border, margin: `${theme.space[4]}px 0 ${theme.space[5]}px` }} />

      {loading ? (
        <Skeleton height={140} radius={14} />
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: isMobile ? 'repeat(2, minmax(0, 1fr))' : 'repeat(3, minmax(0, 1fr))',
            gap: theme.space[3],
          }}
        >
          {PATIENT_FILE_SLOTS.map((slot) => {
            const entry = latestByKey.get(slot.key) ?? null;
            return <FileSlot key={slot.key} slotLabel={slot.label} hint={slot.acceptHint} entry={entry} />;
          })}
        </div>
      )}
    </Card>
  );
}

function FileSlot({
  slotLabel,
  hint,
  entry,
}: {
  slotLabel: string;
  hint: string;
  entry: PatientFileEntry | null;
}) {
  const [busy, setBusy] = useState(false);

  const open = async () => {
    if (!entry) return;
    setBusy(true);
    try {
      const url = await signedUrlFor(entry.file_url, 300);
      if (url) window.open(url, '_blank');
    } finally {
      setBusy(false);
    }
  };

  if (!entry) {
    return (
      <div
        aria-disabled
        style={{
          padding: theme.space[3],
          minHeight: 168,
          borderRadius: theme.radius.card,
          border: `1px dashed ${theme.color.border}`,
          background: theme.color.bg,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          color: theme.color.inkSubtle,
          opacity: 0.7,
          gap: theme.space[2],
          cursor: 'not-allowed',
        }}
        title="Upload available in a follow-up phase"
      >
        <FileText size={20} />
        <span style={{ fontSize: theme.type.size.sm, fontWeight: theme.type.weight.medium, color: theme.color.inkMuted }}>
          Upload {slotLabel}
        </span>
        <span style={{ fontSize: theme.type.size.xs }}>Click to add the first version</span>
        <span style={{ fontSize: theme.type.size.xs }}>{hint}</span>
      </div>
    );
  }

  const isImage = entry.mime_type?.startsWith('image/');

  return (
    <button
      type="button"
      onClick={open}
      disabled={busy}
      style={{
        appearance: 'none',
        textAlign: 'left',
        padding: 0,
        minHeight: 168,
        borderRadius: theme.radius.card,
        border: `1px solid ${theme.color.border}`,
        background: theme.color.surface,
        cursor: busy ? 'wait' : 'pointer',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        position: 'relative',
        fontFamily: 'inherit',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: theme.space[2],
          left: theme.space[2],
          width: 28,
          height: 28,
          borderRadius: '50%',
          background: '#F59E0B',
          color: '#fff',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: theme.shadow.card,
        }}
        aria-hidden
      >
        <Pin size={14} />
      </div>
      <div
        style={{
          flex: 1,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: theme.color.bg,
          color: theme.color.inkSubtle,
        }}
      >
        {isImage ? <ImageIcon size={32} aria-hidden /> : <FileText size={32} aria-hidden />}
      </div>
      <div
        style={{
          padding: theme.space[3],
          borderTop: `1px solid ${theme.color.border}`,
          background: theme.color.surface,
        }}
      >
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {slotLabel} <span style={{ color: theme.color.inkMuted, fontWeight: theme.type.weight.regular }}>· v1</span>
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
          {entry.uploaded_by_name ? `Uploaded by ${entry.uploaded_by_name}` : 'Uploaded'}
        </p>
      </div>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Walk-in appointments table — per-visit row.
// ─────────────────────────────────────────────────────────────────────────────

function WalkInAppointments({
  visits,
  loading,
  isMobile,
}: {
  visits: PatientVisitRow[];
  loading: boolean;
  isMobile: boolean;
}) {
  const navigate = useNavigate();
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
            Walk-in appointments
          </h2>
        </div>
        <span
          style={{
            color: theme.color.inkMuted,
            fontSize: theme.type.size.sm,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {visits.length} {visits.length === 1 ? 'visit' : 'visits'}
        </span>
      </div>

      <div style={{ height: 1, background: theme.color.border, margin: `${theme.space[4]}px 0 ${theme.space[5]}px` }} />

      {loading ? (
        <Skeleton height={120} radius={14} />
      ) : visits.length === 0 ? (
        <EmptyState title="No visits yet" description="Walk-ins and arrivals will list here." />
      ) : isMobile ? (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
          {visits.map((v) => (
            <li key={v.id}>
              <VisitRowMobile visit={v} onClick={() => navigate(`/visit/${v.id}`)} />
            </li>
          ))}
        </ul>
      ) : (
        <VisitsTable visits={visits} onRowClick={(v) => navigate(`/visit/${v.id}`)} />
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
          {visit.service_label ?? 'Visit'}
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
