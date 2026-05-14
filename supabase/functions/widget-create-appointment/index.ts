// widget-create-appointment
//
// Customer-facing booking widget submit endpoint. Anon-callable
// (verify_jwt = true at the platform level — Supabase enforces a
// valid anon JWT before our code runs). Mirrors calendly-webhook's
// patient identity + appointment write path, with one difference:
// the widget's caller is the patient themselves, not a server-side
// integration, so we trust the patient-supplied identity (email,
// phone, name) but never trust their pricing or duration — both
// resolve from the booking-type config server-side.
//
// Order of operations:
//
//   1. Parse + validate body (locationId, serviceType, startAt, axes,
//      details). Reject on missing fields or bad shape with 400.
//   2. Resolve duration via lng_booking_type_resolve, using the same
//      axis pins the staff createAppointment uses.
//   3. lng_booking_check_conflict against the candidate slot. If the
//      slot's full, return 409 so the client can re-show the time
//      step with a "that slot just went" toast.
//   4. Patient identity at the location: email match (case-insensitive)
//      then phone match. On match, fill-blanks the missing fields.
//      On miss, insert a new patient + emit patient_events.
//   5. Insert lng_appointments with source='native', stamp
//      appointment_ref via generate_appointment_ref().
//   6. Emit patient_events (appointment_booked).
//
// Return shape: { appointmentId, appointmentRef }. The success
// screen uses the ref to render "Booking reference LAP-12345".
//
// Phase 4 will add a Stripe PaymentIntent step in front (the deposit
// flows through here as deposit_status='paid' once the webhook fires).
// For now widget-side payment is a stub and the row lands without
// any deposit fields.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';
import {
  createMeetEvent,
  getGoogleAccessToken,
} from '../_shared/googleCalendar.ts';
import { invokeAppointmentConfirmation } from '../_shared/invokeAppointmentConfirmation.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// Legacy un-suffixed key used as the live-mode fallback so
// deployments configured before the stripe.mode toggle landed
// keep working without a secrets rename.
const STRIPE_SECRET_KEY_LEGACY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const STRIPE_SECRET_KEY_LIVE = Deno.env.get('STRIPE_SECRET_KEY_LIVE') ?? STRIPE_SECRET_KEY_LEGACY;
const STRIPE_SECRET_KEY_TEST = Deno.env.get('STRIPE_SECRET_KEY_TEST') ?? '';
const STRIPE_BASE = 'https://api.stripe.com/v1';

async function resolveStripeSecret(
  supabase: ReturnType<typeof createClient>,
): Promise<string> {
  const { data } = await supabase
    .from('lng_settings')
    .select('value')
    .eq('key', 'stripe.mode')
    .is('location_id', null)
    .maybeSingle();
  const mode = (data?.value as string | undefined) === 'test' ? 'test' : 'live';
  return mode === 'test' ? STRIPE_SECRET_KEY_TEST : STRIPE_SECRET_KEY_LIVE;
}
const GOOGLE_CALENDAR_SA_EMAIL = Deno.env.get('GOOGLE_CALENDAR_SA_EMAIL') ?? '';
const GOOGLE_CALENDAR_SA_PRIVATE_KEY = Deno.env.get('GOOGLE_CALENDAR_SA_PRIVATE_KEY') ?? '';
const GOOGLE_CALENDAR_ID = Deno.env.get('GOOGLE_CALENDAR_ID') ?? '';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
};

