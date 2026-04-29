import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, FileText, Loader2, Pin, RotateCcw, X } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { signedUrlFor, uploadPatientFile } from '../../lib/queries/patientFiles.ts';
import { supabase } from '../../lib/supabase.ts';
import type { PatientFileEntry, PatientProfileRow } from '../../lib/queries/patientProfile.ts';
import { Preview3DModal } from './Preview3DModal.tsx';

// ─────────────────────────────────────────────────────────────────────────────
// PatientFilesGrid — view-only port of Meridian's PatientProfileFiles
// card grid for Lounge tablets.
//
// Visual mirrors Meridian: horizontal-scrolling row of 176x200 cards,
// 116px thumbnail zone with status / label info + a footer that names
// the slot ("Upper Arch · v2") plus an "→ View history (N)" affordance
// when the slot has more than one upload. Eight fixed slots (the same
// list Meridian's FileSlot.jsx exports) plus a card per "other" label
// or named custom upload.
//
// Stripped of every action that doesn't match the kiosk model: no
// upload, no download, no flag, no pin, no accept / reject. Click a
// filled card → preview modal. Click "View history" → version list
// modal. Empty slot is non-interactive (no plus icon).
// ─────────────────────────────────────────────────────────────────────────────

interface SlotDef {
  group: string;
  label: string;
  subLabelKeys: string[];
  // The four photo slots are uploadable from Lounge — staff can take
  // or pick a photo on the kiosk and the row writes a fresh
  // patient_files row at the slot's primary label_key. The lab-derived
  // slots (arch scans, bite, x-ray) stay view-only; those uploads
  // happen via Meridian / scanner equipment.
  uploadable?: boolean;
  // Primary label_key used when uploading from Lounge.
  primaryKey: string;
}

const SLOT_DEFS: SlotDef[] = [
  // Photo slots first — these are the ones receptionists can capture
  // at the desk, so they're the ones a receptionist is most likely to
  // act on, and putting them at the front of the row matches the
  // tap-to-add order Dylan wants.
  { group: 'full_face_photo', label: 'Full Face Photo', subLabelKeys: ['full_face_photo'], primaryKey: 'full_face_photo', uploadable: true },
  { group: 'smile_photo_front', label: 'Smile Photo — Front', subLabelKeys: ['smile_photo_front'], primaryKey: 'smile_photo_front', uploadable: true },
  { group: 'smile_photo_left', label: 'Smile Photo — Left', subLabelKeys: ['smile_photo_left'], primaryKey: 'smile_photo_left', uploadable: true },
  { group: 'smile_photo_right', label: 'Smile Photo — Right', subLabelKeys: ['smile_photo_right'], primaryKey: 'smile_photo_right', uploadable: true },
  // Lab-derived slots after.
  { group: 'upper_arch', label: 'Upper Arch', subLabelKeys: ['upper_arch', 'upper_arch_opposing'], primaryKey: 'upper_arch' },
  { group: 'lower_arch', label: 'Lower Arch', subLabelKeys: ['lower_arch', 'lower_arch_opposing'], primaryKey: 'lower_arch' },
  { group: 'bite_registration', label: 'Bite Registration', subLabelKeys: ['bite_registration', 'both_arches'], primaryKey: 'bite_registration' },
  { group: 'xray', label: 'X-Ray', subLabelKeys: ['xray_panoramic', 'xray_periapical', 'reference_previous_work', 'patient_reference_image'], primaryKey: 'xray_panoramic' },
];

// SLOT_DEF subLabelKeys → group lookup, used by buildCards to bucket a
// file into the right fixed slot.
const LABEL_TO_GROUP: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const def of SLOT_DEFS) {
    for (const k of def.subLabelKeys) m[k] = def.group;
  }
  return m;
})();

