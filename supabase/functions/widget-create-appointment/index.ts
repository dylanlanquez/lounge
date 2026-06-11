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
import { getValidAccessToken, type MeetHostRow } from '../_shared/meetHostToken.ts';
import { invokeAppointmentConfirmation } from '../_shared/invokeAppointmentConfirmation.ts';
import { resolveWidgetFullPricePence } from '../_shared/widgetFullPrice.ts';
import { isPlaceholderName } from '../_shared/patientName.ts';
import { isPlaceholderPhone, usablePhone } from '../_shared/phone.ts';

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

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
};

interface SubmitRepairItemBody {
  catalogueId: string;
  code: string;
  repairVariant: string;
  name: string;
  unitLabel: string | null;
  arch: 'upper' | 'lower' | 'both';
  quantity: number;
  unitPricePence: number;
  bothArchesPricePence: number | null;
  lineTotalPence: number;
}

// One product in a Checkpoint booking's bag. Prices are NOT carried —
// they're re-resolved server-side against lwo_catalogue so a tampered
// client can't set its own price. upgradeIds re-resolve against
// lng_widget_upgrades.
interface SubmitItem {
  catalogueId?: string | null;
  serviceType?: string | null;
  productKey?: string | null;
  arch?: 'upper' | 'lower' | 'both' | null;
  shade?: string | null;
  /** Retainer thickness ('1mm' | '1.5mm'). Only set for retainer items on
   *  impression / virtual impression bookings. Persisted to
   *  lng_appointment_items.thickness. */
  thickness?: string | null;
  quantity?: number | null;
  upgradeIds?: string[];
}

interface SubmitBody {
  locationId: string;
  serviceType: string;
  startAt: string;
  repairVariant?: string | null;
  productKey?: string | null;
  arch?: 'upper' | 'lower' | 'both' | null;
  /** Quantity of the primary product. Only the Checkpoint booker sends
   *  this today (the customer widget books a single unit). Persisted to
   *  lng_appointments.quantity; must be an integer > 0 when present. */
  quantity?: number | null;
  /** Shade picked for the primary product (e.g. "BL1" / "A1" / "A2").
   *  Only meaningful for click_in_veneers, mirroring the arrival
   *  CataloguePicker. Free-text snapshot persisted to
   *  lng_appointments.shade. */
  shade?: string | null;
  /** Retainer thickness ('1mm' | '1.5mm') for the primary product. Only the
   *  Checkpoint booker sends this, and only for a retainer on an impression /
   *  virtual impression booking. Persisted to lng_appointments.thickness. */
  thickness?: string | null;
  /** Checkpoint-only multi-item bag. When source='checkpoint' and this
   *  is present, each item is re-resolved server-side against
   *  lwo_catalogue / lng_widget_upgrades and written to
   *  lng_appointment_items (+ lng_appointment_item_upgrades). The
   *  appointment's primary product_key/arch/quantity/shade are taken
   *  from the first item. The customer widget never sends this. */
  items?: SubmitItem[];
  /** Checkpoint-only. When true (same-day upgrades only), the appliance
   *  is booked free of charge — zeroed at the till and flagged on the
   *  Lounge booking. Requires freeUpgradeReason. */
  freeUpgrade?: boolean | null;
  freeUpgradeReason?: string | null;
  upgradeIds?: string[];
  /** Denture-repair line items the patient piled into the cart on
   *  the per-arch repair step. Each line carries the catalogue id +
   *  code + arch + quantity. We re-resolve every line server-side
   *  against lwo_catalogue before writing to lng_appointment_repair_items
   *  so a tampered client body can't claim £0 for an expensive repair. */
  repairItems?: SubmitRepairItemBody[];
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
  /** Customer-facing payment path. 'full' charges the resolved
   *  catalogue price; 'deposit' charges widget_deposit_pence (the
   *  legacy "£25 today, balance on the day" path); 'on_the_day'
   *  takes nothing and lets the cart settle at the till; null is
   *  the legacy free-booking / pre-mode-flag path which falls back
   *  to the deposit pathway when widget_deposit_pence > 0. */
  paymentMode?: 'full' | 'deposit' | 'on_the_day' | null;
  /** Origin of this booking call. 'widget' (default) is the public
   *  embed used on venneir.com / denture-services.co.uk. 'checkpoint'
   *  is the staff-side booker built into Checkpoint's ScanView: it
   *  pre-populates patient identity from the Shopify order in scope,
   *  always books as paymentMode='on_the_day', and writes
   *  lng_appointments.source='manual' since a staff member is
   *  acting on the patient's behalf. */
  source?: 'widget' | 'checkpoint' | null;
  /** Virtual impressions only. The clinician (lng_staff_members.id) the
   *  staff booker explicitly picked from the available list. Honoured
   *  only after verifying the clinician is genuinely free for the slot.
   *  The public widget omits it (auto-assigns the first free self-serve
   *  clinician); Checkpoint's staff picker sends it and may pick a
   *  staff-only clinician (self_serve_only is relaxed for source
   *  'checkpoint'). */
  clinicianStaffMemberId?: string | null;
  /** Display name of the staff member who initiated the booking
   *  from an external surface. Only meaningful when source is set
   *  to a non-widget origin; persisted to
   *  lng_appointments.created_via_actor so the Lounge appointment
   *  surfaces can render "Booked through Checkpoint by [name]".
   *  Free text — Checkpoint users don't have Lounge accounts so a
   *  cross-project FK is not available. Null for customer-self-
   *  service widget bookings. */
  actorName?: string | null;
  /** Shopify order name (e.g. "VEN73520") to attach as a credit
   *  against the appointment. Mirrors NewBookingSheet's order-attach
   *  step: the endpoint re-resolves the order via lng_lookup_shopify_order
   *  with the service-role key and writes the six shopify_order_*
   *  columns. Required when source='checkpoint' and serviceType is
   *  same_day_appliance or click_in_veneers (same-day services are
   *  only bookable against a paid online order). Null/omitted for
   *  the customer widget. */
  shopifyOrderName?: string | null;
  /** Checkpoint-only. The live Shopify Admin API order snapshot the
   *  scanning surface already loaded. When source='checkpoint' and
   *  this is present, widget-create-appointment trusts these fields
   *  for the redemption gate (cancelled / refunded / paid status,
   *  total, currency) instead of looking the order up in the
   *  Meridian shopify_orders cache. The cache isn't on a recurring
   *  sync, so new orders weren't visible to the lookup and every
   *  same-day upgrade booked through Checkpoint failed with
   *  shopify_order_not_found until this path was added. The cache
   *  fallback is kept for non-Checkpoint callers (the public
   *  widget, which doesn't have a live order in hand). */
  shopifyOrderDetails?: {
    id?: string | null;
    name?: string | null;
    totalPricePence?: number | null;
    currency?: string | null;
    financialStatus?: string | null;
    cancelledAt?: string | null;
  } | null;
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
  card_brand: string | null;
  card_last4: string | null;
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

