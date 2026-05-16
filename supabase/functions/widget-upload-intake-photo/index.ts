// widget-upload-intake-photo
//
// Click-in veneers patients can upload up to three pre-visit
// photos (front smile / left / right) from the Success step of
// the booking widget. Storage lives in the private
// `lng-booking-intake-photos` bucket; an index row in
// `lng_booking_intake_photos` keys the photo to an appointment +
// kind so the staff Appointment Detail can fetch a signed URL on
// demand.
//
// Auth model: anon-callable. The (appointment_id, manage_token)
// pair IS the auth — the manage_token is the same unguessable
// 122-bit UUID we hand the patient in their booking confirmation,
// so only the booking owner (or whoever has access to that email)
// can attach photos. No way to enumerate.
//
// Idempotency: re-uploading the same kind for the same appointment
// replaces the previous file in Storage and updates the row in
// place — `(appointment_id, kind)` is unique.
//
// Product gate: appointments are only allowed to attach intake
// photos when their (service_type, product_key) has
// request_smile_photos = true in lng_product_widget_config.
// Previously this was hardcoded to service_type='click_in_veneers';
// the admin-controlled toggle generalises it so any product can
// opt in. Missing config row defaults to false (reject).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
};

const BUCKET = 'lng-booking-intake-photos';
const ALLOWED_KINDS = new Set(['front', 'left', 'right']);
const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);
const MAX_BYTES = 12 * 1024 * 1024; // 12 MB
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    return jsonResponse(400, { error: 'bad_form_data', detail: String(e) });
  }

  const appointmentId = String(form.get('appointment_id') ?? '').trim();
  const manageToken = String(form.get('manage_token') ?? '').trim();
  const kind = String(form.get('kind') ?? '').trim();
  const file = form.get('file');

  if (!UUID_RE.test(appointmentId)) {
    return jsonResponse(400, { error: 'invalid_appointment_id' });
  }
  if (!UUID_RE.test(manageToken)) {
    return jsonResponse(400, { error: 'invalid_manage_token' });
  }
  if (!ALLOWED_KINDS.has(kind)) {
    return jsonResponse(400, { error: 'invalid_kind' });
  }
  if (!(file instanceof File)) {
    return jsonResponse(400, { error: 'missing_file' });
  }
  if (!ALLOWED_MIME.has(file.type.toLowerCase())) {
    return jsonResponse(400, { error: 'unsupported_mime', mime: file.type });
  }
  if (file.size <= 0 || file.size > MAX_BYTES) {
    return jsonResponse(400, { error: 'invalid_size', size: file.size });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Verify appointment + token in a single read; product gate
  // requires the (service_type, product_key) pair so we fetch both.
  const { data: appt, error: apptErr } = await supabase
    .from('lng_appointments')
    .select('id, service_type, product_key, manage_token, status')
    .eq('id', appointmentId)
    .maybeSingle();
  if (apptErr) {
    return jsonResponse(500, { error: 'appointment_lookup_failed', detail: apptErr.message });
  }
  if (!appt) {
    return jsonResponse(404, { error: 'appointment_not_found' });
  }
  if (appt.manage_token !== manageToken) {
    return jsonResponse(403, { error: 'token_mismatch' });
  }
  if (appt.status === 'cancelled') {
    return jsonResponse(409, { error: 'appointment_cancelled' });
  }

  // Product gate: read the per-product widget config for this
  // appointment's (service_type, product_key). Service role bypasses
  // RLS so we read the underlying table directly. A missing row
  // (the admin hasn't touched this product yet) means request_smile_photos
  // defaults to false → reject.
  if (!appt.product_key) {
    return jsonResponse(400, { error: 'service_not_supported' });
  }
  const { data: cfg, error: cfgErr } = await supabase
    .from('lng_product_widget_config')
    .select('request_smile_photos')
    .eq('service_type', appt.service_type)
    .eq('product_key', appt.product_key)
    .maybeSingle();
  if (cfgErr) {
    return jsonResponse(500, { error: 'config_lookup_failed', detail: cfgErr.message });
  }
  if (!cfg || cfg.request_smile_photos !== true) {
    return jsonResponse(400, { error: 'service_not_supported' });
  }

  // Storage path: `<appointment_id>/<kind>.<ext>`. One file per
  // angle per booking; replacing reuses the same key so the prior
  // bytes are overwritten in place.
  const ext = mimeToExt(file.type);
  const filePath = `${appointmentId}/${kind}.${ext}`;

  const bytes = new Uint8Array(await file.arrayBuffer());
  const { error: uploadErr } = await supabase
    .storage
    .from(BUCKET)
    .upload(filePath, bytes, {
      contentType: file.type,
      upsert: true,
      cacheControl: '3600',
    });
  if (uploadErr) {
    return jsonResponse(500, { error: 'storage_upload_failed', detail: uploadErr.message });
  }

  // Upsert the index row. `(appointment_id, kind)` is unique.
  const { error: upsertErr } = await supabase
    .from('lng_booking_intake_photos')
    .upsert(
      {
        appointment_id: appointmentId,
        kind,
        file_path: filePath,
        mime_type: file.type,
        size_bytes: file.size,
        uploaded_at: new Date().toISOString(),
      },
      { onConflict: 'appointment_id,kind' },
    );
  if (upsertErr) {
    return jsonResponse(500, { error: 'index_upsert_failed', detail: upsertErr.message });
  }

  return jsonResponse(200, { ok: true, kind, filePath, sizeBytes: file.size });
});

function mimeToExt(mime: string): string {
  const lower = mime.toLowerCase();
  if (lower === 'image/jpeg' || lower === 'image/jpg') return 'jpg';
  if (lower === 'image/png') return 'png';
  if (lower === 'image/webp') return 'webp';
  if (lower === 'image/heic') return 'heic';
  if (lower === 'image/heif') return 'heif';
  return 'bin';
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
