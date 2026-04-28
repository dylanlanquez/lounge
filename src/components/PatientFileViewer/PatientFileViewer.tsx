import { useEffect, useState } from 'react';
import { Download, ExternalLink, FileText, Image as ImageIcon } from 'lucide-react';
import { Dialog } from '../Dialog/Dialog.tsx';
import { Button } from '../Button/Button.tsx';
import { StatusPill } from '../StatusPill/StatusPill.tsx';
import { Skeleton } from '../Skeleton/Skeleton.tsx';
import { theme } from '../../theme/index.ts';
import { signedUrlFor } from '../../lib/queries/patientFiles.ts';
import type { PatientFileEntry } from '../../lib/queries/patientProfile.ts';

// Modal preview for a single patient-file slot. Renders the latest
// active version up top — image inline if MIME starts with image/,
// the cached thumbnail_path PNG if available (STL/OBJ scan files), or
// a generic file glyph otherwise. Below: every version ever uploaded
// to this slot, ordered by version desc, with uploader and date. Each
// archived version is clickable and opens via signed URL in a new tab.
//
// View-only — no upload affordance, no delete. Lounge mirrors what
// Meridian holds; uploads happen on Meridian or via the customer
// portal. Status pill on each row distinguishes active / archived /
// pending so staff understand which one will be sent to the lab.

export interface PatientFileViewerProps {
  open: boolean;
  onClose: () => void;
  slotLabel: string;
  // All entries belonging to this slot, ordered newest first. The first
  // active entry is the headline; the rest renders as version history.
  entries: PatientFileEntry[];
}

export function PatientFileViewer({ open, onClose, slotLabel, entries }: PatientFileViewerProps) {
  const headline = entries.find((e) => e.status === 'active') ?? entries[0] ?? null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={slotLabel}
      description={
        headline?.version
          ? `Version ${headline.version} · uploaded ${formatDateTime(headline.uploaded_at)}`
          : undefined
      }
      width={640}
    >
      {headline ? <Preview entry={headline} /> : null}

      <h3
        style={{
          margin: `${theme.space[6]}px 0 ${theme.space[3]}px`,
          fontSize: theme.type.size.sm,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.inkMuted,
          textTransform: 'uppercase',
          letterSpacing: theme.type.tracking.tight,
        }}
      >
        Version history ({entries.length})
      </h3>

      {entries.length === 0 ? (
        <p style={{ margin: 0, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
          No versions yet.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
          {entries.map((e) => (
            <li key={e.id}>
              <VersionRow entry={e} />
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

// Renders the headline preview. Tries (in order): inline image render
// for image MIME, cached thumbnail_path render for 3D files, generic
// icon for everything else. Always shows the file name + an explicit
// "Open in new tab" button for the underlying file.
function Preview({ entry }: { entry: PatientFileEntry }) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);

  // Decide which storage path we want to render in the preview pane.
  // For image MIMEs we sign the original; for non-images we sign the
  // cached thumbnail_path if Meridian has produced one. STL/OBJ files
  // without a thumbnail show a placeholder glyph — no in-browser 3D
  // viewer in scope here.
  useEffect(() => {
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewUrl(null);
    const isImage = entry.mime_type?.startsWith('image/');
    const path = isImage ? entry.file_url : entry.thumbnail_path;
    if (!path) {
      setPreviewLoading(false);
      return;
    }
    (async () => {
      const url = await signedUrlFor(path, 300);
      if (cancelled) return;
      setPreviewUrl(url);
      setPreviewLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [entry.file_url, entry.thumbnail_path, entry.mime_type]);

  const openOriginal = async () => {
    const url = await signedUrlFor(entry.file_url, 300);
    if (url) window.open(url, '_blank');
  };

  return (
    <>
      <div
        style={{
          width: '100%',
          minHeight: 320,
          borderRadius: theme.radius.card,
          background: theme.color.bg,
          border: `1px solid ${theme.color.border}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {previewLoading ? (
          <Skeleton height={320} radius={14} />
        ) : previewUrl ? (
          <img
            src={previewUrl}
            alt={entry.file_name}
            style={{
              width: '100%',
              height: '100%',
              maxHeight: 480,
              objectFit: 'contain',
              display: 'block',
            }}
          />
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: theme.space[2],
              color: theme.color.inkSubtle,
            }}
          >
            {entry.mime_type?.startsWith('image/') ? (
              <ImageIcon size={36} aria-hidden />
            ) : (
              <FileText size={36} aria-hidden />
            )}
            <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
              No in-browser preview
            </span>
            <span style={{ fontSize: theme.type.size.xs }}>{entry.mime_type ?? 'unknown type'}</span>
          </div>
        )}
      </div>
      <div
        style={{
          marginTop: theme.space[3],
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[3],
        }}
      >
        <p
          style={{
            margin: 0,
            flex: 1,
            minWidth: 0,
            fontSize: theme.type.size.sm,
            color: theme.color.ink,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          }}
          title={entry.file_name}
        >
          {entry.file_name}
        </p>
        <Button variant="secondary" size="sm" onClick={openOriginal}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
            <ExternalLink size={14} /> Open
          </span>
        </Button>
      </div>
    </>
  );
}

function VersionRow({ entry }: { entry: PatientFileEntry }) {
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try {
      const url = await signedUrlFor(entry.file_url, 300);
      if (url) window.open(url, '_blank');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={open}
      disabled={busy}
      style={{
        appearance: 'none',
        width: '100%',
        textAlign: 'left',
        padding: theme.space[3],
        borderRadius: theme.radius.input,
        background: theme.color.surface,
        border: `1px solid ${theme.color.border}`,
        cursor: busy ? 'wait' : 'pointer',
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
          v{entry.version ?? '?'}{' '}
          <span style={{ color: theme.color.inkMuted, fontWeight: theme.type.weight.regular }}>
            · {formatDateTime(entry.uploaded_at)}
          </span>
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
          {entry.uploaded_by_name ? `Uploaded by ${entry.uploaded_by_name}` : 'Uploader unknown'}
          {entry.file_size_bytes ? ` · ${Math.round(entry.file_size_bytes / 1024)} KB` : ''}
        </p>
      </div>
      <StatusPill
        tone={entry.status === 'active' ? 'arrived' : entry.status === 'archived' ? 'neutral' : 'in_progress'}
        size="sm"
      >
        {humaniseFileStatus(entry.status)}
      </StatusPill>
      <Download size={14} color={theme.color.inkSubtle} aria-hidden />
    </button>
  );
}

function humaniseFileStatus(s: string): string {
  switch (s) {
    case 'active':
      return 'Active';
    case 'archived':
      return 'Archived';
    case 'pending':
      return 'Pending';
    case 'pending_review':
      return 'Pending review';
    default:
      return s;
  }
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
