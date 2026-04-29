import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, FileText, X } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { signedUrlFor } from '../../lib/queries/patientFiles.ts';
import type { PatientFileEntry } from '../../lib/queries/patientProfile.ts';

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
  icon: 'upper_arch' | 'lower_arch' | 'bite' | 'camera' | 'xray' | 'other';
}

const SLOT_DEFS: SlotDef[] = [
  { group: 'upper_arch', label: 'Upper Arch', subLabelKeys: ['upper_arch', 'upper_arch_opposing'], icon: 'upper_arch' },
  { group: 'lower_arch', label: 'Lower Arch', subLabelKeys: ['lower_arch', 'lower_arch_opposing'], icon: 'lower_arch' },
  { group: 'bite_registration', label: 'Bite Registration', subLabelKeys: ['bite_registration', 'both_arches'], icon: 'bite' },
  { group: 'full_face_photo', label: 'Full Face Photo', subLabelKeys: ['full_face_photo'], icon: 'camera' },
  { group: 'smile_photo_front', label: 'Smile Photo — Front', subLabelKeys: ['smile_photo_front'], icon: 'camera' },
  { group: 'smile_photo_left', label: 'Smile Photo — Left', subLabelKeys: ['smile_photo_left'], icon: 'camera' },
  { group: 'smile_photo_right', label: 'Smile Photo — Right', subLabelKeys: ['smile_photo_right'], icon: 'camera' },
  { group: 'xray', label: 'X-Ray', subLabelKeys: ['xray_panoramic', 'xray_periapical', 'reference_previous_work', 'patient_reference_image'], icon: 'xray' },
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
  icon: SlotDef['icon'];
  // The file shown on the card face. Null for empty slots.
  file: PatientFileEntry | null;
  // Total number of versions for this slot (counts every file mapped to
  // the slot's labels, not just the visible one).
  versionCount: number;
  // Every version, newest first. Powers the History modal.
  versions: PatientFileEntry[];
}

function buildCards(files: PatientFileEntry[]): FileCardModel[] {
  // Group every file by slot group via its label_key. Files whose label
  // doesn't map to a fixed slot end up in dynamic 'other_*' groups,
  // matching Meridian's behaviour.
  const byGroup = new Map<string, PatientFileEntry[]>();
  const labelDisplayByGroup = new Map<string, string>();
  const iconByGroup = new Map<string, SlotDef['icon']>();

  for (const f of files) {
    const labelKey = f.label_key ?? '';
    let group = LABEL_TO_GROUP[labelKey];
    let icon: SlotDef['icon'] = 'other';
    let label = f.label_display ?? f.custom_label ?? 'Other';

    if (!group) {
      // Build a synthetic "other_*" group keyed on (label_key + custom_label)
      // so each named upload reads as its own slot card.
      const customSlug = (f.custom_label ?? '').trim().toLowerCase();
      group = `other_${labelKey || 'unlabelled'}_${customSlug}`;
      label = (f.custom_label && f.custom_label.trim()) || f.label_display || 'Other';
    } else {
      const def = SLOT_DEFS.find((d) => d.group === group)!;
      icon = def.icon;
      label = def.label;
    }
    iconByGroup.set(group, icon);
    labelDisplayByGroup.set(group, label);
    const list = byGroup.get(group) ?? [];
    list.push(f);
    byGroup.set(group, list);
  }

  // Sort each group's versions newest first by uploaded_at then version.
  for (const list of byGroup.values()) {
    list.sort((a, b) => {
      const av = a.version ?? 0;
      const bv = b.version ?? 0;
      if (bv !== av) return bv - av;
      return b.uploaded_at.localeCompare(a.uploaded_at);
    });
  }

  const cards: FileCardModel[] = [];

  // 1) Fixed slot cards — always render in the canonical order, even
  //    when empty, so the receptionist sees the same shape on every
  //    patient profile.
  for (const def of SLOT_DEFS) {
    const versions = byGroup.get(def.group) ?? [];
    cards.push({
      group: def.group,
      label: def.label,
      icon: def.icon,
      file: versions[0] ?? null,
      versionCount: versions.length,
      versions,
    });
  }

  // 2) Other / custom-label cards — one per dynamic group, newest slot
  //    first by latest upload.
  const dynamic: FileCardModel[] = [];
  for (const [group, versions] of byGroup.entries()) {
    if (SLOT_DEFS.some((d) => d.group === group)) continue;
    if (versions.length === 0) continue;
    dynamic.push({
      group,
      label: labelDisplayByGroup.get(group) ?? 'Other',
      icon: iconByGroup.get(group) ?? 'other',
      file: versions[0]!,
      versionCount: versions.length,
      versions,
    });
  }
  dynamic.sort((a, b) => (b.file?.uploaded_at ?? '').localeCompare(a.file?.uploaded_at ?? ''));

  return [...cards, ...dynamic];
}

// ─── Slot icons — ported from Meridian/FileSlot.jsx ─────────────────────────
// These are the exact glyphs Meridian uses so the surface reads as
// familiar to staff who toggle between the two apps. currentColor keeps
// the icon recolourable from the parent.

