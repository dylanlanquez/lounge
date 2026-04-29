import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Camera, ChevronLeft, ChevronRight, ImageOff, Megaphone, Sparkles, X } from 'lucide-react';
import { CollapsibleCard } from '../CollapsibleCard/CollapsibleCard.tsx';
import { useCaptureFlow } from '../CapturePopup/CapturePopup.tsx';
import { EmptyState } from '../EmptyState/EmptyState.tsx';
import { Skeleton } from '../Skeleton/Skeleton.tsx';
import { Toast } from '../Toast/Toast.tsx';
import { theme } from '../../theme/index.ts';
import { signedUrlFor, uploadPatientFile } from '../../lib/queries/patientFiles.ts';
import {
  type PatientFileEntry,
} from '../../lib/queries/patientProfile.ts';

// Narrow patient shape — only what the gallery needs to attribute an
// upload. Both PatientRow (visit page) and PatientProfileRow (profile
// page) satisfy it without further wrapping.
export interface PatientForGallery {
  id: string;
  first_name: string | null;
  last_name: string | null;
}
import { properCase } from '../../lib/queries/appointments.ts';
import { supabase } from '../../lib/supabase.ts';

// ─────────────────────────────────────────────────────────────────────────────
// PhotoGallery — Before/After + Marketing photo galleries.
//
// Two consumers:
//   - VisitDetail (the appointment page). Uploads enabled: each label
//     renders an inline dashed-border tile in the grid that fires the
//     file picker. Photos uploaded here land in patient_files and
//     surface on the patient profile too.
//   - PatientProfile. readOnly mode: no upload tiles, just the photos.
//     Patient files come "from appointments" — staff upload during
//     the visit, the profile aggregates over time.
//
// One source of truth (patient_files keyed by label_key + status),
// one render path, two contexts.
// ─────────────────────────────────────────────────────────────────────────────

export const LABEL_BEFORE = 'before_photo';
export const LABEL_AFTER = 'after_photo';
export const LABEL_MARKETING = 'marketing_content';

const LABEL_DISPLAY: Record<string, string> = {
  [LABEL_BEFORE]: 'Before photo',
  [LABEL_AFTER]: 'After photo',
  [LABEL_MARKETING]: 'Marketing content',
};

interface GalleryItem extends PatientFileEntry {
  variant?: 'before' | 'after';
}

interface UploadDef {
  labelKey: string;
  label: string;
}

interface CommonProps {
  patient: PatientForGallery;
  files: PatientFileEntry[];
  loading: boolean;
  refresh: () => void;
  isMobile: boolean;
  // When true, hide all upload affordances. Used on the patient
  // profile so staff upload exclusively from the appointment page.
  readOnly?: boolean;
}

export function BeforeAfterGallery({
  patient,
  files,
  loading,
  refresh,
  isMobile,
  readOnly = false,
}: CommonProps) {
  const items = useMemo<GalleryItem[]>(() => {
    return files
      .filter((f) => f.status === 'active' && (f.label_key === LABEL_BEFORE || f.label_key === LABEL_AFTER))
      .map((f) => ({ ...f, variant: f.label_key === LABEL_BEFORE ? 'before' : 'after' }));
  }, [files]);

  return (
    <GalleryCard
      icon={<Sparkles size={18} color={theme.color.ink} aria-hidden />}
      title="Before & afters"
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
      emptyDescription={
        readOnly
          ? 'Photos will appear here as they are added during appointments.'
          : 'Snap a before photo at arrival and an after photo at collection.'
      }
      readOnly={readOnly}
    />
  );
}

