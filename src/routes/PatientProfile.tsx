import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { Camera, ChevronLeft, ChevronRight, ImageOff, Layers, Megaphone, Pencil, Sparkles, X } from 'lucide-react';
import { Breadcrumb, Button, Card, EmptyState, Skeleton, StatusPill, Toast } from '../components/index.ts';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../components/KioskStatusBar/KioskStatusBar.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useIsMobile } from '../lib/useIsMobile.ts';
import { properCase } from '../lib/queries/appointments.ts';
import { signedUrlFor, uploadPatientFile } from '../lib/queries/patientFiles.ts';
import {
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
import { supabase } from '../lib/supabase.ts';

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
      <div style={{ maxWidth: 960, margin: '0 auto' }}>
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
            />
            <MarketingGallery
              patient={patient}
              files={files}
              loading={filesLoading}
              refresh={refreshFiles}
              isMobile={isMobile}
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
    { label: 'Address', value: p.address },
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
// Photo galleries — Before/After + Marketing content. Both are append-only:
// uploads land in the patient_files table tagged with a fixed label_key,
// rendered as a thumbnail grid, and tap-to-open in a fullscreen lightbox.
// No delete affordance anywhere — patient files are kept for the patient's
// lifetime and only an archive flag (set elsewhere) hides them. New label
// keys self-create on first upload via getOrCreateLabel.
// ─────────────────────────────────────────────────────────────────────────────

const LABEL_BEFORE = 'before_photo';
const LABEL_AFTER = 'after_photo';
const LABEL_MARKETING = 'marketing_content';
const LABEL_DISPLAY: Record<string, string> = {
  [LABEL_BEFORE]: 'Before photo',
  [LABEL_AFTER]: 'After photo',
  [LABEL_MARKETING]: 'Marketing content',
};

interface GalleryItem extends PatientFileEntry {
  variant?: 'before' | 'after';
}

function BeforeAfterGallery({
  patient,
  files,
  loading,
  refresh,
  isMobile,
}: {
  patient: PatientProfileRow;
  files: PatientFileEntry[];
  loading: boolean;
  refresh: () => void;
  isMobile: boolean;
}) {
  const items = useMemo<GalleryItem[]>(() => {
    return files
      .filter((f) => f.status === 'active' && (f.label_key === LABEL_BEFORE || f.label_key === LABEL_AFTER))
      .map((f) => ({ ...f, variant: f.label_key === LABEL_BEFORE ? 'before' : 'after' }));
  }, [files]);

  return (
    <GalleryCard
      icon={<Sparkles size={18} color={theme.color.ink} aria-hidden />}
      title="Before & after"
      description="Capture the transformation. Tap a photo to view full-size."
      patient={patient}
      items={items}
      loading={loading}
      refresh={refresh}
      isMobile={isMobile}
      uploads={[
        { labelKey: LABEL_BEFORE, label: 'Add before' },
        { labelKey: LABEL_AFTER, label: 'Add after' },
      ]}
      emptyTitle="No before/after photos yet"
      emptyDescription="Snap a before photo at arrival and an after photo at collection."
    />
  );
}

function MarketingGallery({
  patient,
  files,
  loading,
  refresh,
  isMobile,
}: {
  patient: PatientProfileRow;
  files: PatientFileEntry[];
  loading: boolean;
  refresh: () => void;
  isMobile: boolean;
}) {
  const items = useMemo<GalleryItem[]>(
    () => files.filter((f) => f.status === 'active' && f.label_key === LABEL_MARKETING),
    [files]
  );

  return (
    <GalleryCard
      icon={<Megaphone size={18} color={theme.color.ink} aria-hidden />}
      title="Marketing content"
      description="Photos with the finished appliance, branded bag, and patient (when consented). Used by the marketing team."
      patient={patient}
      items={items}
      loading={loading}
      refresh={refresh}
      isMobile={isMobile}
      uploads={[{ labelKey: LABEL_MARKETING, label: 'Add photo' }]}
      emptyTitle="No marketing content yet"
      emptyDescription="Photos uploaded here are available to the marketing team for content and case studies."
    />
  );
}

interface UploadDef {
  labelKey: string;
  label: string;
}

function GalleryCard({
  icon,
  title,
  description,
  patient,
  items,
  loading,
  refresh,
  isMobile,
  uploads,
  emptyTitle,
  emptyDescription,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  patient: PatientProfileRow;
  items: GalleryItem[];
  loading: boolean;
  refresh: () => void;
  isMobile: boolean;
  uploads: UploadDef[];
  emptyTitle: string;
  emptyDescription: string;
}) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const patientName = `${properCase(patient.first_name)} ${properCase(patient.last_name)}`.trim() || 'Patient';

  const onPick = async (labelKey: string, fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setBusyKey(labelKey);
    setError(null);
    try {
      const { data: accId } = await supabase.rpc('auth_account_id');
      for (const file of Array.from(fileList)) {
        await uploadPatientFile({
          patientId: patient.id,
          patientName,
          file,
          labelKey,
          labelDisplayName: LABEL_DISPLAY[labelKey] ?? labelKey,
          uploaderAccountId: (accId as string | null) ?? null,
        });
      }
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <Card padding="lg">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: theme.space[3], flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2] }}>
          {icon}
          <h2
            style={{
              margin: 0,
              fontSize: theme.type.size.lg,
              fontWeight: theme.type.weight.semibold,
              letterSpacing: theme.type.tracking.tight,
              color: theme.color.ink,
            }}
          >
            {title}
          </h2>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], flexWrap: 'wrap' }}>
          <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
            {items.length} {items.length === 1 ? 'photo' : 'photos'}
          </span>
          {uploads.map((u) => (
            <span key={u.labelKey} style={{ display: 'inline-flex' }}>
              <input
                ref={(el) => {
                  inputs.current[u.labelKey] = el;
                }}
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                onChange={(e) => onPick(u.labelKey, e.target.files)}
                style={{ display: 'none' }}
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => inputs.current[u.labelKey]?.click()}
                loading={busyKey === u.labelKey}
                disabled={busyKey !== null && busyKey !== u.labelKey}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <Camera size={14} /> {u.label}
                </span>
              </Button>
            </span>
          ))}
        </div>
      </div>
      <p style={{ margin: `${theme.space[2]}px 0 0`, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
        {description}
      </p>

      <div style={{ height: 1, background: theme.color.border, margin: `${theme.space[4]}px 0 ${theme.space[5]}px` }} />

      {loading ? (
        <Skeleton height={140} radius={14} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Camera size={20} />}
          title={emptyTitle}
          description={emptyDescription}
        />
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: isMobile ? 'repeat(2, minmax(0, 1fr))' : 'repeat(4, minmax(0, 1fr))',
            gap: theme.space[3],
          }}
        >
          {items.map((item, i) => (
            <PhotoTile key={item.id} item={item} onOpen={() => setOpenIndex(i)} />
          ))}
        </div>
      )}

      <PhotoLightbox
        items={items}
        index={openIndex}
        onChange={setOpenIndex}
      />

      {error ? (
        <div style={{ position: 'fixed', bottom: theme.space[6], left: '50%', transform: 'translateX(-50%)', zIndex: 100 }}>
          <Toast tone="error" title="Could not upload" description={error} duration={6000} onDismiss={() => setError(null)} />
        </div>
      ) : null}
    </Card>
  );
}