interface SubmitBody {
  locationId: string;
  serviceType: string;
  startAt: string;
  repairVariant?: string | null;
  productKey?: string | null;
  arch?: 'upper' | 'lower' | 'both' | null;
  upgradeIds?: string[];
  /** Set when the service has a deposit and the patient has just
   *  confirmed a Stripe PaymentIntent. The endpoint verifies the PI
   *  with Stripe before populating the appointment's deposit_*
   *  fields — never trust the client to claim payment. */
  paymentIntentId?: string | null;
  /** Which customer-facing brand the booking came through:
   *  'venneir' (venneir.com Shopify) or 'denture'
   *  (denture-services.co.uk Shopify). Stored on lng_appointments.brand_id
   *  so the confirmation email + reports can differentiate. Defaults
   *  to 'venneir' for legacy callers (the standalone /book route)
   *  that don't pass a brand. */
  brandId?: 'venneir' | 'denture' | null;
  /** Customer-facing payment path picked at the summary step.
   *    'full'        → PI was created at the resolved catalogue
   *                    price; this endpoint verifies against THAT
   *                    amount and flips paid_in_full_at_booking.
   *    'on_the_day'  → nothing taken via the widget; cart settles
   *                    at the till.
   *    null / unset  → legacy deposit path: verify against
   *                    widget_deposit_pence (back-compat for any
   *                    older client still in the wild). */
  paymentMode?: 'full' | 'on_the_day' | null;
  details: {
    firstName: string;
    lastName: string;
    email: string;
    phoneCountry: string;
    phoneNumber: string;
    notes?: string;
    rememberMe?: boolean;
    agreeTerms?: boolean;
  };
}

