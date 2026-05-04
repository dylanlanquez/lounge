import { supabase } from '../lib/supabase.ts';
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

export async function submitBooking(
  state: WidgetState,
  paymentIntentId: string | null = null,
): Promise<SubmitResult> {
  if (!state.location) throw new SubmitError('no_location', null);
  if (!state.service) throw new SubmitError('no_service', null);
  if (!state.slotIso) throw new SubmitError('no_slot', null);

  const body = {
    locationId: state.location.id,
    serviceType: state.service.serviceType,
    startAt: state.slotIso,
    repairVariant: state.axes.repair_variant ?? null,
    productKey: state.axes.product_key ?? null,
    arch: state.axes.arch ?? null,
    upgradeIds: state.upgradeIds,
    paymentIntentId,
    details: state.details,
  };

  const { data, error } = await supabase.functions.invoke<{
    appointmentId?: string;
    appointmentRef?: string | null;
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