  // ── Effective denture-repair variant ────────────────────────────
  // For a denture_repair cart with multiple repair lines, the
  // body's repair_variant is only the FIRST cart line's variant —
  // so a "Cracked + Relining" cart would resolve the conflict
  // check against the first line's shape and miss Relining's
  // impression-clinician + consult-room pool claims. Pick the most
  // restrictive variant across the whole cart via the same helper
  // the slot picker uses, then use that effective variant for
  // duration resolution, conflict check, AND the appointment row's
  // persisted repair_variant column. After this point
  // body.repairVariant is ignored — every downstream lookup reads
  // effectiveRepairVariant instead.
  let effectiveRepairVariant = body.repairVariant ?? null;
  if (
    body.serviceType === 'denture_repair' &&
    Array.isArray(body.repairItems) &&
    body.repairItems.length > 0
  ) {
    const variants = Array.from(
      new Set(
        body.repairItems
          .map((r) => r.repairVariant)
          .filter((v): v is string => !!v && v.trim() !== ''),
      ),
    );
    if (variants.length > 0) {
      const { data: pickRaw, error: pickErr } = await supabase.rpc(
        'lng_denture_repair_effective_variant',
        { p_variants: variants },
      );
      if (pickErr) {
        await logFailure('effective_variant_pick_failed', {
          error: pickErr.message,
          variants,
        }, 'warning');
      } else if (typeof pickRaw === 'string' && pickRaw.length > 0) {
        effectiveRepairVariant = pickRaw;
      }
    }
  }

  // ── Resolve duration from booking type config ───────────────────
  const { data: resolvedRaw, error: resolveErr } = await supabase.rpc('lng_booking_type_resolve', {
    p_service_type: body.serviceType,
    p_repair_variant: effectiveRepairVariant,
    p_product_key: body.productKey ?? null,
    p_arch: body.arch ?? null,
  });
  if (resolveErr) {
    await logFailure('booking_type_resolve_failed', { error: resolveErr.message, body });
    return jsonResponse(500, { error: 'resolve_failed' });
  }
  const resolved = (Array.isArray(resolvedRaw) ? resolvedRaw[0] : null) as
    | { duration_default?: number; min_notice_minutes?: number | null }
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
  // Booking-notice guard — same defence-in-depth as the past-time
  // check. The slot scanner already hides notice-violating slots
  // from the picker and the conflict checker re-runs the same test,
  // but a hand-crafted request should fail loudly here with a
  // dedicated error code instead of a generic slot_unavailable.
  const noticeMinutes =
    typeof resolved.min_notice_minutes === 'number' && resolved.min_notice_minutes > 0
      ? resolved.min_notice_minutes
      : 0;
  if (noticeMinutes > 0) {
    const earliest = Date.now() + noticeMinutes * 60_000;
    if (startAt.getTime() < earliest) {
      return jsonResponse(400, {
        error: 'within_min_notice',
        min_notice_minutes: noticeMinutes,
        earliest_start_at: new Date(earliest).toISOString(),
      });
    }
  }
  const endAt = new Date(startAt.getTime() + durationMin * 60_000);

