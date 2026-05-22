// staff-upload-intake-photo
//
// Staff-side sibling of widget-upload-intake-photo. Reception, the
// floor team, customer service, admin — anyone with a Lounge staff
// account can upload a pre-visit smile photo (front / left / right)
// on behalf of the patient when they haven't done it themselves
// from the booking-confirmation page. Same storage bucket
// (`lng-booking-intake-photos`), same index table
// (`lng_booking_intake_photos`), same `(appointment_id, kind)` key,
// so the staff Appointment Detail surfaces these photos identically
// to widget-uploaded ones.
//
// Auth: signed-in staff JWT. Any authenticated staff account passes;
// no role gate — the user explicitly asked for "all roles" to be
// able to do this. (Anon / patient-side tokens are rejected.)
//
// Product gate: matches the widget function — the appointment's
// (service_type, product_key) must have request_smile_photos = true
// in lng_product_widget_config. The SmilePhotosCard front-end is
// already gated on the same flag, so this is the belt-and-braces
// check: a forged direct call to the function can't bypass the
// service-type rule.
//
// Idempotency: re-uploading the same kind replaces the previous
// bytes in storage and updates the index row in place.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

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

  // Verify the caller is an authenticated staff member.
  const userJwt = req.headers.get('authorization') ?? '';
  if (!userJwt.startsWith('Bearer ')) {
    return jsonResponse(401, { error: 'not_signed_in' });
  }
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: userJwt } },
  });
  const { data: who } = await userClient.auth.getUser();
  if (!who?.user) {
    return jsonResponse(401, { error: 'not_signed_in' });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    return jsonResponse(400, { error: 'bad_form_data', detail: String(e) });
  }

  const appointmentId = String(form.get('appointment_id') ?? '').trim();
  const kind = String(form.get('kind') ?? '').trim();
  const file = form.get('file');

  if (!UUID_RE.test(appointmentId)) {
    return jsonResponse(400, { error: 'invalid_appointment_id' });
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

  // Service role bypasses RLS for the storage + index writes —
  // staff JWT is the auth gate, not RLS.
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Verify the appointment exists, isn't cancelled, and has a
  // request_smile_photos config — same gate as widget-upload-intake-photo.
  const { data: appt, error: apptErr } = await admin
    .from('lng_appointments')
    .select('id, service_type, product_key, status')
    .eq('id', appointmentId)
    .maybeSingle();
  if (apptErr) {
    return jsonResponse(500, { error: 'appointment_lookup_failed', detail: apptErr.message });
  }
  if (!appt) {
    return jsonResponse(404, { error: 'appointment_not_found' });
  }
  if (appt.status === 'cancelled') {
    return jsonResponse(409, { error: 'appointment_cancelled' });
  }
  // Mirror configFor()'s lookup on the client (productWidgetConfig.ts):
  //   1. If the appointment carries a product_key, do a direct
  //      (service_type, product_key) lookup.
  //   2. If product_key is NULL (single-product services like
  //      click_in_veneers, where the widget never pins the product
  //      axis on the appointment row), fall back to "the unique row
  //      for this service_type" if exactly one config row exists.
  // Keeping these in sync means the UI and function never disagree on
  // whether a service supports smile photos.
  let cfg: { request_smile_photos: boolean } | null = null;
  if (appt.product_key) {
    const { data, error: cfgErr } = await admin
      .from('lng_product_widget_config')
      .select('request_smile_photos')
      .eq('service_type', appt.service_type)
      .eq('product_key', appt.product_key)
      .maybeSingle();
    if (cfgErr) {
      return jsonResponse(500, { error: 'config_lookup_failed', detail: cfgErr.message });
    }
    cfg = data;
  } else {
    const { data, error: cfgErr } = await admin
      .from('lng_product_widget_config')
      .select('request_smile_photos')
      .eq('service_type', appt.service_type);
    if (cfgErr) {
      return jsonResponse(500, { error: 'config_lookup_failed', detail: cfgErr.message });
    }
    if (data && data.length === 1) cfg = data[0];
  }
  if (!cfg || cfg.request_smile_photos !== true) {
    return jsonResponse(400, { error: 'service_not_supported' });
  }

  const ext = mimeToExt(file.type);
  const filePath = `${appointmentId}/${kind}.${ext}`;

  const bytes = new Uint8Array(await file.arrayBuffer());
  const { error: uploadErr } = await admin
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

  // Look up the actor account id so the index row carries who
  // uploaded — useful for audit + for the timeline if we surface
  // staff-uploaded vs patient-uploaded later.
  const { data: actorRow } = await admin
    .from('accounts')
    .select('id')
    .eq('auth_user_id', who.user.id)
    .maybeSingle();
  const uploadedBy = (actorRow as { id: string } | null)?.id ?? null;

  const { error: upsertErr } = await admin
    .from('lng_booking_intake_photos')
    .upsert(
      {
        appointment_id: appointmentId,
        kind,
        file_path: filePath,
        mime_type: file.type,
        size_bytes: file.size,
        uploaded_at: new Date().toISOString(),
        uploaded_by_account_id: uploadedBy,
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
