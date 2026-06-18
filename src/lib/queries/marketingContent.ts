import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { logFailure } from '../failureLog.ts';
import { properCase } from './appointments.ts';

// Marketing content gallery — the curated, consent-aware photos staff
// attach to an appointment from the "Before & after" and "Marketing
// content" cards on the visit page. We surface only those labels, never
// raw clinical smile photos, so nothing un-consented lands in a
// marketing view.

export type MarketingKind = 'before' | 'after' | 'marketing';

const KIND_BY_LABEL: Record<string, MarketingKind> = {
  before_photo: 'before',
  after_photo: 'after',
  marketing_content: 'marketing',
};

export const MARKETING_LABEL_KEYS = Object.keys(KIND_BY_LABEL);

const KIND_ORDER: Record<MarketingKind, number> = {
  before: 0,
  after: 1,
  marketing: 2,
};

export const KIND_LABEL: Record<MarketingKind, string> = {
  before: 'Before',
  after: 'After',
  marketing: 'Marketing',
};

// ── Raw shapes (exported so aggregateMarketingContent can be unit
// tested without a live Supabase response) ──────────────────────────

export interface McFileRow {
  id: string;
  file_url: string;
  file_name: string | null;
  uploaded_at: string;
  source_appointment_id: string;
  patient_id: string | null;
  labelKey: string;
}

export interface McAppointmentRow {
  id: string;
  appointment_ref: string | null;
  start_at: string | null;
  event_type_label: string | null;
  service_type: string | null;
  arch: string | null;
}

export interface McPatientRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
}

// ── Output shapes ───────────────────────────────────────────────────

export interface MarketingPhoto {
  id: string;
  filePath: string; // patient_files.file_url — a storage path, signed on demand
  fileName: string;
  kind: MarketingKind;
  uploadedAt: string;
}

export interface MarketingAppointment {
  appointmentId: string;
  ref: string;
  patientName: string;
  startAt: string | null;
  serviceLabel: string | null;
  arch: string | null;
  photos: MarketingPhoto[];
  latestUploadedAt: string;
}

export interface MarketingContentData {
  appointments: MarketingAppointment[];
  totalAppointments: number;
  totalPhotos: number;
  beforeAfterPhotos: number;
  marketingPhotos: number;
  // The single most recent photo across everything — the page's hero.
  featured: { photo: MarketingPhoto; appointment: MarketingAppointment } | null;
}

function patientName(patient: McPatientRow | undefined, ref: string): string {
  if (!patient) return ref;
  const name = [patient.first_name, patient.last_name]
    .filter((p): p is string => !!p && p.trim().length > 0)
    .join(' ')
    .trim();
  return name ? properCase(name) : ref;
}

export function aggregateMarketingContent(
  files: McFileRow[],
  appointments: McAppointmentRow[],
  patients: McPatientRow[],
): MarketingContentData {
  const apptById = new Map(appointments.map((a) => [a.id, a]));
  const patientById = new Map(patients.map((p) => [p.id, p]));

  const byAppt = new Map<string, MarketingPhoto[]>();
  const patientIdByAppt = new Map<string, string | null>();
  for (const f of files) {
    const kind = KIND_BY_LABEL[f.labelKey];
    if (!kind) continue;
    if (!apptById.has(f.source_appointment_id)) continue;
    const photo: MarketingPhoto = {
      id: f.id,
      filePath: f.file_url,
      fileName: f.file_name ?? 'Photo',
      kind,
      uploadedAt: f.uploaded_at,
    };
    const list = byAppt.get(f.source_appointment_id);
    if (list) list.push(photo);
    else byAppt.set(f.source_appointment_id, [photo]);
    if (!patientIdByAppt.has(f.source_appointment_id)) {
      patientIdByAppt.set(f.source_appointment_id, f.patient_id);
    }
  }

  const appts: MarketingAppointment[] = [];
  for (const [appointmentId, photos] of byAppt) {
    const appt = apptById.get(appointmentId)!;
    // Before, then after, then marketing — newest first within each kind.
    photos.sort(
      (a, b) =>
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime(),
    );
    const latestUploadedAt = photos.reduce(
      (latest, p) => (p.uploadedAt > latest ? p.uploadedAt : latest),
      photos[0]!.uploadedAt,
    );
    const ref = appt.appointment_ref ?? `LAP-${appointmentId.slice(0, 6)}`;
    const patientId = patientIdByAppt.get(appointmentId) ?? null;
    appts.push({
      appointmentId,
      ref,
      patientName: patientName(
        patientId ? patientById.get(patientId) : undefined,
        ref,
      ),
      startAt: appt.start_at,
      serviceLabel: appt.event_type_label ?? appt.service_type,
      arch: appt.arch,
      photos,
      latestUploadedAt,
    });
  }

  appts.sort(
    (a, b) =>
      new Date(b.latestUploadedAt).getTime() - new Date(a.latestUploadedAt).getTime(),
  );

  let totalPhotos = 0;
  let beforeAfterPhotos = 0;
  let marketingPhotos = 0;
  for (const a of appts) {
    for (const p of a.photos) {
      totalPhotos += 1;
      if (p.kind === 'marketing') marketingPhotos += 1;
      else beforeAfterPhotos += 1;
    }
  }

  const featured =
    appts.length > 0 ? { photo: appts[0]!.photos[0]!, appointment: appts[0]! } : null;

  return {
    appointments: appts,
    totalAppointments: appts.length,
    totalPhotos,
    beforeAfterPhotos,
    marketingPhotos,
    featured,
  };
}

