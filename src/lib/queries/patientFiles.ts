import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { useStaleQueryLoading } from '../useStaleQueryLoading.ts';
import { logFailure } from '../failureLog.ts';

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

// Resolve a file_labels.key to its id. Read-only by design.
//
// This used to INSERT the label when the lookup came back empty. That
// was wrong twice over. file_labels is Meridian's catalogue table and
// Lounge staff hold no write privilege on it, so the insert failed
// with "new row violates row-level security policy for table
// file_labels" — an error that named the wrong problem, because the
// real fault was a label missing from the catalogue. And the lookup
// discarded its own error, so an unreadable row and an absent row
// were indistinguishable: any RLS or PostgREST failure on the read
// silently became an insert attempt.
//
// Labels are seeded by migration (see
// 20260907000001_lng_marketing_file_labels_seed.sql). A key that
// isn't there is a deployment gap, so say so, log it, and stop.
export async function getLabelId(key: string): Promise<string> {
  const { data: rows, error } = await supabase
    .from('file_labels')
    .select('id')
    .eq('key', key)
    .limit(2);
  if (error) {
    await logFailure({
      source: 'patient_files.getLabelId',
      severity: 'error',
      message: `Could not read file_labels for key "${key}": ${error.message}`,
      context: { labelKey: key },
    });
    throw new Error(`Could not read the file label catalogue: ${error.message}`);
  }
  const found = (rows ?? []) as Array<{ id: string }>;
  if (found.length === 0) {
    const message = `File label "${key}" is missing from the file_labels catalogue. It must be seeded by migration before this file type can be uploaded.`;
    await logFailure({
      source: 'patient_files.getLabelId',
      severity: 'error',
      message,
      context: { labelKey: key },
    });
    throw new Error(message);
  }
  // Duplicate keys mean two catalogue rows compete for the same
  // uploads and files split across them. maybeSingle() used to throw
  // here and the thrown error was swallowed; now it is loud.
  if (found.length > 1) {
    const message = `File label "${key}" has more than one row in file_labels. Uploads would split across them.`;
    await logFailure({
      source: 'patient_files.getLabelId',
      severity: 'critical',
      message,
      context: { labelKey: key },
    });
    throw new Error(message);
  }
  return found[0]!.id;
}

// Why did patient_files refuse this insert?
//
// Meridian gates the insert on can_write_patient_files_now(patient_id),
// which is a mutual-exclusion lock rather than a role check:
//
//   not exists (open scan cleanup on one of this patient's production
//               cases, started by an account other than mine)
//
// So while a technician is part way through a scan cleanup, nobody else
// can write that patient's files. That is deliberate on Meridian's
// side, but Lounge has no view of it, and a receptionist mid-visit
// should not be handed a Postgres policy name. Probe for the lock and
// say what is actually happening. When the probe cannot confirm it,
// say so plainly rather than guessing at a cause.
async function describeInsertRefusal(patientId: string): Promise<string> {
  const caseRes = await supabase
    .from('production_cases')
    .select('id')
    .eq('patient_id', patientId);
  if (caseRes.error) return '';
  const caseIds = ((caseRes.data ?? []) as Array<{ id: string }>).map((c) => c.id);
  if (caseIds.length === 0) return '';

  const lockRes = await supabase
    .from('production_case_scan_cleanups')
    .select('id')
    .is('completed_at', null)
    .in('production_case_id', caseIds)
    .limit(1);
  // A probe we are not allowed to run tells us nothing. Stay quiet
  // rather than blaming a lock we cannot see.
  if (lockRes.error) return '';
  if ((lockRes.data ?? []).length === 0) return '';

  return 'Another team member is part way through a scan cleanup for this patient. Photos cannot be added until they have finished it.';
}

function isRlsRefusal(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  return err.code === '42501' || /row-level security/i.test(err.message ?? '');
}

export async function uploadPatientFile(args: {
  patientId: string;
  patientName: string;
  file: File;
  labelKey: string;
  labelDisplayName: string;
  uploaderAccountId: string | null;
  /** When the upload is being promoted from a specific Lounge
   *  appointment's intake (e.g. smile-photo intake on the booking
   *  success screen), pass the appointment id so the patient_files
   *  row carries a back-reference. NULL for staff-uploaded files
   *  from the general patient-profile uploader, where there's no
   *  appointment to attribute. */
  sourceAppointmentId?: string | null;
}): Promise<PatientFileRow> {
  const labelId = await getLabelId(args.labelKey);

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
      source_appointment_id: args.sourceAppointmentId ?? null,
    })
    .select('*')
    .single();
  if (insertErr || !row) {
    // The object is already in case-files at this point. Without this
    // cleanup every failed insert (an RLS denial on patient_files, a
    // constraint trip) leaves an unreferenced file in the bucket that
    // no query can ever reach, and retrying compounds it because the
    // path carries a fresh uid each time. Remove it, then fail loud.
    const { error: cleanupErr } = await supabase.storage.from('case-files').remove([path]);
    const refusal = isRlsRefusal(insertErr) ? await describeInsertRefusal(args.patientId) : '';
    await logFailure({
      source: 'patient_files.uploadPatientFile',
      severity: 'error',
      message: `patient_files insert failed for label "${args.labelKey}": ${insertErr?.message ?? 'no row returned'}`,
      context: {
        patientId: args.patientId,
        labelKey: args.labelKey,
        storagePath: path,
        orphanRemoved: !cleanupErr,
        cleanupError: cleanupErr?.message ?? null,
        // Empty when the refusal was not the scan-cleanup lock, or
        // when we could not read far enough to tell.
        refusalCause: refusal || null,
      },
    });
    if (refusal) throw new Error(refusal);
    throw new Error(insertErr?.message ?? 'Could not record file');
  }

  // Patient-axis event. The file itself is already recorded, so a
  // failure here must not fail the upload, but it must not vanish
  // either: the patient timeline would silently lose the entry.
  const { error: eventErr } = await supabase.from('patient_events').insert({
    patient_id: args.patientId,
    event_type: args.labelKey === 'consent_form_v1' ? 'consent_signed' : 'intake_photo_added',
    payload: { file_id: (row as { id: string }).id, label: args.labelKey },
  });
  if (eventErr) {
    await logFailure({
      source: 'patient_files.uploadPatientFile',
      severity: 'warning',
      message: `patient_events insert failed after upload: ${eventErr.message}`,
      context: {
        patientId: args.patientId,
        labelKey: args.labelKey,
        fileId: (row as { id: string }).id,
      },
    });
  }

  return row as PatientFileRow;
}

export async function signedUrlFor(filePath: string, ttlSeconds = 300): Promise<string | null> {
  const { data, error } = await supabase.storage.from('case-files').createSignedUrl(filePath, ttlSeconds);
  if (error || !data) return null;
  return data.signedUrl;
}