  // ── Conflict check ──────────────────────────────────────────────
  const { data: conflictRows, error: conflictErr } = await supabase.rpc('lng_booking_check_conflict', {
    p_location_id: resolvedLocationId,
    p_service_type: body.serviceType,
    p_start_at: startAt.toISOString(),
    p_end_at: endAt.toISOString(),
    p_exclude_appointment_id: null,
    p_repair_variant: effectiveRepairVariant,
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

  // ── Virtual clinician availability gate + assignment ────────────
  // For virtual impressions, a slot is only bookable when a self-serve
  // clinician is on shift AND free for it. The slot scanner already
  // enforces this in the picker; this is the same defence-in-depth as
  // the conflict check above, for a crafted request or a race. Special
  // / staff-only clinicians (clinician_self_serve=false) are reserved
  // for explicit staff placement in the in-app booking sheet, so both
  // the public widget and Checkpoint auto-assign draw only from
  // self-serve clinicians here. The first available clinician (ordered
  // by name) is assigned to the booking.
  let chosenClinicianId: string | null = null;
  if (body.serviceType === 'virtual_impression_appointment') {
    // The public widget only offers self-serve clinicians; the
    // Checkpoint staff booker may place a staff-only clinician too.
    const selfServeOnly = body.source !== 'checkpoint';
    // When the caller picked a specific clinician we pass it as the
    // filter so lng_clinicians_available both restricts to that one AND
    // confirms they are on shift + free for the slot. No pick (public
    // widget) → null filter → auto-assign the first free clinician.
    const requestedClinicianId = body.clinicianStaffMemberId ?? null;
    const { data: availRows, error: availErr } = await supabase.rpc('lng_clinicians_available', {
      p_start_at: startAt.toISOString(),
      p_end_at: endAt.toISOString(),
      p_self_serve_only: selfServeOnly,
      p_exclude_appointment_id: null,
      p_staff_member_id: requestedClinicianId,
    });
    if (availErr) {
      await logFailure('clinicians_available_failed', { error: availErr.message, body });
      return jsonResponse(500, { error: 'availability_check_failed' });
    }
    if (!Array.isArray(availRows) || availRows.length === 0) {
      // Distinguish "the clinician you picked is no longer free" from
      // "nobody is free" so the caller can message it precisely.
      return jsonResponse(409, {
        error: requestedClinicianId ? 'clinician_not_available' : 'no_clinician_available',
      });
    }
    chosenClinicianId = requestedClinicianId
      ? requestedClinicianId
      : (availRows[0] as { staff_member_id: string }).staff_member_id;
  }

  // ── Shopify order verification ─────────────────────────────────
  // Single path: when the caller wants to attach a Shopify order to
  // the booking, it POSTs the live order snapshot in
  // `shopifyOrderDetails` (id, name, total, currency,
  // financialStatus, cancelledAt). We validate the redemption gate
  // here and trust the resolved values.
  //
  // Checkpoint pre-loads the order on ScanView via its `get-order`
  // edge function (live Shopify Admin API), so by the time it calls
  // us it already has the canonical snapshot. The public widget
  // (venneir.com / denture-services.co.uk) doesn't attach Shopify
  // orders to its bookings at all — its same-day services gate on a
  // Stripe PaymentIntent instead, validated separately below.
  //
  // The earlier version of this function also kept a fallback that
  // looked the order up in the cached `shopify_orders` table via
  // `lng_lookup_shopify_order`. That cache sits on the Meridian DB
  // and isn't on a recurring sync — every booking placed after the
  // last manual sync failed with `shopify_order_not_found`. We
  // removed the fallback because (a) it broke as often as it helped,
  // and (b) nothing currently calls this endpoint with
  // shopifyOrderName but without shopifyOrderDetails. The `_orders`
  // cache is still useful for bulk patient-history queries on the
  // visit / patient profile surfaces; it just isn't on the booking
  // critical path any more.
  //
  // Trust model: a tampered Checkpoint client could lie about
  // `financialStatus`. Worst-case impact is "fake same-day booking
  // on a chair without paying" — annoyance, not financial loss
  // (payment still settles at the till; the attacker can't redeem
  // against an order they don't own). Acceptable tradeoff vs.
  // leaving the booking broken whenever the cache lags.
  const isSameDayService =
    body.serviceType === 'same_day_appliance' ||
    body.serviceType === 'click_in_veneers';
  const isCheckpointSource = body.source === 'checkpoint';
  let shopifyOrderRow: {
    id: string | null;
    name: string;
    total_price_pence: number;
    currency: string | null;
  } | null = null;
  const shopifyOrderName = body.shopifyOrderName?.trim() || null;
  const trustedDetails = body.shopifyOrderDetails ?? null;

  if (trustedDetails && shopifyOrderName) {
    if (trustedDetails.cancelledAt) {
      return jsonResponse(400, { error: 'shopify_order_cancelled' });
    }
    const fin = (trustedDetails.financialStatus ?? '').toLowerCase();
    if (fin === 'refunded') {
      return jsonResponse(400, { error: 'shopify_order_refunded' });
    }
    if (fin !== 'paid' && fin !== 'partially_refunded') {
      return jsonResponse(400, {
        error: 'shopify_order_not_paid',
        detail: trustedDetails.financialStatus ?? null,
      });
    }
    const totalPence = Number(trustedDetails.totalPricePence);
    if (!Number.isFinite(totalPence) || totalPence < 0) {
      return jsonResponse(400, {
        error: 'shopify_order_invalid_total',
        detail: trustedDetails.totalPricePence,
      });
    }
    // Write null, not "", when the snapshot didn't carry an id —
    // shopify_order_id is a nullable text column and downstream
    // readers (visits.ts:778) gate on truthiness, so storing the
    // empty string would just look like noise in the database.
    const idRaw = trustedDetails.id;
    const id = idRaw === undefined || idRaw === null || idRaw === ''
      ? null
      : String(idRaw);
    shopifyOrderRow = {
      id,
      name: trustedDetails.name ?? shopifyOrderName,
      total_price_pence: Math.round(totalPence),
      currency: trustedDetails.currency ?? null,
    };
  }
  if (isCheckpointSource && isSameDayService && !shopifyOrderRow) {
    return jsonResponse(400, { error: 'same_day_requires_shopify_order' });
  }

  // ── Payment verification ────────────────────────────────────────
  // Four modes the client can send. All flows resolve the expected
  // amount server-side first so a tampered client body can't claim
  // "£0 paid" on a £399 booking.
  //
  //   paymentMode === 'full'        Verify PI against the resolved
  //     catalogue price (unit_price or both_arches_price); write
  //     paid_in_full_at_booking=true.
  //   paymentMode === 'deposit'     Verify PI against
  //     widget_deposit_pence (the per-booking-type deposit); write
  //     the deposit fields, paid_in_full_at_booking stays false.
  //   paymentMode === 'on_the_day'  Nothing collected at booking;
  //     no PI expected. The cart settles at the till.
  //   paymentMode is null / unset   Legacy fallback for the old
  //     widget that pre-dated the explicit mode flag — same
  //     behaviour as 'deposit'. Kept for back-compat with any
  //     un-redeployed embed in the wild.
  // Checkpoint always settles at the till — staff book on behalf of
  // a patient who's already paid online (via the attached Shopify
  // order) or who will pay in clinic. No Stripe PI in the loop.
  const paymentMode: 'full' | 'on_the_day' | 'deposit' = isCheckpointSource
    ? 'on_the_day'
    : body.paymentMode === 'full'
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
    const fullPrice = await resolveWidgetFullPricePence(supabase, {
      serviceType: body.serviceType,
      productKey: body.productKey ?? null,
      repairVariant: body.repairVariant ?? null,
      arch: body.arch ?? null,
      upgradeIds: body.upgradeIds ?? [],
      repairItems: (body.repairItems ?? []).map((r) => ({
        catalogueId: r.catalogueId,
        arch: r.arch,
        quantity: r.quantity,
      })),
    });
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
      card_brand: verify.cardBrand,
      card_last4: verify.cardLast4,
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
        card_brand: verify.cardBrand,
        card_last4: verify.cardLast4,
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
      // Fill-blanks, but a placeholder ("Customer"/"Patient") or an
      // empty-string name counts as blank — otherwise a real name the
      // customer just typed into the widget is silently discarded over
      // a Shopify-seeded placeholder. See _shared/patientName.ts.
      if (isPlaceholderName(cur.first_name) && firstName) patch.first_name = firstName;
      if (isPlaceholderName(cur.last_name) && lastName) patch.last_name = lastName;
      // Fill-blanks the phone, treating the One Click "+44000000000"
      // dummy (and other junk) as blank so a real number passed by this
      // booking overwrites it. Without this, a patient seeded with the
      // dummy keeps it forever even when Checkpoint / the widget supply
      // the real number. See _shared/phone.ts.
      const incomingPhone = usablePhone(phone);
      if (isPlaceholderPhone(cur.phone) && incomingPhone) patch.phone = incomingPhone;
      if (Object.keys(patch).length > 0) {
        await supabase.from('patients').update(patch).eq('id', patientId);
      }
    }
  }
  if (!patientId && usablePhone(phone)) {
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
      // Same placeholder-aware fill-blanks as the email-match branch.
      if (isPlaceholderName(cur.first_name) && firstName) patch.first_name = firstName;
      if (isPlaceholderName(cur.last_name) && lastName) patch.last_name = lastName;
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
        // first_name/last_name are NOT NULL. The widget form requires a
        // name, so firstName is present here; write it straight rather
        // than masking a (theoretical) blank with a fake 'Patient'.
        first_name: firstName,
        last_name: lastName,
        email: email || null,
        // never store the +44000000000 dummy as a new patient's phone
        phone: usablePhone(phone),
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
  // Primary product axis on the appointment row. The caller sends these
  // single fields (the customer widget for its one product; Checkpoint
  // computes them from its bag with the correct per-service rule — e.g.
  // click-in veneers keep product_key null to match availability config).
  // The full Checkpoint bag travels separately in body.items and is
  // written to lng_appointment_items below.
  const bagItems = isCheckpointSource && Array.isArray(body.items) ? body.items : [];
  const primaryProductKey = body.productKey ?? null;
  const primaryArch = body.arch ?? null;
  const primaryQuantity =
    Number.isInteger(body.quantity) && (body.quantity as number) > 0 ? body.quantity : null;
  const primaryShade =
    typeof body.shade === 'string' && body.shade.trim() ? body.shade.trim() : null;
  // Whitelist guard: the column CHECK only accepts these two; anything else
  // (typo, future option not taught here) is dropped to null rather than
  // 500-ing the booking write.
  const primaryThickness =
    body.thickness === '1mm' || body.thickness === '1.5mm' ? body.thickness : null;

  const eventLabel = labelForService(body.serviceType);
  const { data: appt, error: apptErr } = await supabase
    .from('lng_appointments')
    .insert({
      patient_id: patientId,
      location_id: resolvedLocationId,
      // Both customer-widget AND Checkpoint bookings write source='native'
      // — they're both real scheduled appointments the patient initiated.
      // Lounge's Schedule renders source='manual' as "Walk-in · " with
      // a footprints icon, which was wrong for Checkpoint bookings:
      // they're scheduled in advance, not walk-ins. The distinction
      // between widget and Checkpoint is preserved on created_via
      // ('widget' vs 'checkpoint') for reporting + the timeline
      // "Booked through Checkpoint by [name]" line.
      source: 'native',
      start_at: startAt.toISOString(),
      end_at: endAt.toISOString(),
      status: 'booked',
      service_type: body.serviceType,
      // The clinician assigned at the gate above (virtual only) — the
      // availability + no-double-book key.
      clinician_staff_member_id: chosenClinicianId,
      event_type_label: eventLabel,
      appointment_ref: appointmentRef,
      // customer_note holds a PATIENT-typed note (read-only on the
      // staff side). Only the customer widget produces those. A note
      // typed in the Checkpoint booker is written by a staff member on
      // the patient's behalf, so it is a STAFF note — it must NOT land
      // in customer_note. For source='checkpoint' we leave customer_note
      // null here and insert the text into lng_appointment_staff_notes
      // (attributed to the booking staff member) after the row exists.
      // The `notes` column stays reserved/empty as before.
      customer_note: isCheckpointSource ? null : (body.details.notes?.trim() || null),
      notes: null,
      repair_variant: effectiveRepairVariant,
      product_key: primaryProductKey,
      arch: primaryArch,
      // Primary-product enrichment. For a Checkpoint bag these mirror the
      // first item; the full bag is in lng_appointment_items. Null for the
      // customer widget (single unit, no shade axis).
      quantity: primaryQuantity,
      shade: primaryShade,
      thickness: primaryThickness,
      // Whitelist guard: the column accepts any text but we only
      // recognise these two values. Anything else (a typo, a
      // future brand the email function hasn't been taught about)
      // falls back to 'venneir' so emails still send rather than
      // 500-ing the booking write.
      brand_id: body.brandId === 'denture' ? 'denture' : 'venneir',
      paid_in_full_at_booking: paidInFullAtBooking,
      // Shopify order credit. Mirrors NewBookingSheet's createAppointment
      // write so the cart at checkout already reflects the online
      // payment. shopify_order_linked_by is null because the caller
      // is anon-keyed (no auth_account_id available) — for Checkpoint
      // we may revisit this once Checkpoint mints its own staff token.
      shopify_order_id: shopifyOrderRow?.id ?? null,
      shopify_order_name: shopifyOrderRow?.name ?? null,
      shopify_order_total_pence: shopifyOrderRow?.total_price_pence ?? null,
      shopify_order_currency: shopifyOrderRow?.currency ?? null,
      shopify_order_linked_at: shopifyOrderRow ? new Date().toISOString() : null,
      shopify_order_linked_by: null,
      // Origin attribution for non-Lounge surfaces. Customer-widget
      // bookings tag created_via='widget' so reports can split them
      // from staff in-app bookings (which leave the column null).
      // Checkpoint bookings additionally carry the staff member's
      // display name so the appointment detail view can render the
      // "Booked through Checkpoint by [name]" line.
      created_via: isCheckpointSource ? 'checkpoint' : 'widget',
      created_via_actor: isCheckpointSource
        ? (body.actorName?.trim() || null)
        : null,
      // Free same-day upgrade — only honoured for Checkpoint same-day
      // services, and only with a reason. Zeroes the appliance at the
      // till and flags the booking.
      free_upgrade: isCheckpointSource && isSameDayService && body.freeUpgrade === true,
      free_upgrade_reason:
        isCheckpointSource && isSameDayService && body.freeUpgrade === true
          ? (body.freeUpgradeReason?.trim() || null)
          : null,
      ...(depositFields ?? {}),
    })
    .select('id, appointment_ref, manage_token')
    .single();
  if (apptErr || !appt) {
    // SQLSTATE 23P01 = the lng_appointments_overlap_guard trigger
    // caught a race between the pre-check above and this insert.
    // Return the same 409 + conflicts shape so the customer widget's
    // banner reads identically to a pre-check conflict.
    if ((apptErr as { code?: string } | null)?.code === '23P01') {
      const { data: retryConflicts } = await supabase.rpc('lng_booking_check_conflict', {
        p_location_id: resolvedLocationId,
        p_service_type: body.serviceType,
        p_start_at: startAt.toISOString(),
        p_end_at: endAt.toISOString(),
        p_exclude_appointment_id: null,
        p_repair_variant: effectiveRepairVariant,
        p_product_key: body.productKey ?? null,
        p_arch: body.arch ?? null,
      });
      return jsonResponse(409, {
        error: 'slot_unavailable',
        conflicts: Array.isArray(retryConflicts) ? retryConflicts : [],
      });
    }
    await logFailure('appointment_insert_failed', { error: apptErr?.message, patientId });
    return jsonResponse(500, { error: 'appointment_insert_failed' });
  }
  const apptRow = appt as { id: string; appointment_ref: string | null; manage_token: string | null };
  const appointmentId = apptRow.id;
  const manageToken = apptRow.manage_token;

  // ── Persist widget-side picks (upgrades + repair items) ─────────
  // The widget captures these in state and ships them in the body, but
  // before this block they had no destination. Each is re-resolved
  // server-side against lwo_catalogue / lng_widget_upgrades so a
  // tampered client body can't claim £0 for a £79 upgrade or shrink a
  // 6-tooth Broken Tooth line into a single-tooth charge.
  //
  // Failure here is loud (logFailure + 500) per CLAUDE.md "no silent
  // fallbacks" — we'd rather fail the booking than silently drop the
  // upgrades and confuse the staff later.
  await persistAppointmentExtras(supabase, {
    appointmentId,
    arch: body.arch ?? null,
    serviceType: body.serviceType,
    productKey: body.productKey ?? null,
    repairVariant: body.repairVariant ?? null,
    upgradeIds: body.upgradeIds ?? [],
    repairItems: body.repairItems ?? [],
  });

  // ── Checkpoint multi-item bag ───────────────────────────────────
  // Persist the planned product bag to lng_appointment_items so it can
  // pre-populate the cart when the customer is marked arrived. Prices +
  // upgrades are re-resolved server-side; the client body is never
  // trusted. Loud failure per CLAUDE.md — we'd rather fail the booking
  // than silently drop what the customer agreed to.
  if (bagItems.length > 0) {
    await persistAppointmentItems(supabase, {
      appointmentId,
      defaultServiceType: body.serviceType,
      items: bagItems,
    });
  }

  // ── Checkpoint staff note ───────────────────────────────────────
  // A note typed in the Checkpoint booker is a staff note, not a
  // customer note (see the customer_note comment on the insert above).
  // Write it to lng_appointment_staff_notes, attributed to the booking
  // staff member via author_name (Checkpoint users have no accounts
  // row, so author_account_id stays null — the byline falls back to
  // author_name). Best-effort + logged: the booking is already
  // committed, so a note write failure must not fail the request.
  if (isCheckpointSource) {
    const staffNoteBody = body.details.notes?.trim() || '';
    if (staffNoteBody) {
      const authorName = body.actorName?.trim() || null;
      const { error: noteErr } = await supabase
        .from('lng_appointment_staff_notes')
        .insert({
          appointment_id: appointmentId,
          author_account_id: null,
          author_name: authorName,
          body: staffNoteBody,
        });
      if (noteErr) {
        await logFailure(
          'checkpoint_staff_note_insert_failed',
          { appointmentId, error: noteErr.message },
          'warning',
        );
      }
    }
  }

  // ── Google Meet (virtual impression only) ──────────────────────
  // Two-step flow mirroring meet-create-space:
  //   1. POST https://meet.googleapis.com/v2/spaces — creates a Meet
  //      space owned by the host (so meet_space_id + meet_meeting_code
  //      land on the row, which is what unlocks the attendance card
  //      and meet-fetch-attendance later).
  //   2. POST Calendar event attached to that existing space (no
  //      createRequest) — the patient gets the standard Google invite
  //      with sendUpdates=all, the host's calendar shows the booking.
  //
  // The legacy createMeetEvent path only minted a Calendar-level Meet
  // room with no Meet-side space record, so attendance + transcripts
  // were invisible for Checkpoint bookings. We now mirror the staff
  // pipeline exactly so a Checkpoint-booked virtual impression is
  // indistinguishable from one Lounge staff booked via the in-app
  // NewBookingSheet flow.
  //
  // Failure is best-effort: the booking succeeds even if Meet creation
  // fails; the failure logs to lng_system_failures.
  if (body.serviceType === 'virtual_impression_appointment') {
    let meetCreated = false;
    // Room-owner candidates for the Meet space. The clinician (chosen at
    // the gate above) runs the call; the room itself is owned by a Google
    // account (OAuth host) and the clinician is recognised in it. Prefer
    // the assigned clinician's own connected Google account
    // (lng_meet_hosts.staff_member_id = the clinician), then fall back to
    // any active OAuth host by sort_order. Hosts without a refresh_token
    // can't mint a space and drop out.
    const { data: hostRows } = await supabase
      .from('lng_meet_hosts')
      .select('id, display_name, google_email, access_token, refresh_token, token_expiry, is_active, sort_order, staff_member_id, kind, oauth_client')
      .eq('kind', 'oauth')
      .eq('is_active', true)
      .not('refresh_token', 'is', null)
      .order('sort_order', { ascending: true });
    const allOauth = (hostRows ?? []) as (MeetHostRow & { staff_member_id: string | null })[];
    const isOwn = (h: { staff_member_id: string | null }) =>
      !!chosenClinicianId && h.staff_member_id === chosenClinicianId;
    const candidateHosts: MeetHostRow[] = [
      ...allOauth.filter(isOwn),
      ...allOauth.filter((h) => !isOwn(h)),
    ];

    // Patient name + email for the calendar invite. The Meet space
    // alone doesn't carry attendee info; the Calendar event is what
    // sends the invite + populates the patient's google_calendar_event
    // (and what conferenceRecords later attribute to the meeting).
    const patientFirstName = body.details.firstName?.trim() || null;
    const patientLastName = body.details.lastName?.trim() || null;
    const patientFullName = [patientFirstName, patientLastName].filter(Boolean).join(' ').trim();
    const patientEmailLower = body.details.email?.trim().toLowerCase() || null;
    const summary = patientFullName ? `${eventLabel} with ${patientFullName}` : eventLabel;
    const description = [
      eventLabel ? `Service: ${eventLabel}` : null,
      patientFullName ? `Patient: ${patientFullName}` : null,
      patientEmailLower ? `Patient email: ${patientEmailLower}` : null,
      '',
      'This event was created by Venneir Lounge. Reply to lounge@venneir.com for any changes.',
    ]
      .filter((line) => line !== null)
      .join('\n');

    for (const host of candidateHosts) {
      try {
        const tokenResult = await getValidAccessToken(supabase, host);
        if (!tokenResult.ok) {
          await logFailure(
            'meet_host_token_refresh_failed',
            { appointmentId, host_id: host.id, error: tokenResult.error },
            'warning',
          );
          continue;
        }
        const accessToken = tokenResult.accessToken;

        // Step 1 — mint the Meet space. accessType=OPEN +
        // entryPointAccess=ALL means anyone with the link joins
        // without sign-in or a lobby knock, which is what we want
        // for patients on personal devices.
        const spaceRes = await fetch('https://meet.googleapis.com/v2/spaces', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            config: { accessType: 'OPEN', entryPointAccess: 'ALL' },
          }),
        });
        if (!spaceRes.ok) {
          const errBody = await spaceRes.text().catch(() => '');
          await logFailure(
            'meet_space_create_failed',
            {
              appointmentId,
              host_id: host.id,
              host_email: host.google_email,
              response_status: spaceRes.status,
              response_body_preview: errBody.slice(0, 500),
            },
            'warning',
          );
          continue;
        }
        const meetSpace = (await spaceRes.json()) as {
          name?: string;
          meetingUri?: string;
          meetingCode?: string;
        };
        if (!meetSpace.name || !meetSpace.meetingUri || !meetSpace.meetingCode) {
          await logFailure(
            'meet_space_incomplete_payload',
            { appointmentId, host_id: host.id, space_payload: meetSpace },
            'warning',
          );
          continue;
        }

        // Step 2 — attach the existing Meet space to a new Calendar
        // event on the host's primary calendar. conferenceData.entry
        // Points (no createRequest) tells Calendar to use the supplied
        // Meet rather than minting a new one.
        const calendarBody: Record<string, unknown> = {
          summary,
          description,
          start: { dateTime: startAt.toISOString(), timeZone: 'Europe/London' },
          end: { dateTime: endAt.toISOString(), timeZone: 'Europe/London' },
          conferenceData: {
            conferenceSolution: {
              key: { type: 'hangoutsMeet' },
              name: 'Google Meet',
            },
            conferenceId: meetSpace.meetingCode,
            entryPoints: [
              {
                entryPointType: 'video',
                uri: meetSpace.meetingUri,
                label: meetSpace.meetingCode,
              },
            ],
          },
          guestsCanModify: false,
          guestsCanInviteOthers: false,
        };
        if (patientEmailLower) {
          calendarBody.attendees = [
            { email: patientEmailLower, responseStatus: 'needsAction' },
          ];
        }
        const calRes = await fetch(
          'https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(calendarBody),
          },
        );
        if (!calRes.ok) {
          const errBody = await calRes.text().catch(() => '');
          await logFailure(
            'meet_calendar_attach_failed',
            {
              appointmentId,
              host_id: host.id,
              meeting_code: meetSpace.meetingCode,
              response_status: calRes.status,
              response_body_preview: errBody.slice(0, 500),
            },
            'warning',
          );
          // Step 2 failed after Step 1 succeeded — the Meet space
          // exists on Google's side with no appointment to back it.
          // End it now so we don't leak abandoned Meet rooms on the
          // host's account. Best-effort: a failure here is logged
          // but doesn't block the fallback path.
          await endOrphanedMeetSpace(accessToken, meetSpace.name, {
            appointmentId,
            host_id: host.id,
            reason: 'calendar_attach_failed',
          });
          continue;
        }
        const calEvent = (await calRes.json()) as { id?: string };
        if (!calEvent.id) {
          await logFailure(
            'meet_calendar_no_event_id',
            { appointmentId, host_id: host.id, meeting_code: meetSpace.meetingCode },
            'warning',
          );
          await endOrphanedMeetSpace(accessToken, meetSpace.name, {
            appointmentId,
            host_id: host.id,
            reason: 'calendar_no_event_id',
          });
          continue;
        }