interface FileCardModel {
  group: string;
  label: string;
  // The file shown on the card face. Null for empty slots.
  file: PatientFileEntry | null;
  // Total number of versions for this slot (counts every file mapped to
  // the slot's labels, not just the visible one).
  versionCount: number;
  // Every version, newest first. Powers the History modal.
  versions: PatientFileEntry[];
  // Set on slots staff can fill from the kiosk (the four photo slots).
  // Drives the empty-card upload affordance + click handler. Includes
  // the canonical primary label_key so the upload writes to the right
  // bucket.
  uploadable?: { primaryKey: string };
}

function buildCards(files: PatientFileEntry[]): FileCardModel[] {
  // Group every file by slot group via its label_key. Files whose label
  // doesn't map to a fixed slot end up in dynamic 'other_*' groups.
  const byGroup = new Map<string, PatientFileEntry[]>();
  const labelDisplayByGroup = new Map<string, string>();

  for (const f of files) {
    const labelKey = f.label_key ?? '';
    let group = LABEL_TO_GROUP[labelKey];
    let label = f.label_display ?? f.custom_label ?? 'Other';

    if (!group) {
      const customSlug = (f.custom_label ?? '').trim().toLowerCase();
      group = `other_${labelKey || 'unlabelled'}_${customSlug}`;
      label = (f.custom_label && f.custom_label.trim()) || f.label_display || 'Other';
    } else {
      const def = SLOT_DEFS.find((d) => d.group === group)!;
      label = def.label;
    }
    labelDisplayByGroup.set(group, label);
    const list = byGroup.get(group) ?? [];
    list.push(f);
    byGroup.set(group, list);
  }

  for (const list of byGroup.values()) {
    list.sort((a, b) => {
      const av = a.version ?? 0;
      const bv = b.version ?? 0;
      if (bv !== av) return bv - av;
      return b.uploaded_at.localeCompare(a.uploaded_at);
    });
  }

  // Build cards in two passes so we can render filled ones first
  // (sorted by latest upload, regardless of slot type) and tuck empty
  // ones at the tail in canonical slot order. The receptionist's eye
  // lands on what's actually on file before the placeholders.
  const filled: FileCardModel[] = [];
  const empty: FileCardModel[] = [];

  for (const def of SLOT_DEFS) {
    const versions = byGroup.get(def.group) ?? [];
    const card: FileCardModel = {
      group: def.group,
      label: def.label,
      file: versions[0] ?? null,
      versionCount: versions.length,
      versions,
      uploadable: def.uploadable ? { primaryKey: def.primaryKey } : undefined,
    };
    if (versions.length > 0) filled.push(card);
    else empty.push(card);
  }

  for (const [group, versions] of byGroup.entries()) {
    if (SLOT_DEFS.some((d) => d.group === group)) continue;
    if (versions.length === 0) continue;
    filled.push({
      group,
      label: labelDisplayByGroup.get(group) ?? 'Other',
      file: versions[0]!,
      versionCount: versions.length,
      versions,
    });
  }

  filled.sort((a, b) =>
    (b.file?.uploaded_at ?? '').localeCompare(a.file?.uploaded_at ?? '')
  );

  return [...filled, ...empty];
}

// Empty slot cards all share the same generic file icon. Earlier we
// rendered a different glyph per slot (arch, bite, camera, xray, etc.)
// but Dylan asked for a single consistent file icon across every empty
// state, so the per-kind SlotIcon got dropped.

// ─── Signed URL hook + thumbnail ────────────────────────────────────────────

function useSignedUrl(path: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!path) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    void signedUrlFor(path, 600).then((u) => {
      if (!cancelled) setUrl(u);
    });
    return () => {
      cancelled = true;
    };
  }, [path]);
  return url;
}

function thumbnailPathFor(file: PatientFileEntry): string | null {
  if (file.thumbnail_path) return file.thumbnail_path;
  if (file.mime_type?.startsWith('image/')) return file.file_url;
  return null;
}