interface DepositFields {
  deposit_status: 'paid';
  deposit_pence: number;
  deposit_currency: string;
  deposit_provider: 'stripe';
  deposit_external_id: string;
  deposit_paid_at: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' });
  }

  let body: SubmitBody;
  try {
    body = (await req.json()) as SubmitBody;
  } catch (e) {
    return jsonResponse(400, { error: 'bad_json', detail: String(e) });
  }

  const validation = validate(body);
  if (validation) return jsonResponse(400, { error: 'invalid', detail: validation });

  const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ── Resolve location ────────────────────────────────────────────
  // Phase 2 widget runs single-location (Glasgow Lounge). The client
  // sends a stub id ("loc-1") because WIDGET_LOCATIONS is hard-coded;
  // resolve it to the real locations.id server-side. Multi-location
  // (item #6 on the phase 2 punch list) flips this to a real lookup.
  const resolvedLocationId = await resolveLocationId(supabase, body.locationId);
  if (!resolvedLocationId) {
    return jsonResponse(400, { error: 'no_location_resolved' });
  }

  // ── Resolve duration from booking type config ───────────────────
  const { data: resolvedRaw, error: resolveErr } = await supabase.rpc('lng_booking_type_resolve', {
    p_service_type: body.serviceType,
    p_repair_variant: body.repairVariant ?? null,
    p_product_key: body.productKey ?? null,
    p_arch: body.arch ?? null,
  });
  if (resolveErr) {
    await logFailure('booking_type_resolve_failed', { error: resolveErr.message, body });
    return jsonResponse(500, { error: 'resolve_failed' });
  }
  const resolved = (Array.isArray(resolvedRaw) ? resolvedRaw[0] : null) as
    | { duration_default?: number }
    | null;
  if (!resolved || typeof resolved.duration_default !== 'number') {
    return jsonResponse(400, { error: 'no_booking_config' });
  }
  const durationMin = resolved.duration_default;
  const startAt = new Date(body.startAt);
  if (Number.isNaN(startAt.getTime())) {
    return jsonResponse(400, { error: 'invalid_start_at' });
  }
  // Past-time guard — refuse to book a slot at or before the current
  // server clock. Mirrors widget-reschedule-booking. Defence-in-depth:
  // the client also filters past slots out of the picker, but a
  // crafted request shouldn't be able to land an appointment in the
  // past (corrupting reports, double-booking the "next" 9am, etc).
  if (startAt.getTime() <= Date.now()) {
    return jsonResponse(400, { error: 'startAt_in_past' });
  }
  const endAt = new Date(startAt.getTime() + durationMin * 60_000);

  // ── Conflict check ──────────────────────────────────────────────
  const { data: conflictRows, error: conflictErr } = await supabase.rpc('lng_booking_check_conflict', {
    p_location_id: resolvedLocationId,
    p_service_type: body.serviceType,
    p_start_at: startAt.toISOString(),
    p_end_at: endAt.toISOString(),
    p_exclude_appointment_id: null,
    p_repair_variant: body.repairVariant ?? null,
    p_product_key: body.productKey ?? null,
    p_arch: body.arch ?? null,
  });
  if (conflictErr) {
    await logFailure('conflict_check_failed', { error: conflictErr.message, body });
    return jsonResponse(500, { error: 'conflict_check_failed' });
  }
  if (Array.isArray(conflictRows) && conflictRows.length > 0) {
    return jsonResponse(409, { error: 'slot_unavailable', conflicts: conflictRows });
  }

  // ── Payment verification ────────────────────────────────────────
  // Three modes the client can ask for. All flows resolve the
  // expected amount server-side first so a tampered client body
  // can't claim "£0 paid" on a £399 booking.
  //
  //   paymentMode === 'full'        → verify PI against the
  //     resolved catalogue price (unit_price or both_arches_price);
  //     write paid_in_full_at_booking=true.
  //   paymentMode === 'on_the_day'  → nothing collected at
  //     booking. We still take the lookup for completeness but
  //     never expect a paymentIntentId.
  //   paymentMode is null / unset   → legacy deposit path. Read
  //     widget_deposit_pence, require PI when > 0, write the
  //     deposit fields (paid_in_full_at_booking stays false).
  const paymentMode: 'full' | 'on_the_day' | 'deposit' =
    body.paymentMode === 'full'
      ? 'full'
      : body.paymentMode === 'on_the_day'
        ? 'on_the_day'
        : 'deposit';
  let depositFields: DepositFields | null = null;
  let paidInFullAtBooking = false;

  if (paymentMode === 'full') {
    if (!body.paymentIntentId) {
      return jsonResponse(400, { error: 'payment_intent_required' });
    }
    const fullPrice = await resolveFullPricePence(supabase, body);
    if (!fullPrice.ok) {
      await logFailure('full_price_resolve_failed', { code: fullPrice.code, body });
      return jsonResponse(400, { error: fullPrice.code });
    }
    const stripeSecret = await resolveStripeSecret(supabase);
    if (!stripeSecret) {
      await logFailure('stripe_secret_key_missing', { paymentIntentId: body.paymentIntentId });
      return jsonResponse(500, { error: 'stripe_not_configured' });
    }
    const verify = await verifyPaymentIntent(stripeSecret, body.paymentIntentId, fullPrice.pence);
    if (!verify.ok) {
      await logFailure('payment_intent_verify_failed', {
        paymentIntentId: body.paymentIntentId,
        reason: verify.reason,
        expectedPence: fullPrice.pence,
        body,
      });
      return jsonResponse(verify.status, { error: verify.reason });
    }
    // We still populate deposit_* columns so the existing visit
    // cart credit logic (Cart subtotal − deposit_pence) reads the
    // full amount as already-collected without a parallel code path.
    // paid_in_full_at_booking is the flag that switches staff
    // surfaces from "Deposit paid £X" to "Paid in full".
    depositFields = {
      deposit_status: 'paid',
      deposit_pence: verify.amount,
      deposit_currency: verify.currency,
      deposit_provider: 'stripe',
      deposit_external_id: body.paymentIntentId,
      deposit_paid_at: verify.paidAt,
    };
    paidInFullAtBooking = true;
  } else if (paymentMode === 'deposit') {
    // Legacy path. Read widget_deposit_pence; require + verify a PI
    // when one is configured, no-op when the service is free.
    const { data: depositRow } = await supabase
      .from('lng_widget_booking_types')
      .select('deposit_pence')
      .eq('service_type', body.serviceType)
      .maybeSingle();
    const expectedDepositPence =
      (depositRow as { deposit_pence: number } | null)?.deposit_pence ?? 0;
    if (expectedDepositPence > 0) {
      if (!body.paymentIntentId) {
        return jsonResponse(400, { error: 'payment_intent_required' });
      }
      const stripeSecret = await resolveStripeSecret(supabase);
      if (!stripeSecret) {
        await logFailure('stripe_secret_key_missing', { paymentIntentId: body.paymentIntentId });
        return jsonResponse(500, { error: 'stripe_not_configured' });
      }
      const verify = await verifyPaymentIntent(stripeSecret, body.paymentIntentId, expectedDepositPence);
      if (!verify.ok) {
        await logFailure('payment_intent_verify_failed', {
          paymentIntentId: body.paymentIntentId,
          reason: verify.reason,
          body,
        });
        return jsonResponse(verify.status, { error: verify.reason });
      }
      depositFields = {
        deposit_status: 'paid',
        deposit_pence: verify.amount,
        deposit_currency: verify.currency,
        deposit_provider: 'stripe',
        deposit_external_id: body.paymentIntentId,
        deposit_paid_at: verify.paidAt,
      };
    }
  }
  // paymentMode === 'on_the_day' falls through with no depositFields
  // and paidInFullAtBooking=false. Nothing collected by the widget.

  // ── Patient identity ────────────────────────────────────────────
  const email = body.details.email.toLowerCase().trim();
  const phone = composePhone(body.details.phoneCountry, body.details.phoneNumber);
  const firstName = body.details.firstName.trim();
  const lastName = body.details.lastName.trim();

  let patientId: string | null = null;
  if (email) {
    const { data: existing } = await supabase
      .from('patients')
      .select('id, first_name, last_name, phone')
      .eq('location_id', resolvedLocationId)
      .ilike('email', email)
      .maybeSingle();
    if (existing) {
      patientId = (existing as { id: string }).id;
      const cur = existing as { first_name: string | null; last_name: string | null; phone: string | null };
      const patch: Record<string, string> = {};
      if (cur.first_name == null && firstName) patch.first_name = firstName;
      if (cur.last_name == null && lastName) patch.last_name = lastName;
      if (cur.phone == null && phone) patch.phone = phone;
      if (Object.keys(patch).length > 0) {
        await supabase.from('patients').update(patch).eq('id', patientId);
      }
    }
  }
  if (!patientId && phone) {
    const { data: existingByPhone } = await supabase
      .from('patients')
      .select('id, first_name, last_name, email')
      .eq('location_id', resolvedLocationId)
      .eq('phone', phone)
      .maybeSingle();
    if (existingByPhone) {
      patientId = (existingByPhone as { id: string }).id;
      const cur = existingByPhone as { first_name: string | null; last_name: string | null; email: string | null };
      const patch: Record<string, string> = {};
      if (cur.first_name == null && firstName) patch.first_name = firstName;
      if (cur.last_name == null && lastName) patch.last_name = lastName;
      if (cur.email == null && email) patch.email = email;
      if (Object.keys(patch).length > 0) {
        await supabase.from('patients').update(patch).eq('id', patientId);
      }
    }
  }
  if (!patientId) {
    const accountId = await resolveDefaultAccountId(supabase, resolvedLocationId);
    const { data: created, error: createErr } = await supabase
      .from('patients')
      .insert({
        account_id: accountId,
        location_id: resolvedLocationId,
        first_name: firstName || 'Patient',
        last_name: lastName,
        email: email || null,
        phone: phone || null,
      })
      .select('id')
      .single();
    if (createErr || !created) {
      await logFailure('patient_create_failed', { error: createErr?.message, body });
      return jsonResponse(500, { error: 'patient_create_failed' });
    }
    patientId = (created as { id: string }).id;
    await supabase.from('patient_events').insert({
      patient_id: patientId,
      event_type: 'patient_created',
      payload: { source: 'widget', email: email || null, phone: phone || null },
    });
  }

  // ── Generate appointment_ref ────────────────────────────────────
  const { data: refRaw, error: refErr } = await supabase.rpc('generate_appointment_ref');
  if (refErr) {
    await logFailure('appointment_ref_failed', { error: refErr.message, patientId });
    return jsonResponse(500, { error: 'ref_failed' });
  }
  const appointmentRef = typeof refRaw === 'string' ? refRaw : null;

  // ── Insert appointment ──────────────────────────────────────────
  const eventLabel = labelForService(body.serviceType);
  const { data: appt, error: apptErr } = await supabase
    .from('lng_appointments')
    .insert({
      patient_id: patientId,
      location_id: resolvedLocationId,
      source: 'native',
      start_at: startAt.toISOString(),
      end_at: endAt.toISOString(),
      status: 'booked',
      service_type: body.serviceType,
      event_type_label: eventLabel,
      appointment_ref: appointmentRef,
      notes: body.details.notes?.trim() || null,
      repair_variant: body.repairVariant ?? null,
      product_key: body.productKey ?? null,
      arch: body.arch ?? null,
      // Whitelist guard: the column accepts any text but we only
      // recognise these two values. Anything else (a typo, a
      // future brand the email function hasn't been taught about)
      // falls back to 'venneir' so emails still send rather than
      // 500-ing the booking write.
      brand_id: body.brandId === 'denture' ? 'denture' : 'venneir',
      paid_in_full_at_booking: paidInFullAtBooking,
      ...(depositFields ?? {}),
    })
    .select('id, appointment_ref, manage_token')
    .single();
  if (apptErr || !appt) {
    await logFailure('appointment_insert_failed', { error: apptErr?.message, patientId });
    return jsonResponse(500, { error: 'appointment_insert_failed' });
  }
  const apptRow = appt as { id: string; appointment_ref: string | null; manage_token: string | null };
  const appointmentId = apptRow.id;
  const manageToken = apptRow.manage_token;

  // ── Google Meet (virtual impression only) ──────────────────────
  // Create the calendar event inline so the join_url is present before
  // the confirmation email fires. Failure is best-effort: the booking
  // succeeds even if Meet creation fails; the failure logs to
  // lng_system_failures via the shared helper throw path.
  if (body.serviceType === 'virtual_impression_appointment') {
    if (GOOGLE_CALENDAR_SA_EMAIL && GOOGLE_CALENDAR_SA_PRIVATE_KEY && GOOGLE_CALENDAR_ID) {
      try {
        const token = await getGoogleAccessToken(
          GOOGLE_CALENDAR_SA_EMAIL,
          GOOGLE_CALENDAR_SA_PRIVATE_KEY,
        );
        const { hangoutLink, eventId } = await createMeetEvent({
          accessToken: token,
          calendarId: GOOGLE_CALENDAR_ID,
          appointmentId,
          startAt: startAt.toISOString(),
          endAt: endAt.toISOString(),
          summary: eventLabel,
        });
        await supabase
          .from('lng_appointments')
          .update({ join_url: hangoutLink, google_calendar_event_id: eventId })
          .eq('id', appointmentId);
      } catch (e) {
        await logFailure('google_meet_create_failed', {
          appointmentId,
          error: e instanceof Error ? e.message : String(e),
        }, 'error');
      }
    } else {
      await logFailure('google_calendar_secrets_missing', { appointmentId }, 'warning');
    }
  }

  await supabase.from('patient_events').insert({
    patient_id: patientId,
    event_type: 'appointment_booked',
    payload: {
      source: 'widget',
      appointment_id: appointmentId,
      appointment_ref: appointmentRef,
      service_type: body.serviceType,
      repair_variant: body.repairVariant ?? null,
      product_key: body.productKey ?? null,
      arch: body.arch ?? null,
      start_at: startAt.toISOString(),
      end_at: endAt.toISOString(),
      duration_minutes: durationMin,
      upgrade_ids: body.upgradeIds ?? [],
    },
  });

  // Mirror calendly-webhook's deposit_paid event so the patient
  // timeline shows the £-charge alongside the booking, and reports
  // can find widget deposits without a special-case query.
  if (depositFields) {
    await supabase.from('patient_events').insert({
      patient_id: patientId,
      event_type: 'deposit_paid',
      payload: {
        appointment_id: appointmentId,
        appointment_ref: appointmentRef,
        amount_pence: depositFields.deposit_pence,
        currency: depositFields.deposit_currency,
        provider: depositFields.deposit_provider,
        external_id: depositFields.deposit_external_id,
        source: 'widget',
      },
    });
  }

  // ── Confirmation email ─────────────────────────────────────────
  // Fire-and-forget invocation of send-appointment-confirmation via
  // the shared helper. The helper sends the service-role key both
  // as the standard Bearer (so the platform's verify_jwt check
  // passes) AND as a custom `X-Lng-Internal-Token` header which the
  // receiver compares against its own SUPABASE_SERVICE_ROLE_KEY env
  // var. Going through the custom header avoids the Bearer-string
  // translation the platform now performs on the new key model,
  // which silently broke the previous supabase.functions.invoke
  // path. Email failures (paused template, missing RESEND_API_KEY,
  // etc) are logged to lng_system_failures by the email function
  // itself; we additionally log here if the invoke transport fails
  // so the booking still succeeds even if the email pipe is down.
  // We log the actual HTTP status + body on failure so future
  // regressions are diagnosable from lng_system_failures alone,
  // without re-deploying with debug code.
  try {
    const emailResult = await invokeAppointmentConfirmation({ appointmentId });
    if (!emailResult.ok) {
      await logFailure(
        'confirmation_invoke_failed',
        {
          appointmentId,
          status: emailResult.status,
          response: emailResult.body,
          error: emailResult.error,
        },
        'warning',
      );
    }
  } catch (e) {
    await logFailure('confirmation_invoke_threw', {
      appointmentId,
      error: e instanceof Error ? e.message : String(e),
    }, 'warning');
  }

  return jsonResponse(200, {
    appointmentId,
    appointmentRef,
    manageToken,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function validate(body: SubmitBody): string | null {
  if (!body || typeof body !== 'object') return 'body_not_object';
  if (typeof body.locationId !== 'string' || !body.locationId) return 'locationId_missing';
  if (typeof body.serviceType !== 'string' || !body.serviceType) return 'serviceType_missing';
  if (typeof body.startAt !== 'string' || !body.startAt) return 'startAt_missing';
  if (!body.details || typeof body.details !== 'object') return 'details_missing';
  if (typeof body.details.firstName !== 'string' || !body.details.firstName.trim()) {
    return 'firstName_missing';
  }
  if (typeof body.details.lastName !== 'string' || !body.details.lastName.trim()) {
    return 'lastName_missing';
  }
  if (typeof body.details.email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.details.email)) {
    return 'email_invalid';
  }
  if (typeof body.details.phoneNumber !== 'string' || body.details.phoneNumber.replace(/\D/g, '').length < 6) {
    return 'phone_invalid';
  }
  if (body.arch && !['upper', 'lower', 'both'].includes(body.arch)) return 'arch_invalid';
  return null;
}

const COUNTRY_DIAL: Record<string, string> = {
  GB: '+44',
  IE: '+353',
  US: '+1',
  CA: '+1',
  AU: '+61',
};

function composePhone(country: string, local: string): string {
  const dial = COUNTRY_DIAL[country] ?? '';
  const digits = local.replace(/\D/g, '');
  if (!digits) return '';
  // Strip a leading 0 — UK / IE local convention.
  const trimmed = digits.startsWith('0') ? digits.slice(1) : digits;
  return `${dial}${trimmed}`;
}

const SERVICE_LABELS: Record<string, string> = {
  click_in_veneers: 'Click-in veneers',
  same_day_appliance: 'Same-day appliance',
  denture_repair: 'Denture repair',
  whitening_kit: 'Whitening kit',
  virtual_impression_appointment: 'Virtual impression appointment',
};
function labelForService(service: string): string {
  return SERVICE_LABELS[service] ?? 'Appointment';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveLocationId(
  supabase: SupabaseClient,
  candidate: string,
): Promise<string | null> {
  // If the client sent a real UUID, take it at face value (phase 6
  // multi-location). Otherwise resolve to the single Venneir Lounge
  // location — same lookup the calendly-webhook uses for its default
  // location.
  if (UUID_RE.test(candidate)) {
    const { data } = await supabase
      .from('locations')
      .select('id')
      .eq('id', candidate)
      .maybeSingle();
    if (data) return (data as { id: string }).id;
  }
  const { data: fallback } = await supabase
    .from('locations')
    .select('id')
    .eq('type', 'lab')
    .eq('is_venneir', true)
    .order('name', { ascending: true })
    .limit(1)
    .maybeSingle();
  return fallback ? (fallback as { id: string }).id : null;
}

async function resolveDefaultAccountId(
  supabase: SupabaseClient,
  locationId: string,
): Promise<string> {
  // Same approach as calendly-webhook: pick the longest-tenured active
  // member of the location as the default 'owner' for widget patients.
  const { data: rows, error } = await supabase
    .from('location_members')
    .select('account_id, joined_at')
    .eq('location_id', locationId)
    .is('removed_at', null)
    .order('joined_at', { ascending: true })
    .limit(1);
  if (error || !rows || rows.length === 0) {
    throw new Error(`no active location_members for location ${locationId}`);
  }
  return (rows[0] as { account_id: string }).account_id;
}

type VerifyResult =
  | {
      ok: true;
      amount: number;
      currency: string;
      paidAt: string;
    }
  | {
      ok: false;
      status: number;
      reason: string;
    };

// Mirror of resolveFullPricePence in widget-create-payment-intent —
// both endpoints must agree on the expected amount, so this
// function is duplicated rather than imported (Deno function bundles
// don't share modules across function dirs in the deploy pipeline).
async function resolveFullPricePence(
  supabase: SupabaseClient,
  body: SubmitBody,
): Promise<{ ok: true; pence: number } | { ok: false; code: string }> {
  let q = supabase
    .from('lwo_catalogue')
    .select('unit_price, both_arches_price, arch_match')
    .eq('service_type', body.serviceType)
    .eq('active', true);
  if (body.productKey) q = q.eq('product_key', body.productKey);
  if (body.repairVariant) q = q.eq('repair_variant', body.repairVariant);
  const { data, error } = await q.limit(1);
  if (error) return { ok: false, code: 'catalogue_lookup_failed' };
  const row = (data && data.length > 0 ? data[0] : null) as
    | {
        unit_price: number | string | null;
        both_arches_price: number | string | null;
        arch_match: 'any' | 'single' | 'both' | null;
      }
    | null;
  if (!row) return { ok: false, code: 'no_catalogue_row' };
  const archMatch = row.arch_match ?? 'any';
  const useBoth =
    archMatch === 'single' &&
    body.arch === 'both' &&
    row.both_arches_price !== null;
  const decimal = useBoth ? row.both_arches_price : row.unit_price;
  if (decimal === null || decimal === undefined) {
    return { ok: false, code: 'no_price_resolved' };
  }
  const pence = Math.round(Number(decimal) * 100);
  if (!Number.isFinite(pence) || pence <= 0) {
    return { ok: false, code: 'no_price_resolved' };
  }
  return { ok: true, pence };
}

async function verifyPaymentIntent(
  stripeSecret: string,
  paymentIntentId: string,
  expectedAmount: number,
): Promise<VerifyResult> {
  const r = await fetch(`${STRIPE_BASE}/payment_intents/${encodeURIComponent(paymentIntentId)}`, {
    headers: {
      Authorization: `Bearer ${stripeSecret}`,
      'Stripe-Version': '2024-10-28.acacia',
    },
  });
  if (!r.ok) {
    return { ok: false, status: 502, reason: 'payment_intent_fetch_failed' };
  }
  const pi = (await r.json().catch(() => null)) as
    | {
        id?: string;
        status?: string;
        amount?: number;
        amount_received?: number;
        currency?: string;
        created?: number;
        metadata?: Record<string, string | undefined>;
      }
    | null;
  if (!pi) return { ok: false, status: 502, reason: 'payment_intent_unparseable' };
  if (pi.status !== 'succeeded') {
    return { ok: false, status: 402, reason: 'payment_not_succeeded' };
  }
  const amount = typeof pi.amount === 'number' ? pi.amount : 0;
  if (amount !== expectedAmount) {
    return { ok: false, status: 400, reason: 'payment_amount_mismatch' };
  }
  if ((pi.currency ?? '').toLowerCase() !== 'gbp') {
    return { ok: false, status: 400, reason: 'payment_currency_mismatch' };
  }
  // Defence-in-depth: only accept PIs minted by the widget flow.
  // A PI from another flow (terminal, future channels) shouldn't be
  // replayable here.
  if (pi.metadata?.source !== 'widget') {
    return { ok: false, status: 400, reason: 'payment_metadata_mismatch' };
  }
  const paidAt = pi.created
    ? new Date(pi.created * 1000).toISOString()
    : new Date().toISOString();
  return {
    ok: true,
    amount,
    currency: (pi.currency ?? 'gbp').toUpperCase(),
    paidAt,
  };
}

async function logFailure(
  message: string,
  context: Record<string, unknown>,
  severity: 'info' | 'warning' | 'error' | 'critical' = 'error',
) {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await supabase.from('lng_system_failures').insert({
      source: 'widget-create-appointment',
      severity,
      message,
      context,
    });
  } catch {
    // best-effort
  }
}