function SlotIcon({ kind }: { kind: SlotDef['icon'] }) {
  const common = {
    width: 26,
    height: 26,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  if (kind === 'upper_arch') {
    return (
      <svg {...common}>
        <path d="M3 6c.5 4 2 8 4 10.5S10 20 12 20s3-1.5 5-3.5S19.5 10 20 6" />
        <path
          d="M6.5 7.5c.3 1 .5 2.2.5 2.5M10 8.5c.2 1 .3 2.5.3 2.5M13.7 8.5c-.2 1-.3 2.5-.3 2.5M17.5 7.5c-.3 1-.5 2.2-.5 2.5"
          opacity="0.4"
        />
      </svg>
    );
  }
  if (kind === 'lower_arch') {
    return (
      <svg {...common}>
        <path d="M3 18c.5-4 2-8 4-10.5S10 4 12 4s3 1.5 5 3.5S19.5 14 20 18" />
        <path
          d="M6.5 16.5c.3-1 .5-2.2.5-2.5M10 15.5c.2-1 .3-2.5.3-2.5M13.7 15.5c-.2-1-.3-2.5-.3-2.5M17.5 16.5c-.3-1-.5-2.2-.5-2.5"
          opacity="0.4"
        />
      </svg>
    );
  }
  if (kind === 'bite') {
    return (
      <svg {...common}>
        <path d="M4 5c0 4 3 7 8 7s8-3 8-7" />
        <path d="M4 19c0-4 3-7 8-7s8 3 8 7" />
        <line x1="8" y1="10" x2="8" y2="14" opacity="0.3" />
        <line x1="12" y1="10" x2="12" y2="14" opacity="0.3" />
        <line x1="16" y1="10" x2="16" y2="14" opacity="0.3" />
      </svg>
    );
  }
  if (kind === 'camera') {
    return (
      <svg {...common}>
        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
        <circle cx="12" cy="13" r="4" />
      </svg>
    );
  }
  if (kind === 'xray') {
    return (
      <svg {...common} strokeWidth={1.4}>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M9 8v8M15 8v8M9 12h6" opacity="0.5" />
      </svg>
    );
  }
  return (
    <svg {...common} strokeWidth={1.4}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

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
  onPreview,
  onHistory,
}: {
  card: FileCardModel;
  onPreview: (file: PatientFileEntry) => void;
  onHistory: (card: FileCardModel) => void;
}) {
  const [hover, setHover] = useState(false);

  if (!card.file) {
    return (
      <div
        style={{
          width: CARD_W,
          height: CARD_H,
          flexShrink: 0,
          scrollSnapAlign: 'start',
          borderRadius: 16,
          border: `2px dashed ${theme.color.border}`,
          background: theme.color.bg,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          padding: '10px 12px',
          boxSizing: 'border-box',
          opacity: 0.6,
          color: theme.color.inkSubtle,
        }}
      >
        <SlotIcon kind={card.icon} />
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
        <span style={{ fontSize: 10, color: theme.color.inkSubtle }}>No file yet</span>
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
              gap: 4,
              alignSelf: 'flex-start',
            }}
          >
            <span aria-hidden>→</span>
            View history ({card.versionCount})
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ─── Preview modal ──────────────────────────────────────────────────────────

function PreviewModal({ file, onClose }: { file: PatientFileEntry; onClose: () => void }) {
  // Resolve a long-TTL signed URL for the full file. Images render
  // inline; PDFs in an iframe. Anything else just shows the icon and
  // filename — Lounge isn't a download surface so deeper types get a
  // 'preview not available' message rather than a broken viewer.
  const url = useSignedUrl(file.file_url);
  const isImage = !!file.mime_type?.startsWith('image/');
  const isPdf = file.mime_type === 'application/pdf';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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
        padding: theme.space[6],
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: theme.color.surface,
          borderRadius: theme.radius.card,
          maxWidth: 540,
          width: '100%',
          maxHeight: '100%',
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span
              style={{
                fontSize: theme.type.size.base,
                fontWeight: theme.type.weight.semibold,
                color: theme.color.ink,
              }}
            >
              {card.label}
            </span>
            <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
              {card.versionCount} {card.versionCount === 1 ? 'version' : 'versions'}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close version history"
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
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            overflowY: 'auto',
          }}
        >
          {card.versions.map((v, i) => (
            <li
              key={v.id}
              style={{
                borderBottom:
                  i === card.versions.length - 1 ? 'none' : `1px solid ${theme.color.border}`,
              }}
            >
              <button
                type="button"
                onClick={() => onPreview(v)}
                style={{
                  appearance: 'none',
                  border: 'none',
                  background: 'transparent',
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: theme.space[3],
                  padding: theme.space[3],
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  textAlign: 'left',
                }}
              >
                <span
                  style={{
                    width: 56,
                    height: 56,
                    borderRadius: theme.radius.input,
                    background: theme.color.bg,
                    border: `1px solid ${theme.color.border}`,
                    flexShrink: 0,
                    overflow: 'hidden',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <FileThumb file={v} />
                </span>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span
                    style={{
                      fontSize: theme.type.size.sm,
                      fontWeight: theme.type.weight.medium,
                      color: theme.color.ink,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    v{v.version ?? i + 1} · {v.file_name}
                  </span>
                  <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
                    {formatShort(v.uploaded_at)}
                    {v.uploaded_by_name ? ` · ${v.uploaded_by_name}` : ''}
                    {v.file_size_bytes ? ` · ${formatBytes(v.file_size_bytes)}` : ''}
                  </span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ─── Public surface ─────────────────────────────────────────────────────────

export function PatientFilesGrid({
  files,
  loading,
}: {
  files: PatientFileEntry[];
  loading: boolean;
}) {
  const cards = useMemo(() => buildCards(files), [files]);
  const [previewFile, setPreviewFile] = useState<PatientFileEntry | null>(null);
  const [historyCard, setHistoryCard] = useState<FileCardModel | null>(null);

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
                onPreview={setPreviewFile}
                onHistory={setHistoryCard}
              />
            ))}
          </ScrollRow>
        )}
      </div>

      {previewFile ? (
        <PreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />
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

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
