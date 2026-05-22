import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';

// Hook + helpers for the click-in veneers pre-visit photo set
// captured via the booking widget. The widget uploads via the
// `widget-upload-intake-photo` edge function; this module is the
// staff-side read path used by the Appointment Detail viewer.

export type IntakePhotoKind = 'front' | 'left' | 'right';

export interface IntakePhotoRow {
  id: string;
  appointmentId: string;
  kind: IntakePhotoKind;
  filePath: string;
  mimeType: string | null;
  sizeBytes: number | null;
  uploadedAt: string;
}

const BUCKET = 'lng-booking-intake-photos';

interface ReadResult {
  rows: IntakePhotoRow[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useBookingIntakePhotos(
  appointmentId: string | null,
): ReadResult {
  const [rows, setRows] = useState<IntakePhotoRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!appointmentId) {
      setRows([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      const { data, error: err } = await supabase
        .from('lng_booking_intake_photos')
        .select('id, appointment_id, kind, file_path, mime_type, size_bytes, uploaded_at')
        .eq('appointment_id', appointmentId)
        .order('uploaded_at', { ascending: true });
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setRows([]);
        setLoading(false);
        return;
      }
      setRows(
        (data ?? []).map((r) => ({
          id: r.id as string,
          appointmentId: r.appointment_id as string,
          kind: r.kind as IntakePhotoKind,
          filePath: r.file_path as string,
          mimeType: (r.mime_type as string | null) ?? null,
          sizeBytes: (r.size_bytes as number | null) ?? null,
          uploadedAt: r.uploaded_at as string,
        })),
      );
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [appointmentId, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { rows, loading, error, refresh };
}

export async function signIntakePhotoUrl(
  filePath: string,
  ttlSeconds = 300,
): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(filePath, ttlSeconds);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

// Delete a single intake-photo slot (front/left/right) for an
// appointment via the staff-delete-intake-photo edge function. The
// function removes both the storage object and the index row.
// Idempotent: a missing row returns ok=true.
export async function deleteIntakePhoto(args: {
  appointmentId: string;
  kind: IntakePhotoKind;
}): Promise<void> {
  const { data, error } = await supabase.functions.invoke<{
    ok?: boolean;
    error?: string;
    detail?: string;
  }>('staff-delete-intake-photo', {
    body: { appointment_id: args.appointmentId, kind: args.kind },
  });
  if (error) {
    const ctx = (error as { context?: unknown }).context;
    if (ctx && typeof (ctx as Response).json === 'function') {
      try {
        const body = (await (ctx as Response).clone().json()) as {
          error?: string;
          detail?: string;
        };
        const code = body?.error ?? 'delete_failed';
        throw new Error(body?.detail ? `${code}: ${body.detail}` : code);
      } catch (e) {
        if (e instanceof Error) throw e;
      }
    }
    throw new Error(error.message);
  }
  if (!data?.ok) {
    throw new Error(data?.error ?? 'delete_failed');
  }
}
