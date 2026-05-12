import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { useStaleQueryLoading } from '../useStaleQueryLoading.ts';

// ── File label catalogue ────────────────────────────────────────────────
// Meridian's file_labels table is the source of truth for which slots
// appear on the patient files grid. Lounge used to hardcode an 8-slot
// list — fine until Meridian added "Bite Scan First" / "Bite Scan
// Second" and they were invisible here. The hook below reads the
// catalogue dynamically so any new label landing in Meridian shows up
// on the next render. Tip: keep the Lounge-side hardcoded extras (the
// four photo slots are uploadable from the kiosk; the rest are
// view-only) keyed off the SAME label key the catalogue exposes.

export interface PatientFileLabelRow {
  id: string;
  key: string;
  label: string;
  scope: string;
  active: boolean;
  sort_order: number;
}

interface PatientFileLabelsResult {
  data: PatientFileLabelRow[];
  loading: boolean;
  error: string | null;
}

export function usePatientFileLabels(): PatientFileLabelsResult {
  const [data, setData] = useState<PatientFileLabelRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { loading, settle } = useStaleQueryLoading('patient-file-labels');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: rows, error: err } = await supabase
        .from('file_labels')
        .select('id, key, label, scope, active, sort_order')
        .eq('scope', 'patient_file')
        .eq('active', true)
        .order('sort_order', { ascending: true });
      if (cancelled) return;
      if (err) {
        setError(err.message);
        settle();
        return;
      }
      setData((rows ?? []) as PatientFileLabelRow[]);
      setError(null);
      settle();
    })();
    return () => {
      cancelled = true;
    };
  }, [settle]);

  return { data, loading, error };
}

export interface PatientFileRow {
  id: string;
  patient_id: string;
  label_id: string | null;
  custom_label: string | null;
  file_url: string;
  file_name: string;
  file_size_bytes: number | null;
  mime_type: string | null;
  status: 'active' | 'archived' | 'pending' | 'pending_review';
  is_delivery: boolean;
  uploaded_at: string;
}

export async function getOrCreateLabel(key: string, displayName: string): Promise<string> {
  const { data: existing } = await supabase
    .from('file_labels')
    .select('id')
    .eq('key', key)
    .maybeSingle();
  if (existing) return (existing as { id: string }).id;
  const { data: created, error } = await supabase
    .from('file_labels')
    .insert({ key, label: displayName, sort_order: 900 })
    .select('id')
    .single();
  if (error || !created) throw new Error(error?.message ?? 'Could not create file_label');
  return (created as { id: string }).id;
}

export async function uploadPatientFile(args: {
  patientId: string;
  patientName: string;
  file: File;
  labelKey: string;
  labelDisplayName: string;
  uploaderAccountId: string | null;
}): Promise<PatientFileRow> {
  const labelId = await getOrCreateLabel(args.labelKey, args.labelDisplayName);

  // Storage path: patient_<slug>/<label>_<uid>.<ext>
  const slug = args.patientName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const ext = args.file.name.split('.').pop()?.toLowerCase() ?? 'bin';
  const uid = crypto.randomUUID().slice(0, 8);
  const path = `patient_${slug}/${args.labelKey}_${uid}.${ext}`;

  const { error: uploadErr } = await supabase.storage
    .from('case-files')
    .upload(path, args.file, { contentType: args.file.type, upsert: false });
  if (uploadErr) throw new Error(`Upload failed: ${uploadErr.message}`);

  // `description` is NOT NULL on patient_files with a CHECK that
  // trims to >= 3 chars. Use the label's display name — that's what
  // the file is, and the names we feed in (Before photo, Marketing
  // content, smile-photo slot labels, etc.) all clear the floor.
  const { data: row, error: insertErr } = await supabase
    .from('patient_files')
    .insert({
      patient_id: args.patientId,
      label_id: labelId,
      file_url: path,
      file_name: args.file.name,
      file_size_bytes: args.file.size,
      mime_type: args.file.type,
      status: 'active',
      is_delivery: false,
      uploaded_by: args.uploaderAccountId,
      description: args.labelDisplayName,
    })
    .select('*')
    .single();
  if (insertErr || !row) throw new Error(insertErr?.message ?? 'Could not record file');

  await supabase.from('patient_events').insert({
    patient_id: args.patientId,
    event_type: args.labelKey === 'consent_form_v1' ? 'consent_signed' : 'intake_photo_added',
    payload: { file_id: (row as { id: string }).id, label: args.labelKey },
  });

  return row as PatientFileRow;
}

export async function signedUrlFor(filePath: string, ttlSeconds = 300): Promise<string | null> {
  const { data, error } = await supabase.storage.from('case-files').createSignedUrl(filePath, ttlSeconds);
  if (error || !data) return null;
  return data.signedUrl;
}