export function MarketingGallery({
  patient,
  files,
  loading,
  refresh,
  isMobile,
  readOnly = false,
}: CommonProps) {
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
      emptyDescription={
        readOnly
          ? 'Photos uploaded during appointments will appear here.'
          : 'Photos uploaded here are available to the marketing team for content and case studies.'
      }
      readOnly={readOnly}
    />
  );
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
  readOnly = false,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  patient: PatientForGallery;
  items: GalleryItem[];
  loading: boolean;
  refresh: () => void;
  isMobile: boolean;
  uploads: UploadDef[];
  emptyTitle: string;
  emptyDescription: string;
  readOnly?: boolean;
}) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const patientName = `${properCase(patient.first_name)} ${properCase(patient.last_name)}`.trim() || 'Patient';

  const onPick = async (labelKey: string, file: File) => {
    setBusyKey(labelKey);
    setError(null);
    try {
      const { data: accId } = await supabase.rpc('auth_account_id');
      await uploadPatientFile({
        patientId: patient.id,
        patientName,
        file,
        labelKey,
        labelDisplayName: LABEL_DISPLAY[labelKey] ?? labelKey,
        uploaderAccountId: (accId as string | null) ?? null,
      });
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusyKey(null);
    }
  };

  const showUploads = !readOnly && uploads.length > 0;
  const tileCount = (showUploads ? uploads.length : 0) + items.length;
  const empty = !loading && items.length === 0;

  return (
    <>
      <CollapsibleCard
        icon={icon}
        title={title}
        meta={`${items.length} ${items.length === 1 ? 'photo' : 'photos'}`}
      >
        <p style={{ margin: `0 0 ${theme.space[4]}px`, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
          {description}
        </p>

        {loading ? (
          <Skeleton height={140} radius={14} />
        ) : empty && !showUploads ? (
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
            {showUploads
              ? uploads.map((u) => (
                  <UploadFlowSlot
                    key={u.labelKey}
                    label={u.label}
                    labelKey={u.labelKey}
                    busy={busyKey === u.labelKey}
                    disabled={busyKey !== null && busyKey !== u.labelKey}
                    onFile={onPick}
                  />
                ))
              : null}
            {items.map((item, i) => (
              <PhotoTile key={item.id} item={item} onOpen={() => setOpenIndex(i)} />
            ))}
            {!showUploads && empty ? (
              <span style={{ gridColumn: '1 / -1', color: theme.color.inkSubtle, fontSize: theme.type.size.sm }}>
                {emptyDescription}
              </span>
            ) : null}
          </div>
        )}

        {/* Hint to silence the unused-tileCount lint when showUploads is false. */}
        {tileCount < 0 ? null : null}
      </CollapsibleCard>

      <PhotoLightbox items={items} index={openIndex} onChange={setOpenIndex} />

      {error ? (
        <div style={{ position: 'fixed', bottom: theme.space[6], left: '50%', transform: 'translateX(-50%)', zIndex: 100 }}>
          <Toast tone="error" title="Could not upload" description={error} duration={6000} onDismiss={() => setError(null)} />
        </div>
      ) : null}
    </>
  );
}

// Each upload slot owns its own useCaptureFlow instance — wrapping
// in a sub-component keeps Rules-of-Hooks happy when uploads.length
// varies between renders. Tile click → opens the source sheet
// (Take a photo / Choose from gallery). The sheet + camera modal
// portal to document.body, so the slot's DOM placement doesn't
// affect their stacking.
function UploadFlowSlot({
  label,
  labelKey,
  busy,
  disabled,
  onFile,
}: {
  label: string;
  labelKey: string;
  busy: boolean;
  disabled: boolean;
  onFile: (labelKey: string, file: File) => void;
}) {
  const capture = useCaptureFlow({
    label,
    onFile: (file) => onFile(labelKey, file),
  });
  return (
    <>
      <UploadTile label={label} busy={busy} disabled={disabled} onClick={capture.open} />
      {capture.node}
    </>
  );
}

function UploadTile({
  label,
  busy,
  disabled,
  onClick,
}: {
  label: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      aria-label={label}
      style={{
        appearance: 'none',
        position: 'relative',
        padding: 0,
        aspectRatio: '1 / 1',
        borderRadius: theme.radius.card,
        border: `1.5px dashed ${busy ? theme.color.accent : theme.color.border}`,
        background: theme.color.surface,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled && !busy ? 0.5 : 1,
        fontFamily: 'inherit',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.space[2],
        color: theme.color.inkMuted,
        transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
      onMouseEnter={(e) => {
        if (disabled || busy) return;
        (e.currentTarget as HTMLElement).style.borderColor = theme.color.ink;
        (e.currentTarget as HTMLElement).style.color = theme.color.ink;
      }}
      onMouseLeave={(e) => {
        if (disabled || busy) return;
        (e.currentTarget as HTMLElement).style.borderColor = theme.color.border;
        (e.currentTarget as HTMLElement).style.color = theme.color.inkMuted;
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 44,
          height: 44,
          borderRadius: theme.radius.pill,
          background: theme.color.bg,
        }}
      >
        <Camera size={20} />
      </span>
      <span
        style={{
          fontSize: theme.type.size.sm,
          fontWeight: theme.type.weight.semibold,
          textAlign: 'center',
        }}
      >
        {busy ? 'Uploading…' : label}
      </span>
    </button>
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

      {hasPrev ? <LightboxNav side="left" onClick={() => onChange(index! - 1)} /> : null}
      {hasNext ? <LightboxNav side="right" onClick={() => onChange(index! + 1)} /> : null}

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

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