function FileThumb({ file, full = false }: { file: PatientFileEntry; full?: boolean }) {
  const path = thumbnailPathFor(file);
  const url = useSignedUrl(path);
  const fallback = (
    <span
      aria-hidden
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        height: '100%',
        color: theme.color.inkSubtle,
      }}
    >
      <FileText size={full ? 28 : 22} />
    </span>
  );
  if (!url) return fallback;
  return (
    <img
      src={url}
      alt={file.file_name}
      style={{
        width: '100%',
        height: '100%',
        objectFit: full ? 'contain' : 'cover',
        display: 'block',
      }}
    />
  );
}

// ─── Card ───────────────────────────────────────────────────────────────────

const CARD_W = 176;
const CARD_H = 200;
const THUMB_H = 116;

function FileCard({
  card,
  uploading,
  onPreview,
  onHistory,
  onUpload,
}: {
  card: FileCardModel;
  uploading: boolean;
  onPreview: (file: PatientFileEntry) => void;
  onHistory: (card: FileCardModel) => void;
  onUpload: (card: FileCardModel, file: File) => void;
}) {
  const [hover, setHover] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  if (!card.file) {
    const canUpload = !!card.uploadable && !uploading;
    return (
      <div
        onClick={() => {
          if (canUpload) inputRef.current?.click();
        }}
        onMouseEnter={() => canUpload && setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          width: CARD_W,
          height: CARD_H,
          flexShrink: 0,
          scrollSnapAlign: 'start',
          borderRadius: 16,
          border: `2px dashed ${hover ? theme.color.ink : theme.color.border}`,
          background: theme.color.bg,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          padding: '10px 12px',
          boxSizing: 'border-box',
          opacity: uploading ? 0.85 : canUpload ? (hover ? 0.9 : 0.7) : 0.55,
          color: theme.color.inkSubtle,
          cursor: canUpload ? 'pointer' : 'default',
          transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, opacity ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
          position: 'relative',
        }}
      >
        {uploading ? (
          <Loader2
            size={22}
            color={theme.color.accent}
            aria-hidden
            style={{ animation: 'lng-files-spin 1s linear infinite' }}
          />
        ) : (
          <FileText size={26} aria-hidden />
        )}
        <span
          style={{
            fontSize: 12,
            fontWeight: theme.type.weight.medium,
            color: theme.color.inkMuted,
            textAlign: 'center',
            lineHeight: 1.3,
          }}
        >
          {card.label}
        </span>
        <span
          style={{
            fontSize: 10,
            color: theme.color.inkSubtle,
            textAlign: 'center',
            lineHeight: 1.35,
            padding: '0 4px',
          }}
        >
          {uploading
            ? 'Uploading…'
            : canUpload
              ? 'Tap to take or upload a photo'
              : 'Add in Meridian'}
        </span>
        {card.uploadable ? (
          <input
            ref={inputRef}
            type="file"
            // accept image/* without `capture`: Samsung Chrome offers
            // both Camera and Files in the chooser, which is the UX
            // Dylan asked for ('camera roll or take photo').
            accept="image/*"
            style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              // Reset the value so the same file picked twice still
              // fires onChange the second time.
              e.target.value = '';
              if (f) onUpload(card, f);
            }}
          />
        ) : null}
        <style>{`@keyframes lng-files-spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  const file = card.file;
  return (
    <div
      onClick={() => onPreview(file)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: CARD_W,
        height: CARD_H,
        flexShrink: 0,
        scrollSnapAlign: 'start',
        borderRadius: 16,
        background: theme.color.surface,
        overflow: 'hidden',
        border: `1px solid ${theme.color.border}`,
        boxShadow: hover
          ? '0 1px 6px rgba(14, 20, 20, 0.10), 0 2px 8px rgba(14, 20, 20, 0.06)'
          : 'none',
        transition: `box-shadow ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        cursor: 'pointer',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          width: '100%',
          height: THUMB_H,
          background: theme.color.bg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        <FileThumb file={file} />
      </div>
      <div
        style={{
          padding: '12px 14px 14px',
          borderTop: `1px solid ${theme.color.border}`,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          flex: 1,
        }}
      >
        <div
          style={{
            fontSize: 13,
            fontWeight: theme.type.weight.medium,
            color: theme.color.ink,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {card.label}
          {file.version != null ? (
            <span style={{ color: theme.color.inkSubtle, fontWeight: theme.type.weight.regular }}>
              <span aria-hidden style={{ margin: '0 4px', color: theme.color.inkSubtle }}>
                ·
              </span>
              v{file.version}
            </span>
          ) : null}
        </div>
        <div
          style={{
            fontSize: 11,
            color: theme.color.inkMuted,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {file.uploaded_by_name
            ? `Uploaded by ${file.uploaded_by_name}`
            : `${(file.mime_type?.split('/')[1] || 'file').toUpperCase()}${
                file.file_size_bytes ? ` · ${formatBytes(file.file_size_bytes)}` : ''
              }`}
        </div>
        {card.versionCount > 1 ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onHistory(card);
            }}
            // Hover behaviour mirrors Meridian's FileCardRow link:
            // arrow nudges right, label underlines. Receptionists
            // already recognise the affordance from there.
            onMouseEnter={(e) => {
              const root = e.currentTarget;
              (root.querySelector('[data-arrow]') as HTMLElement | null)?.style.setProperty(
                'transform',
                'translateX(3px)'
              );
              (root.querySelector('[data-label]') as HTMLElement | null)?.style.setProperty(
                'text-decoration',
                'underline'
              );
            }}
            onMouseLeave={(e) => {
              const root = e.currentTarget;
              (root.querySelector('[data-arrow]') as HTMLElement | null)?.style.setProperty(
                'transform',
                'translateX(0)'
              );
              (root.querySelector('[data-label]') as HTMLElement | null)?.style.setProperty(
                'text-decoration',
                'none'
              );
            }}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              margin: '4px 0 0',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 11,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              alignSelf: 'flex-start',
              textAlign: 'left',
            }}
          >
            <span
              data-arrow
              aria-hidden
              style={{
                fontSize: 13,
                lineHeight: 1,
                transition: `transform ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
              }}
            >
              →
            </span>
            <span data-label style={{ textDecorationThickness: '1px', textUnderlineOffset: '2px' }}>
              View history ({card.versionCount})
            </span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ─── Preview modal ──────────────────────────────────────────────────────────

const MODEL_EXTS = new Set(['stl', 'obj', 'ply']);

function modelExt(filename: string): 'stl' | 'obj' | 'ply' | null {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return MODEL_EXTS.has(ext) ? (ext as 'stl' | 'obj' | 'ply') : null;
}

export function PreviewModal({
  file,
  onClose,
  patient,
}: {
  file: PatientFileEntry;
  onClose: () => void;
  patient?: PatientProfileRow | null;
}) {
  // Resolve a long-TTL signed URL for the full file. Images render
  // inline; PDFs in an iframe; STL / OBJ / PLY route to the dedicated
  // Preview3DModal (fullscreen viewer with progress card + side
  // panels). Anything else falls back to a 'preview not available'
  // message in this simple modal.
  const url = useSignedUrl(file.file_url);
  const isImage = !!file.mime_type?.startsWith('image/');
  const isPdf = file.mime_type === 'application/pdf';
  const ext3d = modelExt(file.file_name);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 3D files render in their own popup viewer (Preview3DModal). While
  // the signed URL is still resolving we render the same outer popup
  // shell so the user doesn't see a fullscreen black flash before the
  // sized popup appears. The shell hands `null` for fileUrl, which
  // Preview3DModal interprets as 'still loading'.
  if (ext3d) {
    return (
      <Preview3DModal
        file={file}
        ext={ext3d}
        fileUrl={url}
        patient={patient ?? null}
        onClose={onClose}
      />
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={file.file_name}
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: theme.color.overlay,
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: theme.space[6],
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: theme.color.surface,
          borderRadius: theme.radius.card,
          maxWidth: 'min(960px, 100%)',
          maxHeight: '100%',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: theme.shadow.overlay,
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: theme.space[3],
            padding: `${theme.space[3]}px ${theme.space[4]}px`,
            borderBottom: `1px solid ${theme.color.border}`,
          }}
        >
          <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span
              style={{
                fontSize: theme.type.size.base,
                fontWeight: theme.type.weight.semibold,
                color: theme.color.ink,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {file.file_name}
            </span>
            <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
              v{file.version ?? 1}
              {file.uploaded_by_name ? ` · ${file.uploaded_by_name}` : ''}
              {file.file_size_bytes ? ` · ${formatBytes(file.file_size_bytes)}` : ''}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            style={{
              appearance: 'none',
              border: 'none',
              background: 'transparent',
              padding: theme.space[2],
              borderRadius: theme.radius.pill,
              cursor: 'pointer',
              color: theme.color.inkMuted,
              display: 'inline-flex',
            }}
          >
            <X size={20} />
          </button>
        </header>
        <div
          style={{
            flex: 1,
            background: theme.color.bg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: 320,
            overflow: 'hidden',
          }}
        >
          {!url ? (
            <span style={{ color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>Loading…</span>
          ) : isImage ? (
            <img
              src={url}
              alt={file.file_name}
              style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain' }}
            />
          ) : isPdf ? (
            <iframe
              title={file.file_name}
              src={url}
              style={{ width: '100%', height: '70vh', border: 'none', background: theme.color.surface }}
            />
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: theme.space[2],
                color: theme.color.inkMuted,
                padding: theme.space[6],
                textAlign: 'center',
              }}
            >
              <FileText size={48} aria-hidden />
              <span style={{ fontSize: theme.type.size.sm }}>
                Preview not available for this file type.
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Version history modal ─────────────────────────────────────────────────

function VersionHistoryModal({
  card,
  onClose,
  onPreview,
}: {
  card: FileCardModel;
  onClose: () => void;
  onPreview: (file: PatientFileEntry) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // The latest version (top of card.versions, ordered desc on insert)
  // is the auto-main when the slot has no explicit pin record. Match
  // Meridian's amber-border + 'Main' pill so the receptionist's eye
  // lands on the live version first.
  const mainId = card.versions[0]?.id ?? null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${card.label} version history`}
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: theme.color.overlay,
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: theme.color.surface,
          borderRadius: 14,
          padding: '24px 26px 0',
          width: 'min(720px, 100%)',
          maxHeight: 'min(86vh, 720px)',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          boxShadow: theme.shadow.overlay,
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close version history"
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            appearance: 'none',
            border: 'none',
            background: 'transparent',
            padding: theme.space[2],
            borderRadius: theme.radius.pill,
            cursor: 'pointer',
            color: theme.color.inkMuted,
            display: 'inline-flex',
            zIndex: 1,
          }}
        >
          <X size={20} />
        </button>
        <header style={{ paddingRight: 44, display: 'flex', alignItems: 'center', gap: theme.space[2] }}>
          <span
            aria-hidden
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              background: theme.color.bg,
              border: `1px solid ${theme.color.border}`,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: theme.color.ink,
              flexShrink: 0,
            }}
          >
            <RotateCcw size={14} />
          </span>
          <h2
            style={{
              margin: 0,
              fontSize: theme.type.size.lg,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              letterSpacing: theme.type.tracking.tight,
            }}
          >
            {card.label}{' '}
            <span style={{ color: theme.color.inkMuted, fontWeight: theme.type.weight.medium }}>
              · {card.versionCount} {card.versionCount === 1 ? 'file' : 'files'}
            </span>
          </h2>
        </header>
        <ul
          role="list"
          style={{
            overflowY: 'auto',
            overflowX: 'hidden',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
            gridAutoRows: 'min-content',
            gap: 12,
            margin: 0,
            padding: '4px 4px 24px',
            listStyle: 'none',
            alignContent: 'start',
            maxHeight: 520,
          }}
        >
          {card.versions.map((v) => (
            <VersionCard
              key={v.id}
              file={v}
              isMain={v.id === mainId && card.versions.length > 1}
              onPreview={() => onPreview(v)}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

function VersionCard({
  file,
  isMain,
  onPreview,
}: {
  file: PatientFileEntry;
  isMain: boolean;
  onPreview: () => void;
}) {
  const [hover, setHover] = useState(false);
  const amber = '#f59e0b';
  return (
    <li
      role="listitem"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onPreview}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        border: `1px solid ${isMain ? amber : theme.color.border}`,
        borderRadius: 12,
        background: theme.color.surface,
        overflow: 'hidden',
        cursor: 'pointer',
        transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, box-shadow ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        boxShadow: isMain
          ? hover
            ? `0 0 0 1px ${amber}, 0 4px 16px -6px rgba(245,158,11,0.35)`
            : `0 0 0 1px ${amber}`
          : hover
            ? '0 4px 16px -6px rgba(14, 20, 20, 0.18)'
            : 'none',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: '100%',
          aspectRatio: '4 / 3',
          background: theme.color.bg,
          overflow: 'hidden',
        }}
      >
        <FileThumb file={file} />
        {isMain ? (
          <div
            style={{
              position: 'absolute',
              bottom: 8,
              left: 8,
              zIndex: 2,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '4px 8px',
              borderRadius: 999,
              background: 'rgba(245,158,11,0.95)',
              color: '#fff',
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: '0.02em',
              boxShadow: '0 2px 6px rgba(14, 20, 20, 0.18)',
            }}
          >
            <Pin size={10} aria-hidden /> Main
          </div>
        ) : null}
      </div>
      <div
        style={{
          padding: '10px 12px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          borderTop: `1px solid ${theme.color.border}`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span
            title={file.file_name}
            style={{
              fontSize: 12.5,
              fontWeight: theme.type.weight.medium,
              color: theme.color.ink,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            }}
          >
            {file.file_name}
          </span>
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 600,
              color: isMain ? '#92400e' : theme.color.accent,
              background: isMain ? 'rgba(245,158,11,0.15)' : theme.color.accentBg,
              padding: '2px 7px',
              borderRadius: 999,
              flexShrink: 0,
              letterSpacing: '0.02em',
            }}
          >
            v{file.version ?? 1}
          </span>
        </div>
        {file.uploaded_by_name ? (
          <div style={{ fontSize: 11, color: theme.color.inkMuted }}>
            Uploaded by {file.uploaded_by_name}
          </div>
        ) : null}
        <div style={{ fontSize: 11, color: theme.color.inkMuted }}>
          {formatLongDateTime(file.uploaded_at)}
        </div>
        {file.file_size_bytes ? (
          <div style={{ fontSize: 11, color: theme.color.inkMuted }}>
            {formatBytes(file.file_size_bytes)}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function formatLongDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${date} at ${time}`;
}

// ─── Public surface ─────────────────────────────────────────────────────────

export function PatientFilesGrid({
  files,
  loading,
  patientId,
  patientName,
  patient,
  onUploaded,
}: {
  files: PatientFileEntry[];
  loading: boolean;
  patientId: string;
  patientName: string;
  patient?: PatientProfileRow | null;
  onUploaded: () => void;
}) {
  const cards = useMemo(() => buildCards(files), [files]);
  const [previewFile, setPreviewFile] = useState<PatientFileEntry | null>(null);
  const [historyCard, setHistoryCard] = useState<FileCardModel | null>(null);
  const [uploading, setUploading] = useState<Set<string>>(() => new Set());
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const accountId = useAccountId();

  const handleUpload = async (card: FileCardModel, file: File) => {
    if (!card.uploadable) return;
    setUploading((s) => {
      const n = new Set(s);
      n.add(card.group);
      return n;
    });
    setErrorMsg(null);
    try {
      await uploadPatientFile({
        patientId,
        patientName,
        file,
        labelKey: card.uploadable.primaryKey,
        labelDisplayName: card.label,
        uploaderAccountId: accountId,
      });
      onUploaded();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading((s) => {
        const n = new Set(s);
        n.delete(card.group);
        return n;
      });
    }
  };

  return (
    <>
      <div style={{ position: 'relative' }}>
        {loading ? (
          <div style={{ display: 'flex', gap: 12 }}>
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                style={{
                  width: CARD_W,
                  height: CARD_H,
                  borderRadius: 16,
                  background: theme.color.bg,
                  flexShrink: 0,
                }}
              />
            ))}
          </div>
        ) : (
          <ScrollRow>
            {cards.map((c) => (
              <FileCard
                key={c.group}
                card={c}
                uploading={uploading.has(c.group)}
                onPreview={setPreviewFile}
                onHistory={setHistoryCard}
                onUpload={handleUpload}
              />
            ))}
          </ScrollRow>
        )}
      </div>

      {errorMsg ? (
        <p style={{ margin: `${theme.space[2]}px 0 0`, color: theme.color.alert, fontSize: theme.type.size.sm }}>
          {errorMsg}
        </p>
      ) : null}

      {previewFile ? (
        <PreviewModal
          file={previewFile}
          patient={patient ?? null}
          onClose={() => setPreviewFile(null)}
        />
      ) : null}
      {historyCard ? (
        <VersionHistoryModal
          card={historyCard}
          onClose={() => setHistoryCard(null)}
          onPreview={(f) => {
            setHistoryCard(null);
            setPreviewFile(f);
          }}
        />
      ) : null}
    </>
  );
}

// Resolve the signed-in user's accounts.id once via auth_account_id().
// Required for stamping the uploader on each new patient_files row;
// auth.uid() and accounts.id are not the same value (see waiver.ts
// for the same lookup).
function useAccountId(): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void supabase.rpc('auth_account_id').then(({ data }) => {
      if (cancelled) return;
      setId((data as string | null) ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return id;
}

function ScrollRow({ children }: { children: React.ReactNode }) {
  // Same horizontal-scroll container Meridian uses, but with Lounge
  // chevron buttons at the edges so receptionists on a kiosk without a
  // trackpad can step through the cards by tap. Buttons hide
  // automatically when the row isn't scrollable.
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(false);

  useEffect(() => {
    if (!el) return;
    const update = () => {
      setCanPrev(el.scrollLeft > 0);
      setCanNext(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [el]);

  const scrollBy = (dir: -1 | 1) => {
    if (!el) return;
    el.scrollBy({ left: dir * (CARD_W + 12) * 2, behavior: 'smooth' });
  };

  return (
    <div style={{ position: 'relative' }}>
      <div
        ref={setEl}
        style={{
          display: 'flex',
          gap: 12,
          overflowX: 'auto',
          padding: '12px 0 16px',
          scrollSnapType: 'x mandatory',
          WebkitOverflowScrolling: 'touch',
          scrollBehavior: 'smooth',
        }}
      >
        {children}
      </div>
      <ScrollButton side="left" disabled={!canPrev} onClick={() => scrollBy(-1)} />
      <ScrollButton side="right" disabled={!canNext} onClick={() => scrollBy(1)} />
    </div>
  );
}

function ScrollButton({
  side,
  disabled,
  onClick,
}: {
  side: 'left' | 'right';
  disabled: boolean;
  onClick: () => void;
}) {
  const base: CSSProperties = {
    position: 'absolute',
    top: '50%',
    transform: 'translateY(-50%)',
    width: 36,
    height: 36,
    borderRadius: '50%',
    border: `1px solid ${theme.color.border}`,
    background: theme.color.surface,
    boxShadow: theme.shadow.card,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0 : 1,
    pointerEvents: disabled ? 'none' : 'auto',
    transition: `opacity ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: theme.color.ink,
    zIndex: 2,
  };
  return (
    <button
      type="button"
      aria-label={side === 'left' ? 'Scroll left' : 'Scroll right'}
      onClick={onClick}
      style={{ ...base, [side]: -8 }}
    >
      {side === 'left' ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
    </button>
  );
}


function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
