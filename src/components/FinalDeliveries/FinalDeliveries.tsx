import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Boxes, ChevronLeft, ChevronRight, FileText } from 'lucide-react';
import { CollapsibleCard } from '../CollapsibleCard/CollapsibleCard.tsx';
import { theme } from '../../theme/index.ts';
import { PreviewModal } from '../PatientFilesGrid/PatientFilesGrid.tsx';
import { signedUrlFor } from '../../lib/queries/patientFiles.ts';
import {
  usePatientDeliveryFiles,
  type DeliveryFileEntry,
  type PatientFileEntry,
} from '../../lib/queries/patientProfile.ts';

// ─────────────────────────────────────────────────────────────────────────────
// FinalDeliveries — carousel of accepted delivery files for one patient.
//
// Layout mirrors Patient files: a horizontal-scroll row of 176×200
// cards with a thumbnail zone on top and a metadata footer. Each card
// represents one delivery attachment (typically a click-in veneer
// STL or a finished-aligner photo) and taps through to the shared
// PreviewModal — the on-demand 3D viewer renders STL / OBJ / PLY,
// images / PDFs render inline.
//
// Rejected attempts sit behind an inline 'X rejected' toggle below
// the carousel as a small list, so reception can audit history
// without crowding the primary surface.
// ─────────────────────────────────────────────────────────────────────────────

const CARD_W = 176;
const CARD_H = 200;
const THUMB_H = 116;

interface DeliveryCardModel {
  entry: DeliveryFileEntry;
  applianceLabel: string;
}

