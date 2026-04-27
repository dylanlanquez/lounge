import { useRef, useState } from 'react';
import { Camera, FileText, Image as ImageIcon, Trash2 } from 'lucide-react';
import { Button } from '../Button/Button.tsx';
import { Card } from '../Card/Card.tsx';
import { EmptyState } from '../EmptyState/EmptyState.tsx';
import { Skeleton } from '../Skeleton/Skeleton.tsx';
import { Toast } from '../Toast/Toast.tsx';
import { theme } from '../../theme/index.ts';
import {
  type PatientFileRow,
  signedUrlFor,
  uploadPatientFile,
  usePatientFiles,
} from '../../lib/queries/patientFiles.ts';
import { supabase } from '../../lib/supabase.ts';

export interface VisitFilesProps {
  patientId: string;
  patientName: string;
}

type LabelKey = 'intake_photo_arrival' | 'consent_form_v1';

const LABEL_DISPLAY: Record<LabelKey, string> = {
  intake_photo_arrival: 'Intake photo (on arrival)',
  consent_form_v1: 'Consent form (v1)',
};

export function VisitFiles({ patientId, patientName }: VisitFilesProps) {
  const photoInput = useRef<HTMLInputElement>(null);
  const consentInput = useRef<HTMLInputElement>(null);
  const { data, loading, refresh } = usePatientFiles(patientId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onPick = async (label: LabelKey, files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const { data: accId } = await supabase.rpc('auth_account_id');
      for (const file of Array.from(files)) {
        await uploadPatientFile({
          patientId,
          patientName,
          file,
          labelKey: label,
          labelDisplayName: LABEL_DISPLAY[label],
          uploaderAccountId: (accId as string | null) ?? null,
        });
      }
      refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="lg">
      <h2
        style={{
          margin: 0,
          fontSize: theme.type.size.lg,
          fontWeight: theme.type.weight.semibold,
        }}
      >
        Files
      </h2>
      <p
        style={{
          margin: `${theme.space[2]}px 0 ${theme.space[5]}px`,
          color: theme.color.inkMuted,
          fontSize: theme.type.size.sm,
        }}
      >
        Intake photos and signed consent forms attach to the patient. Files persist across visits.
      </p>

      <div style={{ display: 'flex', gap: theme.space[3], flexWrap: 'wrap', marginBottom: theme.space[5] }}>
        <Button variant="secondary" onClick={() => photoInput.current?.click()} disabled={busy}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
            <Camera size={16} /> Add intake photo
          </span>
        </Button>
        <input
          ref={photoInput}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          onChange={(e) => onPick('intake_photo_arrival', e.target.files)}
          style={{ display: 'none' }}
        />
        <Button variant="secondary" onClick={() => consentInput.current?.click()} disabled={busy}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
            <FileText size={16} /> Add consent file
          </span>
        </Button>
        <input
          ref={consentInput}
          type="file"
          accept="image/*,application/pdf"
          onChange={(e) => onPick('consent_form_v1', e.target.files)}
          style={{ display: 'none' }}
        />
      </div>

      {loading ? (
        <Skeleton height={64} />
      ) : data.length === 0 ? (
        <EmptyState
          icon={<ImageIcon size={20} />}
          title="No files yet"
          description="Snap an intake photo with the tablet camera, or upload a signed consent form."
        />
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
          {data.map((f) => (
            <FileRow key={f.id} file={f} onChange={refresh} />
          ))}
        </ul>
      )}

      {error ? (
        <div style={{ position: 'fixed', bottom: theme.space[6], left: '50%', transform: 'translateX(-50%)', zIndex: 100 }}>
          <Toast tone="error" title="Could not upload" description={error} duration={6000} onDismiss={() => setError(null)} />
        </div>
      ) : null}
    </Card>
  );
}

function FileRow({ file, onChange }: { file: PatientFileRow; onChange: () => void }) {
  const [signed, setSigned] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = async () => {
    if (signed) {
      window.open(signed, '_blank');
      return;
    }
    setBusy(true);
    const url = await signedUrlFor(file.file_url, 300);
    setBusy(false);
    if (url) {
      setSigned(url);
      window.open(url, '_blank');
    }
  };

  const remove = async () => {
    if (!confirm('Archive this file?')) return;
    await supabase.from('patient_files').update({ status: 'archived' }).eq('id', file.id);
    onChange();
  };

  return (
    <li
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
        padding: theme.space[3],
        background: theme.color.surface,
        border: `1px solid ${theme.color.border}`,
        borderRadius: 12,
      }}
    >
      <FileIcon mime={file.mime_type} />
      <div style={{ flex: 1, minWidth: 0 }}>
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
          {file.file_name}
        </p>
        <p
          style={{
            margin: `${theme.space[1]}px 0 0`,
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
          }}
        >
          {new Date(file.uploaded_at).toLocaleString('en-GB', {
            day: '2-digit',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
          })}
          {file.file_size_bytes ? ` · ${Math.round(file.file_size_bytes / 1024)} KB` : ''}
        </p>
      </div>
      <Button variant="tertiary" size="sm" onClick={open} loading={busy}>
        Open
      </Button>
      <button
        type="button"
        onClick={remove}
        aria-label="Archive file"
        style={{
          appearance: 'none',
          border: 'none',
          background: 'transparent',
          color: theme.color.inkMuted,
          cursor: 'pointer',
          padding: theme.space[2],
        }}
      >
        <Trash2 size={16} />
      </button>
    </li>
  );
}

function FileIcon({ mime }: { mime: string | null }) {
  const isImage = mime?.startsWith('image/');
  return (
    <div
      style={{
        width: 36,
        height: 36,
        borderRadius: theme.radius.pill,
        background: theme.color.accentBg,
        color: theme.color.accent,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      {isImage ? <ImageIcon size={18} /> : <FileText size={18} />}
    </div>
  );
}
