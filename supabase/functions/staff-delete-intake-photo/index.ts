// staff-delete-intake-photo
//
// Staff-side delete for a pre-visit smile photo (front / left / right)
// captured against an appointment. Removes both the storage object
// in `lng-booking-intake-photos` and the matching index row in
// `lng_booking_intake_photos`.
//
// Auth: signed-in staff JWT. Any authenticated staff account passes;
// no role gate (matches staff-upload-intake-photo).
//
// Idempotent: if the row doesn't exist, returns ok=true with
// already_absent=true so the UI can refresh cleanly after a double-
// click race. Storage removal is best-effort — a missing object
// after the row is gone is treated as success.

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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' });
  }

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

  let body: { appointment_id?: unknown; kind?: unknown };
  try {
    body = await req.json();
  } catch (e) {
    return jsonResponse(400, { error: 'bad_json', detail: String(e) });
  }

  const appointmentId = String(body.appointment_id ?? '').trim();
  const kind = String(body.kind ?? '').trim();

  if (!UUID_RE.test(appointmentId)) {
    return jsonResponse(400, { error: 'invalid_appointment_id' });
  }
  if (!ALLOWED_KINDS.has(kind)) {
    return jsonResponse(400, { error: 'invalid_kind' });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Pull the row so we know which storage path to remove. If the row
  // is already gone, treat as success — the desired end state is
  // "no photo for this slot".
  const { data: row, error: rowErr } = await admin
    .from('lng_booking_intake_photos')
    .select('file_path')
    .eq('appointment_id', appointmentId)
    .eq('kind', kind)
    .maybeSingle();
  if (rowErr) {
    return jsonResponse(500, { error: 'row_lookup_failed', detail: rowErr.message });
  }
  if (!row) {
    return jsonResponse(200, { ok: true, already_absent: true });
  }

  const filePath = (row as { file_path: string }).file_path;

  // Storage removal is best-effort. A missing object after the row
  // is gone is still a success — the slot is empty from the staff
  // member's perspective.
  const { error: storageErr } = await admin.storage.from(BUCKET).remove([filePath]);
  if (storageErr) {
    // Log via the response but don't bail — we still want the index
    // row gone so the slot reads as empty. The next upload will
    // upsert the storage object back into place anyway.
    console.error('[staff-delete-intake-photo] storage remove failed', storageErr);
  }

  const { error: deleteErr } = await admin
    .from('lng_booking_intake_photos')
    .delete()
    .eq('appointment_id', appointmentId)
    .eq('kind', kind);
  if (deleteErr) {
    return jsonResponse(500, { error: 'index_delete_failed', detail: deleteErr.message });
  }

  return jsonResponse(200, { ok: true, kind, filePath });
});

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