export function FinalDeliveries({ patientId }: { patientId: string }) {
  const { groups, loading, error } = usePatientDeliveryFiles(patientId);
  const [previewFile, setPreviewFile] = useState<PatientFileEntry | null>(null);
  const [rejectedOpen, setRejectedOpen] = useState(false);

  // Flatten the accepted entries from every appliance group into one
  // carousel, newest-first by reviewed-at, so reception sees the most
  // recent shipped item first regardless of appliance type.
  const accepted = useMemo<DeliveryCardModel[]>(() => {
    const list: DeliveryCardModel[] = [];
    for (const g of groups) {
      for (const e of g.accepted) list.push({ entry: e, applianceLabel: g.applianceLabel });
    }
    list.sort((a, b) => (b.entry.reviewedAt ?? '').localeCompare(a.entry.reviewedAt ?? ''));
    return list;
  }, [groups]);

  const rejected = useMemo<DeliveryCardModel[]>(() => {
    const list: DeliveryCardModel[] = [];
    for (const g of groups) {
      for (const e of g.rejected) list.push({ entry: e, applianceLabel: g.applianceLabel });
    }
    list.sort((a, b) => (b.entry.reviewedAt ?? '').localeCompare(a.entry.reviewedAt ?? ''));
    return list;
  }, [groups]);

  return (
    <>
      <CollapsibleCard
        icon={<Boxes size={18} color={theme.color.ink} aria-hidden />}
        title="Final deliveries"
        meta={`${accepted.length} ${accepted.length === 1 ? 'file' : 'files'}`}
      >
        {error ? (
          <p style={{ margin: 0, color: theme.color.alert, fontSize: theme.type.size.sm }}>
            Could not load deliveries: {error}
          </p>
        ) : loading ? (
          <p style={{ margin: 0, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
            Loading…
          </p>
        ) : accepted.length === 0 && rejected.length === 0 ? (
          <p style={{ margin: 0, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
            No delivery files yet. Once a case ships to the patient, the accepted files will appear
            here — handy for re-prints without redoing the design.
          </p>
        ) : (
          <>
            {accepted.length > 0 ? (
              <ScrollRow>
                {accepted.map((c) => (
                  <DeliveryCard
                    key={c.entry.id}
                    card={c}
                    onPreview={() => setPreviewFile(c.entry.file)}
                  />
                ))}
              </ScrollRow>
            ) : (
              <p style={{ margin: 0, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
                No accepted deliveries yet.
              </p>
            )}

            {rejected.length > 0 ? (
              <div style={{ marginTop: theme.space[3] }}>
                <button
                  type="button"
                  onClick={() => setRejectedOpen((o) => !o)}
                  aria-expanded={rejectedOpen}
                  style={{
                    appearance: 'none',
                    border: 'none',
                    background: 'transparent',
                    padding: 0,
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: theme.space[1],
                    fontFamily: 'inherit',
                    fontSize: theme.type.size.xs,
                    fontWeight: theme.type.weight.semibold,
                    color: theme.color.inkMuted,
                    textTransform: 'uppercase',
                    letterSpacing: theme.type.tracking.wide,
                  }}
                >
                  Rejected deliveries ({rejected.length})
                  <ChevronRight
                    size={14}
                    aria-hidden
                    style={{
                      transition: `transform ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
                      transform: rejectedOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                    }}
                  />
                </button>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateRows: rejectedOpen ? '1fr' : '0fr',
                    transition: `grid-template-rows ${theme.motion.duration.base}ms ${theme.motion.easing.spring}`,
                  }}
                >
                  <div style={{ overflow: 'hidden' }}>
                    <ul
                      style={{
                        listStyle: 'none',
                        margin: `${theme.space[2]}px 0 0`,
                        padding: 0,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: theme.space[2],
                      }}
                    >
                      {rejected.map((c) => (
                        <li key={c.entry.id}>
                          <RejectedRow
                            card={c}
                            onPreview={() => setPreviewFile(c.entry.file)}
                          />
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            ) : null}
          </>
        )}
      </CollapsibleCard>

      {previewFile ? (
        <PreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />
      ) : null}
    </>
  );
}

// ─── Card ───────────────────────────────────────────────────────────────────

function DeliveryCard({
  card,
  onPreview,
}: {
  card: DeliveryCardModel;
  onPreview: () => void;
}) {
  const [hover, setHover] = useState(false);
  const { entry, applianceLabel } = card;
  const file = entry.file;
  return (
    <div
      onClick={onPreview}
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
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {applianceLabel}
        </div>
        <div
          style={{
            fontSize: 12,
            fontWeight: theme.type.weight.medium,
            color: theme.color.inkMuted,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {shortLabel(file) ?? 'Delivery'}
          {file.version != null ? (
            <span style={{ color: theme.color.inkSubtle, fontWeight: theme.type.weight.regular }}>
              <span aria-hidden style={{ margin: '0 4px', color: theme.color.inkSubtle }}>
                ·
              </span>
              v{file.version}
            </span>
          ) : null}
        </div>
        {entry.caseRef || entry.reviewerName ? (
          <div
            style={{
              fontSize: 10,
              color: theme.color.inkSubtle,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {entry.caseRef ?? ''}
            {entry.caseRef && entry.reviewerName ? ' · ' : ''}
            {entry.reviewerName ? `By ${entry.reviewerName}` : ''}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function RejectedRow({
  card,
  onPreview,
}: {
  card: DeliveryCardModel;
  onPreview: () => void;
}) {
  const { entry, applianceLabel } = card;
  const ext = (entry.file.file_name || '').split('.').pop()?.toLowerCase() || '';
  return (
    <button
      type="button"
      onClick={onPreview}
      style={{
        appearance: 'none',
        textAlign: 'left',
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
        padding: `${theme.space[2]}px ${theme.space[3]}px`,
        borderRadius: theme.radius.input,
        background: theme.color.surface,
        border: `1px solid ${theme.color.border}`,
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 32,
          height: 32,
          borderRadius: theme.radius.input,
          flexShrink: 0,
          background: theme.color.bg,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 9,
          fontWeight: theme.type.weight.bold,
          color: theme.color.inkMuted,
          textTransform: 'uppercase',
          border: `1px solid ${theme.color.border}`,
        }}
      >
        {ext.slice(0, 4) || 'FILE'}
      </span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span
          style={{
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.medium,
            color: theme.color.ink,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {applianceLabel}
          {entry.caseRef ? (
            <code style={{ marginLeft: theme.space[2], fontSize: 10, color: theme.color.inkMuted }}>
              {entry.caseRef}
            </code>
          ) : null}
        </span>
        <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
          Rejected{entry.reviewedAt ? ` ${formatShort(entry.reviewedAt)}` : ''}
          {entry.reviewerName ? ` · ${entry.reviewerName}` : ''}
        </span>
        {entry.rejectionNote ? (
          <p
            style={{
              margin: `${theme.space[1]}px 0 0`,
              fontSize: theme.type.size.xs,
              color: theme.color.alert,
              lineHeight: 1.45,
            }}
          >
            {entry.rejectionNote}
          </p>
        ) : null}
      </div>
    </button>
  );
}

// ─── Thumbnail (image / 3D thumb / file-type fallback) ─────────────────────

function FileThumb({ file }: { file: PatientFileEntry }) {
  const path = file.thumbnail_path
    ? file.thumbnail_path
    : file.mime_type?.startsWith('image/')
      ? file.file_url
      : null;
  const url = useSignedUrl(path);
  if (url) {
    return (
      <img
        src={url}
        alt={file.file_name}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
      />
    );
  }
  const ext = (file.file_name || '').split('.').pop()?.toLowerCase() || '';
  const is3D = ['stl', 'obj', 'ply'].includes(ext);
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        color: is3D ? theme.color.surface : theme.color.inkSubtle,
        background: is3D ? theme.color.ink : 'transparent',
        width: '100%',
        height: '100%',
      }}
    >
      <FileText size={22} />
      {ext ? (
        <span
          style={{
            fontSize: 9,
            fontWeight: theme.type.weight.bold,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}
        >
          {ext}
        </span>
      ) : null}
    </span>
  );
}

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

// ─── ScrollRow with edge nav buttons (mirrors PatientFilesGrid) ────────────

function ScrollRow({ children }: { children: React.ReactNode }) {
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

function formatShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// Squash the file's label / filename down to the slot identifier the
// receptionist actually cares about — Upper, Lower, Both arches — so
// the card reads cleanly under the appliance name. Falls back to the
// custom label or display label if neither side can be inferred.
function shortLabel(file: PatientFileEntry): string | null {
  const haystack = `${file.label_key ?? ''} ${file.label_display ?? ''} ${file.custom_label ?? ''} ${file.file_name}`.toLowerCase();
  if (/\bboth\b/.test(haystack)) return 'Both arches';
  if (/\bupper\b/.test(haystack)) return 'Upper';
  if (/\blower\b/.test(haystack)) return 'Lower';
  if (file.custom_label && file.custom_label.trim()) return file.custom_label.trim();
  if (file.label_display && file.label_display.trim()) return file.label_display.trim();
  return null;
}
