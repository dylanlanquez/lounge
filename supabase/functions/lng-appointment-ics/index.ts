// lng-appointment-ics
//
// Public token-gated endpoint that returns the .ics file for a single
// appointment. Wires up the "Add to calendar" button in every
// appointment email — when the customer taps it on iOS Mail or
// Android Gmail, the device hands the response to the native Calendar
// app and the event drops in cleanly.
//
// Auth: the appointment's manage_token (the same token that powers
// {{manageUrl}} in the customer email). Tokens are issued per-row and
// rotate when the appointment is cancelled, so a leaked link only
// works while the booking is live.
//
// Request:
//   GET /functions/v1/lng-appointment-ics?id=<uuid>&token=<manage_token>
//
// Response:
//   200 text/calendar; charset=utf-8  + Content-Disposition attachment
//   401 invalid_token
//   404 appointment_not_found
//
// Deploys with --no-verify-jwt so customers don't need a Supabase
// session to download their own calendar invite.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';
import { buildIcs, icsUid } from '../_shared/icsBuilder.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ORGANIZER_EMAIL =
  Deno.env.get('RESEND_REPLY_TO_BOOKING') ?? 'lounge@venneir.com';
const ORGANIZER_NAME = 'Venneir Lounge';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders() });
  }
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders() });
  }

  const url = new URL(req.url);
  const appointmentId = url.searchParams.get('id') ?? '';
  const token = url.searchParams.get('token') ?? '';

  if (!appointmentId || !token) {
    return text(400, 'id and token query parameters required');
  }

  const admin: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Hydrate the appointment + linked patient + location in one round
  // trip. manage_token must match the query parameter; mismatch returns
  // 401 so a guessed/expired link doesn't yield clinic addresses.
  const { data: apt, error: aptErr } = await admin
    .from('lng_appointments')
    .select(
      'id, patient_id, location_id, start_at, end_at, service_type, event_type_label, appointment_ref, join_url, manage_token, status',
    )
    .eq('id', appointmentId)
    .maybeSingle();
  if (aptErr) return text(500, 'appointment lookup failed');
  if (!apt) return text(404, 'appointment_not_found');
  if (!apt.manage_token || apt.manage_token !== token) {
    return text(401, 'invalid_token');
  }

  const [{ data: patient }, { data: location }] = await Promise.all([
    admin
      .from('patients')
      .select('first_name, last_name, email')
      .eq('id', apt.patient_id)
      .maybeSingle(),
    admin
      .from('locations')
      .select('name, address, city, postcode')
      .eq('id', apt.location_id)
      .maybeSingle(),
  ]);

  const summary = summaryLine(apt, location);
  const locationLine = locationFreeform(location);
  const description = descriptionLine(apt, location);

  // SEQUENCE — bump on every fetch so a re-import after a change picks
  // up the latest state. lng_appointments doesn't track invite revisions
  // so we use the row's updated_at-ish signal (start_at change history
  // isn't stored either); a constant 0 is fine here because cancellations
  // bump via the CANCEL invite emailed at send time.
  const status: 'CONFIRMED' | 'CANCELLED' =
    apt.status === 'cancelled' || apt.status === 'rescheduled' ? 'CANCELLED' : 'CONFIRMED';

  const ics = buildIcs({
    method: status === 'CANCELLED' ? 'CANCEL' : 'REQUEST',
    uid: icsUid(apt.id),
    sequence: 0,
    summary,
    description,
    location: locationLine,
    startAt: apt.start_at as string,
    endAt: apt.end_at as string,
    organizerEmail: ORGANIZER_EMAIL,
    organizerName: ORGANIZER_NAME,
    attendeeEmail: (patient?.email as string | null) ?? '',
    attendeeName: fullName(patient),
    url: (apt.join_url as string | null) ?? null,
    status,
  });

  const filename = `venneir-appointment-${apt.appointment_ref ?? apt.id}.ics`;
  return new Response(ics, {
    status: 200,
    headers: {
      ...corsHeaders(),
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      // Short cache so a follow-up tap from the same device doesn't
      // hammer the function; long enough that a typo'd token isn't
      // pinned in any intermediary cache.
      'Cache-Control': 'private, max-age=60',
    },
  });
});

function summaryLine(
  apt: Record<string, unknown>,
  location: Record<string, unknown> | null,
): string {
  const eventLabel =
    typeof apt.event_type_label === 'string' && apt.event_type_label.trim().length > 0
      ? apt.event_type_label
      : typeof apt.service_type === 'string' && apt.service_type.trim().length > 0
        ? humaniseSlug(apt.service_type)
        : 'Appointment';
  const locName =
    (typeof location?.name === 'string' && location.name.trim()) || 'Venneir Lounge';
  return `${eventLabel} · ${locName}`;
}

function descriptionLine(
  apt: Record<string, unknown>,
  _location: Record<string, unknown> | null,
): string {
  const ref =
    typeof apt.appointment_ref === 'string' && apt.appointment_ref.length > 0
      ? `Reference: ${apt.appointment_ref}\n`
      : '';
  const join =
    typeof apt.join_url === 'string' && apt.join_url.length > 0
      ? `Join: ${apt.join_url}\n`
      : '';
  return `${ref}${join}Reply to this email if you need to make a change.`;
}

function locationFreeform(location: Record<string, unknown> | null): string {
  if (!location) return 'Venneir Lounge';
  const parts = [
    location.name as string | undefined,
    location.address as string | undefined,
    location.city as string | undefined,
    location.postcode as string | undefined,
  ]
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter((p): p is string => !!p && p.length > 0);
  return parts.length > 0 ? parts.join(', ') : 'Venneir Lounge';
}

function fullName(p: Record<string, unknown> | null): string {
  const fn = typeof p?.first_name === 'string' ? p.first_name.trim() : '';
  const ln = typeof p?.last_name === 'string' ? p.last_name.trim() : '';
  return `${fn} ${ln}`.trim() || 'Patient';
}

function humaniseSlug(slug: string): string {
  return slug.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function text(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