        // Step 3 — persist every Meet field so the attendance card
        // renders and meet-fetch-attendance can find the
        // conferenceRecord later.
        await supabase
          .from('lng_appointments')
          .update({
            meet_host_id: host.id,
            meet_space_id: meetSpace.name,
            meet_meeting_code: meetSpace.meetingCode,
            google_calendar_event_id: calEvent.id,
            join_url: meetSpace.meetingUri,
            meeting_platform: 'google_meet',
          })
          .eq('id', appointmentId);
        meetCreated = true;
        break;
      } catch (e) {
        await logFailure(
          'meet_host_create_failed',
          {
            appointmentId,
            host_id: host.id,
            host_email: host.google_email,
            error: e instanceof Error ? e.message : String(e),
          },
          'warning',
        );
        // Try the next host
      }
    }

    // No clinician-hosted Meet space could be created (no host
    // configured, or every candidate host's OAuth token is broken).
    //
    // We deliberately do NOT fall back to a service-account Calendar
    // hangout link. That produced an un-hosted room with Google's
    // default lobby ("please wait until a host brings you in") and no
    // meet_space_id — exactly the broken state a clinician can never
    // run a call from. Persisting it as join_url also made every
    // join_url-keyed surface (the schedule + appointment Join button)
    // light up a dead link.
    //
    // Instead leave join_url NULL. The booking still saves (the
    // patient is booked, the clinician is assigned), and because there
    // is no link the appointment surfaces the "Generate Meet link"
    // card in Lounge — a proper host-owned, OPEN-access room is minted
    // there (re-notifying the patient) before the call. Logged at
    // error severity so the gap is visible immediately, not at call
    // time. INVARIANT: join_url is set only when meet_space_id is.
    if (!meetCreated) {
      await logFailure(
        'virtual_meet_space_not_created',
        {
          appointmentId,
          clinician_staff_member_id: chosenClinicianId,
          candidate_host_count: candidateHosts.length,
          reason: candidateHosts.length === 0
            ? 'no_host_configured'
            : 'all_candidate_hosts_failed',
        },
        'error',
      );
    }
  }

  await supabase.from('patient_events').insert({
    patient_id: patientId,
    event_type: 'appointment_booked',
    payload: {
      source: isCheckpointSource ? 'checkpoint' : 'widget',
      // Display name of the Checkpoint staff member who booked this, so
      // the notification attributes the STAFF ("X booked Y in for …")
      // rather than crediting the patient. Null for the customer widget
      // (a genuine self-serve booking).
      actor_name: isCheckpointSource ? (body.actorName?.trim() || null) : null,
      appointment_id: appointmentId,
      appointment_ref: appointmentRef,
      service_type: body.serviceType,
      // Reflect the effective variant we wrote to the row, not the
      // first-line variant the body shipped — keeps reports + future
      // event-replay queries consistent with the booking shape.
      repair_variant: effectiveRepairVariant,
      product_key: body.productKey ?? null,
      arch: body.arch ?? null,
      start_at: startAt.toISOString(),
      end_at: endAt.toISOString(),
      duration_minutes: durationMin,
      upgrade_ids: body.upgradeIds ?? [],
      shopify_order_name: shopifyOrderRow?.name ?? null,
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
        paid_in_full: paidInFullAtBooking,
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
  if (
    body.quantity !== undefined &&
    body.quantity !== null &&
    (!Number.isInteger(body.quantity) || body.quantity < 1)
  ) {
    return 'quantity_invalid';
  }
  if (body.shade !== undefined && body.shade !== null && typeof body.shade !== 'string') {
    return 'shade_invalid';
  }
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
  impression_appointment: 'In-person impression appointment',
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
      cardBrand: string | null;
      cardLast4: string | null;
    }
  | {
      ok: false;
      status: number;
      reason: string;
    };

// Full-price resolution lives in _shared/widgetFullPrice.ts so this
// endpoint and widget-create-payment-intent compute the amount the
// same way. Two paths inside the helper:
//   • denture_repair  — sum the cart's per-line catalogue prices.
//   • everything else — resolve one catalogue row by axis pins.
// Critical: verifyPaymentIntent below compares the PI's captured
// amount against this resolution. If the two endpoints disagreed
// the verification step would either reject valid bookings (when
// this endpoint computes more than the PI was created for) OR
// accept under-charged ones (when this endpoint computes less than
// the PI actually captured). The bug we just fixed was the latter:
// the resolver looked up one catalogue row by repair_variant for
// denture-repair carts, so a 6-line £410 booking was getting
// charged the first line's £60 and the verification still passed.

async function verifyPaymentIntent(
  stripeSecret: string,
  paymentIntentId: string,
  expectedAmount: number,
): Promise<VerifyResult> {
  // Expand latest_charge so the response carries
  // payment_method_details.card without a second hop. Lets us write
  // card_brand + card_last4 onto the appointment in the same flow.
  const r = await fetch(
    `${STRIPE_BASE}/payment_intents/${encodeURIComponent(paymentIntentId)}?expand[]=latest_charge`,
    {
      headers: {
        Authorization: `Bearer ${stripeSecret}`,
        'Stripe-Version': '2024-10-28.acacia',
      },
    },
  );
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
        latest_charge?: {
          payment_method_details?: {
            card?: { brand?: string | null; last4?: string | null };
            card_present?: { brand?: string | null; last4?: string | null };
          };
        };
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
  const cardDetails =
    pi.latest_charge?.payment_method_details?.card ??
    pi.latest_charge?.payment_method_details?.card_present ??
    null;
  const cardBrand = typeof cardDetails?.brand === 'string' ? cardDetails.brand : null;
  const cardLast4 =
    typeof cardDetails?.last4 === 'string' && /^\d{4}$/.test(cardDetails.last4)
      ? cardDetails.last4
      : null;
  return {
    ok: true,
    amount,
    currency: (pi.currency ?? 'gbp').toUpperCase(),
    paidAt,
    cardBrand,
    cardLast4,
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

// endOrphanedMeetSpace — cleanup helper for the post-/v2/spaces,
// pre-Calendar-event window. A Meet space exists on Google's side
// but the corresponding lng_appointments row never got the
// meet_space_id (because the Calendar attach failed). Without
// cleanup we'd leak abandoned spaces on the host's account every
// time Calendar has a hiccup.
//
// Uses spaces.endActiveConference + spaces are auto-recycled once
// the active conference is ended; explicit DELETE isn't part of
// the public Meet v2 API. Best-effort — a failure here is logged
// but never blocks the caller's flow.
async function endOrphanedMeetSpace(
  accessToken: string,
  spaceName: string,
  context: Record<string, unknown>,
): Promise<void> {
  try {
    const res = await fetch(
      `https://meet.googleapis.com/v2/${spaceName}:endActiveConference`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    // 200 = ended a conference. 409 = no active conference (the
    // space exists but nobody joined yet — fine, Google reclaims
    // it on its own schedule). Anything else is a real failure
    // worth logging.
    if (!res.ok && res.status !== 409) {
      const body = await res.text().catch(() => '');
      await logFailure(
        'meet_space_cleanup_failed',
        {
          ...context,
          space_name: spaceName,
          response_status: res.status,
          response_body_preview: body.slice(0, 300),
        },
        'warning',
      );
    }
  } catch (e) {
    await logFailure(
      'meet_space_cleanup_threw',
      {
        ...context,
        space_name: spaceName,
        error: e instanceof Error ? e.message : String(e),
      },
      'warning',
    );
  }
}

// ─────────────────────────────────────────────────────────────────────
// persistAppointmentExtras — write the patient's widget-side picks
// (paid upgrades + denture-repair line items) into the two
// snapshot tables introduced in 20260515000003. Both tables snapshot
// price + name at insert time so a catalogue edit later can never
// retroactively change the appointment's commitment.
//
// Server-side resolution: every price comes from a fresh fetch of
// lwo_catalogue / lng_widget_upgrades, NOT the body. The client
// already shipped prices in the payload but trusting them would let
// a tampered request claim £0 for a £79 upgrade.
//
// Failures inside this function throw so the caller surfaces them as
// 500. The booking is already written; we don't roll it back, but the
// failure logs to lng_system_failures and the staff app can re-add
// the missing items by hand — better than the current behaviour of
// silently dropping every selection.
// ─────────────────────────────────────────────────────────────────────

async function persistAppointmentExtras(
  supabase: SupabaseClient,
  args: {
    appointmentId: string;
    arch: 'upper' | 'lower' | 'both' | null;
    serviceType: string;
    productKey: string | null;
    repairVariant: string | null;
    upgradeIds: string[];
    repairItems: SubmitRepairItemBody[];
  },
) {
  // ── Upgrades ──────────────────────────────────────────────────────
  // Each ticked upgrade resolves against lng_widget_upgrades, then
  // prices itself using the SERVICE catalogue's arch_match (mirrors
  // the widget's price preview rule at state.ts:computePriceBreakdown).
  if (args.upgradeIds.length > 0) {
    // Service row gives us arch_match for the price-resolution rule.
    let serviceArchMatch: 'any' | 'single' | 'both' = 'any';
    {
      let q = supabase
        .from('lwo_catalogue')
        .select('arch_match')
        .eq('service_type', args.serviceType)
        .eq('active', true);
      if (args.productKey) q = q.eq('product_key', args.productKey);
      if (args.repairVariant) q = q.eq('repair_variant', args.repairVariant);
      const { data: rows, error } = await q.limit(1);
      if (error) {
        await logFailure('upgrade_service_arch_match_failed', {
          appointmentId: args.appointmentId,
          error: error.message,
        });
        throw new Error(`Could not resolve service arch_match: ${error.message}`);
      }
      const row = (rows ?? [])[0] as { arch_match?: string } | undefined;
      if (row?.arch_match === 'single' || row?.arch_match === 'both' || row?.arch_match === 'any') {
        serviceArchMatch = row.arch_match;
      }
    }

    const { data: upgradeRows, error: upgradeReadErr } = await supabase
      .from('lng_widget_upgrades')
      .select('id, code, name, unit_price, both_arches_price')
      .in('id', args.upgradeIds);
    if (upgradeReadErr) {
      await logFailure('upgrade_resolve_failed', {
        appointmentId: args.appointmentId,
        upgradeIds: args.upgradeIds,
        error: upgradeReadErr.message,
      });
      throw new Error(`Could not resolve upgrades: ${upgradeReadErr.message}`);
    }
    const archIsBoth = args.arch === 'both';
    const upgradeInserts = (upgradeRows ?? []).map((r) => {
      const unitPence = Math.round(Number(r.unit_price) * 100);
      const bothPence =
        r.both_arches_price === null || r.both_arches_price === undefined
          ? null
          : Math.round(Number(r.both_arches_price) * 100);
      const resolvedPence =
        serviceArchMatch === 'single' && archIsBoth && bothPence !== null
          ? bothPence
          : unitPence;
      return {
        appointment_id: args.appointmentId,
        upgrade_id: r.id as string,
        // Prefer the catalogue's stable text code (e.g. 'titanium_nightguard');
        // fall back to the uuid if the row hasn't been backfilled yet so
        // the unique constraint still has something to hash on.
        upgrade_code: (r.code as string) || (r.id as string),
        name: (r.name as string) ?? '',
        unit_label: null,
        unit_price_pence: unitPence,
        both_arches_price_pence: bothPence,
        resolved_price_pence: resolvedPence,
      };
    });
    if (upgradeInserts.length > 0) {
      const { error: upgradeWriteErr } = await supabase
        .from('lng_appointment_upgrade_selections')
        .insert(upgradeInserts);
      if (upgradeWriteErr) {
        await logFailure('upgrade_insert_failed', {
          appointmentId: args.appointmentId,
          upgradeIds: args.upgradeIds,
          error: upgradeWriteErr.message,
        });
        throw new Error(`Could not write upgrade selections: ${upgradeWriteErr.message}`);
      }
    }
  }

  // ── Repair items ──────────────────────────────────────────────────
  if (args.repairItems.length > 0) {
    const catalogueIds = Array.from(new Set(args.repairItems.map((r) => r.catalogueId)));
    const { data: catalogueRows, error: catErr } = await supabase
      .from('lwo_catalogue')
      .select('id, name, unit_price, both_arches_price, unit_label, repair_variant, code')
      .in('id', catalogueIds);
    if (catErr) {
      await logFailure('repair_catalogue_resolve_failed', {
        appointmentId: args.appointmentId,
        catalogueIds,
        error: catErr.message,
      });
      throw new Error(`Could not resolve repair catalogue rows: ${catErr.message}`);
    }
    const catalogueById = new Map<string, {
      id: string;
      name: string;
      unitPence: number;
      bothPence: number | null;
      unitLabel: string | null;
      repairVariant: string;
      code: string;
    }>();
    for (const r of catalogueRows ?? []) {
      catalogueById.set(r.id as string, {
        id: r.id as string,
        name: (r.name as string) ?? '',
        unitPence: Math.round(Number(r.unit_price) * 100),
        bothPence:
          r.both_arches_price === null || r.both_arches_price === undefined
            ? null
            : Math.round(Number(r.both_arches_price) * 100),
        unitLabel: (r.unit_label as string | null) ?? null,
        repairVariant: (r.repair_variant as string) ?? '',
        code: (r.code as string) ?? '',
      });
    }
    const repairInserts: Array<Record<string, unknown>> = [];
    for (const item of args.repairItems) {
      const cat = catalogueById.get(item.catalogueId);
      if (!cat) {
        await logFailure('repair_item_unknown_catalogue', {
          appointmentId: args.appointmentId,
          catalogueId: item.catalogueId,
        }, 'warning');
        continue;
      }
      const quantity = Math.max(1, Math.min(14, Math.round(item.quantity)));
      const lineTotalPence = resolveRepairLineTotalPence({
        unitLabel: cat.unitLabel,
        unitPricePence: cat.unitPence,
        bothArchesPricePence: cat.bothPence,
        arch: item.arch,
        quantity,
      });
      repairInserts.push({
        appointment_id: args.appointmentId,
        catalogue_id: cat.id,
        code: cat.code || item.code,
        repair_variant: cat.repairVariant || item.repairVariant,
        name: cat.name || item.name,
        unit_label: cat.unitLabel,
        arch: item.arch,
        quantity,
        unit_price_pence: cat.unitPence,
        both_arches_price_pence: cat.bothPence,
        line_total_pence: lineTotalPence,
      });
    }
    if (repairInserts.length > 0) {
      const { error: repairWriteErr } = await supabase
        .from('lng_appointment_repair_items')
        .insert(repairInserts);
      if (repairWriteErr) {
        await logFailure('repair_items_insert_failed', {
          appointmentId: args.appointmentId,
          rowCount: repairInserts.length,
          error: repairWriteErr.message,
        });
        throw new Error(`Could not write repair items: ${repairWriteErr.message}`);
      }
    }
  }
}

// persistAppointmentItems — write a Checkpoint booking's product bag to
// lng_appointment_items (+ lng_appointment_item_upgrades). Every price is
// re-resolved from lwo_catalogue / lng_widget_upgrades; the client body
// only supplies which catalogue rows + upgrades, never amounts. This is
// the data the arrival flow reads back to pre-populate the cart when the
// customer is marked arrived.
const PRICED_SERVICE_TYPES = new Set(['same_day_appliance', 'click_in_veneers']);

async function persistAppointmentItems(
  supabase: SupabaseClient,
  args: {
    appointmentId: string;
    defaultServiceType: string;
    items: SubmitItem[];
  },
) {
  let sortOrder = 0;
  for (const item of args.items) {
    const serviceType = (item.serviceType || args.defaultServiceType || '').trim();
    if (!serviceType) {
      await logFailure('appointment_item_no_service_type', {
        appointmentId: args.appointmentId,
      }, 'warning');
      continue;
    }

    // Resolve the catalogue row server-side. Prefer the explicit
    // catalogue id; fall back to (service_type, product_key) so an item
    // booked without an id still resolves to the right row + price.
    let catQuery = supabase
      .from('lwo_catalogue')
      .select('id, name, unit_price, both_arches_price, arch_match, product_key')
      .eq('active', true);
    if (item.catalogueId) {
      catQuery = catQuery.eq('id', item.catalogueId);
    } else {
      catQuery = catQuery.eq('service_type', serviceType);
      if (item.productKey) catQuery = catQuery.eq('product_key', item.productKey);
      else catQuery = catQuery.is('product_key', null);
    }
    const { data: catRows, error: catErr } = await catQuery.limit(1);
    if (catErr) {
      await logFailure('appointment_item_catalogue_failed', {
        appointmentId: args.appointmentId,
        error: catErr.message,
      });
      throw new Error(`Could not resolve item catalogue row: ${catErr.message}`);
    }
    const cat = (catRows ?? [])[0] as
      | { id: string; name: string; unit_price: number; both_arches_price: number | null; arch_match: string; product_key: string | null }
      | undefined;
    if (!cat) {
      await logFailure('appointment_item_unknown_catalogue', {
        appointmentId: args.appointmentId,
        catalogueId: item.catalogueId ?? null,
        serviceType,
        productKey: item.productKey ?? null,
      }, 'warning');
      continue;
    }

    const arch = item.arch === 'upper' || item.arch === 'lower' || item.arch === 'both' ? item.arch : null;
    const archIsBoth = arch === 'both';
    const unitPence = Math.round(Number(cat.unit_price) * 100);
    const bothPence =
      cat.both_arches_price === null || cat.both_arches_price === undefined
        ? null
        : Math.round(Number(cat.both_arches_price) * 100);
    // Arch-resolved unit price: a 'single'-arch product priced for both
    // arches uses the both-arches figure as the per-unit price.
    const resolvedUnitPence =
      cat.arch_match === 'single' && archIsBoth && bothPence !== null ? bothPence : unitPence;
    const quantity = Math.max(1, Math.min(99, Math.round(item.quantity ?? 1)));
    const priceShown = PRICED_SERVICE_TYPES.has(serviceType);
    const shade = typeof item.shade === 'string' && item.shade.trim() ? item.shade.trim() : null;
    const thickness = item.thickness === '1mm' || item.thickness === '1.5mm' ? item.thickness : null;

    const { data: insertedItem, error: itemErr } = await supabase
      .from('lng_appointment_items')
      .insert({
        appointment_id: args.appointmentId,
        catalogue_id: cat.id,
        service_type: serviceType,
        product_key: item.productKey ?? cat.product_key ?? null,
        name: cat.name ?? '',
        arch,
        shade,
        thickness,
        quantity,
        unit_price_pence: resolvedUnitPence,
        line_total_pence: resolvedUnitPence * quantity,
        price_shown: priceShown,
        sort_order: sortOrder,
      })
      .select('id')
      .single();
    if (itemErr || !insertedItem) {
      await logFailure('appointment_item_insert_failed', {
        appointmentId: args.appointmentId,
        error: itemErr?.message,
      });
      throw new Error(`Could not write appointment item: ${itemErr?.message ?? 'no row'}`);
    }
    sortOrder += 1;

    // Per-item upgrades — re-resolve against lng_widget_upgrades.
    const upgradeIds = Array.isArray(item.upgradeIds) ? item.upgradeIds.filter(Boolean) : [];
    if (upgradeIds.length > 0) {
      const { data: upgradeRows, error: upErr } = await supabase
        .from('lng_widget_upgrades')
        .select('id, code, name, unit_price, both_arches_price')
        .in('id', upgradeIds);
      if (upErr) {
        await logFailure('appointment_item_upgrade_resolve_failed', {
          appointmentId: args.appointmentId,
          upgradeIds,
          error: upErr.message,
        });
        throw new Error(`Could not resolve item upgrades: ${upErr.message}`);
      }
      const upgradeInserts = (upgradeRows ?? []).map((r) => {
        const uUnit = Math.round(Number(r.unit_price) * 100);
        const uBoth =
          r.both_arches_price === null || r.both_arches_price === undefined
            ? null
            : Math.round(Number(r.both_arches_price) * 100);
        const resolved = archIsBoth && uBoth !== null ? uBoth : uUnit;
        return {
          appointment_item_id: insertedItem.id as string,
          upgrade_id: r.id as string,
          upgrade_code: (r.code as string) || (r.id as string),
          name: (r.name as string) ?? '',
          unit_price_pence: uUnit,
          both_arches_price_pence: uBoth,
          resolved_price_pence: resolved,
        };
      });
      if (upgradeInserts.length > 0) {
        const { error: upWriteErr } = await supabase
          .from('lng_appointment_item_upgrades')
          .insert(upgradeInserts);
        if (upWriteErr) {
          await logFailure('appointment_item_upgrade_insert_failed', {
            appointmentId: args.appointmentId,
            error: upWriteErr.message,
          });
          throw new Error(`Could not write item upgrades: ${upWriteErr.message}`);
        }
      }
    }
  }
}

// Server-side mirror of the widget's resolveLineTotal helper
// (state.ts). Keep both in sync; if the widget's pricing rule ever
// changes, the server is the source of truth.
function resolveRepairLineTotalPence(input: {
  unitLabel: string | null;
  unitPricePence: number;
  bothArchesPricePence: number | null;
  arch: 'upper' | 'lower' | 'both';
  quantity: number;
}): number {
  if (input.unitLabel === 'per tooth') {
    return input.quantity * input.unitPricePence;
  }
  if (input.unitLabel === 'per arch' && input.arch === 'both') {
    return input.bothArchesPricePence ?? input.unitPricePence * 2;
  }
  return input.unitPricePence;
}