function PhotoTile({ item, onOpen }: { item: GalleryItem; onOpen: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setFailed(false);
    (async () => {
      const signed = await signedUrlFor(item.file_url, 300);
      if (cancelled) return;
      if (!signed) {
        setFailed(true);
        return;
      }
      setUrl(signed);
    })();
    return () => {
      cancelled = true;
    };
  }, [item.file_url]);

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open photo, uploaded ${formatDateTime(item.uploaded_at)}`}
      style={{
        appearance: 'none',
        position: 'relative',
        padding: 0,
        aspectRatio: '1 / 1',
        borderRadius: theme.radius.card,
        border: `1px solid ${theme.color.border}`,
        background: theme.color.bg,
        cursor: 'pointer',
        overflow: 'hidden',
        fontFamily: 'inherit',
      }}
    >
      {url ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          onError={() => setFailed(true)}
        />
      ) : failed ? (
        <span
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: theme.color.inkSubtle,
          }}
        >
          <ImageOff size={28} aria-hidden />
        </span>
      ) : (
        <Skeleton height="100%" radius={0} />
      )}
      {item.variant ? <VariantChip variant={item.variant} /> : null}
    </button>
  );
}

function VariantChip({ variant }: { variant: 'before' | 'after' }) {
  const isAfter = variant === 'after';
  return (
    <span
      style={{
        position: 'absolute',
        top: theme.space[2],
        left: theme.space[2],
        padding: '3px 8px',
        borderRadius: theme.radius.pill,
        fontSize: 10,
        fontWeight: theme.type.weight.semibold,
        textTransform: 'uppercase',
        letterSpacing: theme.type.tracking.wide,
        background: isAfter ? '#0E1414' : 'rgba(255, 255, 255, 0.92)',
        color: isAfter ? '#fff' : theme.color.ink,
        boxShadow: theme.shadow.card,
      }}
    >
      {isAfter ? 'After' : 'Before'}
    </span>
  );
}

function PhotoLightbox({
  items,
  index,
  onChange,
}: {
  items: GalleryItem[];
  index: number | null;
  onChange: (i: number | null) => void;
}) {
  const open = index !== null;
  const current = open ? items[index!] ?? null : null;
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!current) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const signed = await signedUrlFor(current.file_url, 300);
      if (cancelled) return;
      setUrl(signed);
    })();
    return () => {
      cancelled = true;
    };
  }, [current]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onChange(null);
      if (e.key === 'ArrowLeft' && index! > 0) onChange(index! - 1);
      if (e.key === 'ArrowRight' && index! < items.length - 1) onChange(index! + 1);
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, index, items.length, onChange]);

  if (!open || !current) return null;

  const hasPrev = index! > 0;
  const hasNext = index! < items.length - 1;

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={() => onChange(null)}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0, 0, 0, 0.92)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: theme.space[5],
      }}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onChange(null);
        }}
        aria-label="Close"
        style={{
          position: 'absolute',
          top: theme.space[5],
          right: theme.space[5],
          width: 40,
          height: 40,
          borderRadius: '50%',
          border: 'none',
          background: 'rgba(255, 255, 255, 0.12)',
          color: '#fff',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <X size={20} />
      </button>

      {hasPrev ? (
        <LightboxNav side="left" onClick={() => onChange(index! - 1)} />
      ) : null}
      {hasNext ? (
        <LightboxNav side="right" onClick={() => onChange(index! + 1)} />
      ) : null}

      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '92vw',
          maxHeight: '88vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: theme.space[3],
        }}
      >
        {url ? (
          <img
            src={url}
            alt=""
            style={{
              maxWidth: '92vw',
              maxHeight: '78vh',
              objectFit: 'contain',
              borderRadius: theme.radius.card,
              boxShadow: '0 20px 60px rgba(0, 0, 0, 0.5)',
            }}
          />
        ) : (
          <Skeleton width={400} height={400} radius={theme.radius.card} />
        )}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: theme.space[2],
            color: 'rgba(255, 255, 255, 0.85)',
            fontSize: theme.type.size.sm,
          }}
        >
          {current.variant ? (
            <span
              style={{
                padding: '2px 8px',
                borderRadius: theme.radius.pill,
                fontSize: 10,
                fontWeight: theme.type.weight.semibold,
                textTransform: 'uppercase',
                letterSpacing: theme.type.tracking.wide,
                background: current.variant === 'after' ? '#fff' : 'rgba(255, 255, 255, 0.18)',
                color: current.variant === 'after' ? '#0E1414' : '#fff',
              }}
            >
              {current.variant === 'after' ? 'After' : 'Before'}
            </span>
          ) : null}
          <span>{formatDateTime(current.uploaded_at)}</span>
          {current.uploaded_by_name ? <span>· {current.uploaded_by_name}</span> : null}
          <span>·</span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            {index! + 1} of {items.length}
          </span>
        </div>
      </div>
    </div>
  );
}

function LightboxNav({ side, onClick }: { side: 'left' | 'right'; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-label={side === 'left' ? 'Previous photo' : 'Next photo'}
      style={{
        position: 'absolute',
        top: '50%',
        [side]: theme.space[5],
        transform: 'translateY(-50%)',
        width: 48,
        height: 48,
        borderRadius: '50%',
        border: 'none',
        background: 'rgba(255, 255, 255, 0.12)',
        color: '#fff',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {side === 'left' ? <ChevronLeft size={24} /> : <ChevronRight size={24} />}
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
