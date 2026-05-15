import { supabase } from '../../lib/supabase.ts';
import type { WidgetState } from './state.ts';

// Widget submission helper.
//
// Calls the widget-create-appointment edge function with the patient's
// resolved booking state. The edge function does the conflict check,
// patient identity (email-match → fill-blanks → create), the
// lng_appointments insert, and the patient_events emit. We just
// shuttle the inputs over and translate failures into typed errors
// the widget shell can react to (specifically: a "slot just went"
// 409 needs to bounce the user back to the time step).

export interface SubmitResult {
  appointmentId: string;
  appointmentRef: string | null;
  manageToken: string | null;
}

/** Submit failure classes. The widget shell uses `code` to decide
 *  whether to bounce back to the time step (slot_unavailable) or
 *  surface a generic toast. */
export class SubmitError extends Error {
  code: string;
  detail: unknown;
  constructor(code: string, detail: unknown, message?: string) {
    super(message ?? code);
    this.name = 'SubmitError';
    this.code = code;
    this.detail = detail;
  }
}

/** What the customer chose at the details footer. The shell passes
 *  this explicitly because state.paymentChoice may not have
 *  propagated yet on the same tick — we set the choice and call
 *  submit in the same handler.
 *
 *  • 'full'        PI created at the resolved full price and verified
 *                  server-side; appointment marked paid_in_full_at_booking.
 *  • 'deposit'     PI created at widget_deposit_pence (the legacy
 *                  per-booking-type deposit) and verified server-side;
 *                  appointment carries the deposit but the cart still
 *                  collects the balance at the till.
 *  • 'on_the_day'  No PI. Cart settles entirely at the till.
 *  • null          Legacy free-booking / pre-mode-flag path. The
 *                  server falls back to the deposit pathway when
 *                  widget_deposit_pence > 0 to stay back-compatible
 *                  with any older client still in the wild. */
export type WidgetPaymentMode = 'full' | 'deposit' | 'on_the_day' | null;

export async function submitBooking(
  state: WidgetState,
  paymentIntentId: string | null = null,
  brandId: 'venneir' | 'denture' = 'venneir',
  paymentMode: WidgetPaymentMode = null,
): Promise<SubmitResult> {
  if (!state.location) throw new SubmitError('no_location', null);
  if (!state.service) throw new SubmitError('no_service', null);
  if (!state.slotIso) throw new SubmitError('no_slot', null);

  // Pre-flight past-slot check. If the patient sat on the time step
  // (or the payment step) long enough that their picked slot is now
  // in the past, throw the same `startAt_in_past` code the server
  // returns. Saves a round-trip and gives the same UX (bounce back
  // to the time step) without exposing the user to a backend error
  // they didn't cause.
  if (new Date(state.slotIso).getTime() <= Date.now()) {
    throw new SubmitError('startAt_in_past', null);
  }

  const body = {
    locationId: state.location.id,
    serviceType: state.service.serviceType,
    startAt: state.slotIso,
    repairVariant: state.axes.repair_variant ?? null,
    productKey: state.axes.product_key ?? null,
    arch: state.axes.arch ?? null,
    upgradeIds: state.upgradeIds,
    // Per-arch denture-repair lines from the multi-line cart. Only
    // populated for denture_repair bookings; every other service ships
    // an empty array. The server re-resolves prices against the
    // catalogue before writing — these client-supplied prices are for
    // optimistic display only and are NOT trusted by the backend.
    repairItems: state.repairItems.map((r) => ({
      catalogueId: r.catalogueId,
      code: r.code,
      repairVariant: r.repairVariant,
      name: r.name,
      unitLabel: r.unitLabel,
      arch: r.arch,
      quantity: r.quantity,
      unitPricePence: r.unitPricePence,
      bothArchesPricePence: r.bothArchesPricePence,
      lineTotalPence: r.lineTotalPence,
    })),
    paymentIntentId,
    // The brand the customer booked through. Stored on the
    // appointment row so the confirmation email + downstream
    // reporting can differentiate venneir.com from
    // denture-services.co.uk bookings. Defaults to 'venneir' when
    // the caller didn't pass a brand (legacy /book route).
    brandId,
    details: state.details,
    // 'full'        → PI verified against the resolved full price and
    //                  appointment marked paid_in_full_at_booking.
    // 'on_the_day'  → nothing taken now; cart settles at the till.
    // null          → free service / legacy path; back-compat default
    //                  on the server is 'on_the_day' for non-free
    //                  services, no-op for free.
    paymentMode,
  };

  const { data, error } = await supabase.functions.invoke<{
    appointmentId?: string;
    appointmentRef?: string | null;
    manageToken?: string | null;
    error?: string;
    detail?: unknown;
  }>('widget-create-appointment', { body });

  if (error) {
    // Functions client serialises non-2xx responses into FunctionsHttpError.
    // The body is on `error.context` (a Response object); read it so the
    // shell can branch on the typed code.
    const detail = await readErrorBody(error as Error & { context?: Response });
    const code =
      (detail && typeof detail === 'object' && 'error' in detail
        ? String((detail as { error: string }).error)
        : null) ?? 'submit_failed';
    throw new SubmitError(code, detail, error.message);
  }
  if (!data || !data.appointmentId) {
    throw new SubmitError('submit_failed', data, 'Empty response from booking endpoint.');
  }
  return {
    appointmentId: data.appointmentId,
    appointmentRef: data.appointmentRef ?? null,
    manageToken: data.manageToken ?? null,
  };
}

async function readErrorBody(
  err: Error & { context?: Response },
): Promise<unknown> {
  const ctx = err.context;
  if (!ctx) return null;
  try {
    return await ctx.clone().json();
  } catch {
    try {
      return await ctx.clone().text();
    } catch {
      return null;
    }
  }
}
