import { useState, type CSSProperties } from 'react';
import { Boxes, ChevronDown, Eye } from 'lucide-react';
import { CollapsibleCard } from '../CollapsibleCard/CollapsibleCard.tsx';
import { theme } from '../../theme/index.ts';
import { PreviewModal } from '../PatientFilesGrid/PatientFilesGrid.tsx';
import {
  usePatientDeliveryFiles,
  type DeliveryFileEntry,
  type DeliveryGroup,
  type PatientFileEntry,
} from '../../lib/queries/patientProfile.ts';

// ─────────────────────────────────────────────────────────────────────────────
// FinalDeliveries — view-only port of Meridian's FinalDeliverySections.
//
// One sub-card per appliance type (case_type label). Each sub-card
// lists the *accepted* delivery files (the source of truth — what was
// shipped to the patient) and tucks rejected attempts behind a
// collapsible toggle. Tapping any row opens the shared PreviewModal,
// which already knows how to render images / PDFs / STL meshes via
// the on-demand ModelViewer.
//
// Lounge runs on Samsung tablets at the desk: no download / accept /
// reject / flag. Just see what's been delivered, and if a click-in
// veneer set is already on file, identify which one it is.
// ─────────────────────────────────────────────────────────────────────────────

export function FinalDeliveries({ patientId }: { patientId: string }) {
  const { groups, loading, error } = usePatientDeliveryFiles(patientId);
  const [previewFile, setPreviewFile] = useState<PatientFileEntry | null>(null);

  const totalAppliances = groups.length;

  return (
    <>
      <CollapsibleCard
        icon={<Boxes size={18} color={theme.color.ink} aria-hidden />}
        title="Final deliveries"
        meta={`${totalAppliances} ${totalAppliances === 1 ? 'appliance' : 'appliances'}`}
      >
        {error ? (
          <p style={{ margin: 0, color: theme.color.alert, fontSize: theme.type.size.sm }}>
            Could not load deliveries: {error}
          </p>
        ) : loading ? (
          <p style={{ margin: 0, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
            Loading…
          </p>
        ) : groups.length === 0 ? (
          <p style={{ margin: 0, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
            No delivery files yet. When a case ships to the patient, the accepted files will appear
            here — handy for re-prints without redoing the design.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
            {groups.map((g) => (
              <ApplianceDeliveryCard
                key={g.applianceLabel}
                group={g}
                onPreview={(f) => setPreviewFile(f)}
              />
            ))}
          </div>
        )}
      </CollapsibleCard>

      {previewFile ? (
        <PreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />
      ) : null}
    </>
  );
}

function ApplianceDeliveryCard({
  group,
  onPreview,
}: {
  group: DeliveryGroup;
  onPreview: (file: PatientFileEntry) => void;
}) {
  const [rejectedOpen, setRejectedOpen] = useState(false);
  const accepted = group.accepted;
  const rejected = group.rejected;

  return (
    <article
      style={{
        border: `1px solid ${theme.color.border}`,
        borderRadius: theme.radius.card,
        background: theme.color.surface,
        padding: theme.space[4],
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[3],
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: theme.space[3],
          flexWrap: 'wrap',
        }}
      >
        <h3
          style={{
            margin: 0,
            fontSize: theme.type.size.md,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          Final delivery · {group.applianceLabel}
        </h3>
        <span
          style={{
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
            fontWeight: theme.type.weight.semibold,
            textTransform: 'uppercase',
            letterSpacing: theme.type.tracking.wide,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {accepted.length} accepted{rejected.length > 0 ? ` · ${rejected.length} rejected` : ''}
        </span>
      </header>

      {accepted.length > 0 ? (
        <ul style={listStyle}>
          {accepted.map((entry) => (
            <li key={entry.id}>
              <DeliveryFileRow entry={entry} variant="accepted" onPreview={() => onPreview(entry.file)} />
            </li>
          ))}
        </ul>
      ) : (
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
            padding: `${theme.space[2]}px 0`,
          }}
        >
          No accepted delivery files yet.
        </p>
      )}

      {rejected.length > 0 ? (
        <div>
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
            <ChevronDown
              size={14}
              aria-hidden
              style={{
                transition: `transform ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
                transform: rejectedOpen ? 'rotate(180deg)' : 'rotate(0deg)',
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
              <ul style={{ ...listStyle, marginTop: theme.space[2] }}>
                {rejected.map((entry) => (
                  <li key={entry.id}>
                    <DeliveryFileRow
                      entry={entry}
                      variant="rejected"
                      onPreview={() => onPreview(entry.file)}
                    />
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function DeliveryFileRow({
  entry,
  variant,
  onPreview,
}: {
  entry: DeliveryFileEntry;
  variant: 'accepted' | 'rejected';
  onPreview: () => void;
}) {
  const ext = (entry.file.file_name || '').split('.').pop()?.toLowerCase() || '';
  const is3D = ['stl', 'obj', 'ply'].includes(ext);
  const isAccepted = variant === 'accepted';
  return (
    <button
      type="button"
      onClick={onPreview}
      aria-label={`Preview ${entry.file.file_name}`}
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
          width: 36,
          height: 36,
          borderRadius: theme.radius.input,
          flexShrink: 0,
          background: is3D ? theme.color.ink : theme.color.bg,
          color: is3D ? theme.color.surface : theme.color.inkMuted,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 9,
          fontWeight: theme.type.weight.bold,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          border: `1px solid ${theme.color.border}`,
        }}
      >
        {ext.slice(0, 4) || 'FILE'}
      </span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], flexWrap: 'wrap' }}>
          <span
            style={{
              fontSize: theme.type.size.sm,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {entry.file.file_name}
          </span>
          {entry.caseRef ? (
            <code
              style={{
                fontSize: theme.type.size.xs,
                color: theme.color.inkMuted,
              }}
            >
              {entry.caseRef}
            </code>
          ) : null}
        </div>
        <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
          {entry.reviewedAt ? formatShort(entry.reviewedAt) : 'No date'}
          {entry.reviewerName
            ? ` · ${isAccepted ? 'Approved' : 'Rejected'} by ${entry.reviewerName}`
            : ''}
        </span>
        {!isAccepted && entry.rejectionNote ? (
          <p style={{ margin: `${theme.space[1]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.alert, lineHeight: 1.45 }}>
            {entry.rejectionNote}
          </p>
        ) : null}
      </div>
      <Eye size={16} color={theme.color.inkMuted} aria-hidden />
    </button>
  );
}

const listStyle: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: theme.space[2],
};

function formatShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