// ── Hook ────────────────────────────────────────────────────────────

interface MarketingContentResult {
  data: MarketingContentData | null;
  loading: boolean;
  error: string | null;
}

export function useMarketingContent(): MarketingContentResult {
  const [data, setData] = useState<MarketingContentData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const labelRes = await supabase
          .from('file_labels')
          .select('id, key')
          .in('key', MARKETING_LABEL_KEYS);
        if (labelRes.error) throw new Error(`labels: ${labelRes.error.message}`);
        const keyByLabelId = new Map(
          (labelRes.data ?? []).map((l) => [l.id as string, l.key as string]),
        );
        const labelIds = Array.from(keyByLabelId.keys());

        if (labelIds.length === 0) {
          if (cancelled) return;
          setData(aggregateMarketingContent([], [], []));
          setLoading(false);
          return;
        }

        const fileRes = await supabase
          .from('patient_files')
          .select('id, file_url, file_name, uploaded_at, source_appointment_id, patient_id, label_id')
          .eq('status', 'active')
          .in('label_id', labelIds)
          .not('source_appointment_id', 'is', null)
          .order('uploaded_at', { ascending: false })
          .limit(1000);
        if (fileRes.error) throw new Error(`files: ${fileRes.error.message}`);
        const files: McFileRow[] = (fileRes.data ?? []).map((r) => ({
          id: r.id as string,
          file_url: r.file_url as string,
          file_name: r.file_name as string | null,
          uploaded_at: r.uploaded_at as string,
          source_appointment_id: r.source_appointment_id as string,
          patient_id: r.patient_id as string | null,
          labelKey: keyByLabelId.get(r.label_id as string) ?? '',
        }));

        if (files.length === 0) {
          if (cancelled) return;
          setData(aggregateMarketingContent([], [], []));
          setLoading(false);
          return;
        }

        const apptIds = Array.from(new Set(files.map((f) => f.source_appointment_id)));
        const patientIds = Array.from(
          new Set(files.map((f) => f.patient_id).filter((id): id is string => !!id)),
        );

        const [apptRes, patRes] = await Promise.all([
          supabase
            .from('lng_appointments')
            .select('id, appointment_ref, start_at, event_type_label, service_type, arch')
            .in('id', apptIds),
          patientIds.length
            ? supabase
                .from('patients')
                .select('id, first_name, last_name')
                .in('id', patientIds)
            : Promise.resolve({ data: [], error: null }),
        ]);
        if (cancelled) return;
        if (apptRes.error) throw new Error(`appointments: ${apptRes.error.message}`);
        if (patRes.error) throw new Error(`patients: ${patRes.error.message}`);

        const out = aggregateMarketingContent(
          files,
          (apptRes.data ?? []) as McAppointmentRow[],
          (patRes.data ?? []) as McPatientRow[],
        );
        if (cancelled) return;
        setData(out);
        setLoading(false);
      } catch (e: unknown) {
        if (cancelled) return;
        const message =
          e instanceof Error ? e.message : 'Could not load marketing content';
        setError(message);
        setLoading(false);
        await logFailure({
          source: 'marketing_content',
          severity: 'error',
          message,
          context: {},
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, loading, error };
}
