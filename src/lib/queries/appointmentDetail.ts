import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { logFailure } from '../failureLog.ts';
import type { AppointmentSource } from './appointments.ts';
import type { AppointmentStatus } from '../../components/AppointmentCard/AppointmentCard.tsx';

// Appointment detail — used by /appointment/:id (the Ledger
// click-through for bookings that don't yet have a visit). Returns a
// hydrated row joining patient identity, location, optional staff,
// and the linked visit if one exists. Walk-ins never land here; they
// always have a visit and route to /visit/:id directly.
//
// The hook resolves to one of three states:
//
//   { ok: 'loaded',        appt }    — render the page
//   { ok: 'redirect',      visitId } — visit was created (mark-arrived
//                                       fired or pre-existing visit
//                                       was found); caller should
//                                       navigate to /visit/:id
//   { ok: 'not_found' }              — appointment id doesn't exist
//                                       (or RLS hides it from this
//                                       JWT). Page shows a sensible
//                                       not-found surface.
//
// Failures during the fetch (network, schema mismatch, missing
// patient) are logged to lng_system_failures with the appointment id
// in context and surfaced via the `error` field. The caller renders
// an error panel and the operator can hit Retry.

export interface AppointmentDetailRow {
  id: string;
  status: AppointmentStatus;
  source: AppointmentSource;
  start_at: string;
  end_at: string;
  event_type_label: string | null;
  appointment_ref: string | null;
  jb_ref: string | null;
  cancel_reason: string | null;
  notes: string | null;
  reschedule_to_id: string | null;
  staff_account_id: string | null;
  location_id: string;
  patient_id: string;
  join_url: string | null;
  intake: ReadonlyArray<{ question: string; answer: string }> | null;
  // Deposit captured at booking time. Null when no deposit was taken
  // (Calendly event without one, or native booking pre-deposit
  // support). Components consume the four fields together so the
  // shape is denormalised here for ease of access.
  deposit_pence: number | null;
  deposit_currency: string | null;
  deposit_provider: 'paypal' | 'stripe' | null;
  deposit_status: 'paid' | 'failed' | null;
  patient: {
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    phone: string | null;
    avatar_data: string | null;
    internal_ref: string | null;
    lwo_ref: string | null;
  };
  location: {
    id: string;
    name: string | null;
    city: string | null;
  } | null;
  staff: {
    id: string;
    first_name: string | null;
    last_name: string | null;
  } | null;
  // The linked visit, if one exists. Booked rows pre-arrival have
  // none; arrived/in_progress/complete rows do. The route checks this
  // to decide whether to render or redirect to /visit/:id.
  visit: {
    id: string;
    opened_at: string;
  } | null;
}

export type AppointmentDetailResult =
  | { state: 'loading'; data: null; error: null }
  | { state: 'loaded'; data: AppointmentDetailRow; error: null }
  | { state: 'not_found'; data: null; error: null }
  | { state: 'error'; data: null; error: string };

export interface UseAppointmentDetailResult {
  result: AppointmentDetailResult;
  refresh: () => void;
}

interface RawAppointment {
  id: string;
  status: AppointmentStatus;
  source: AppointmentSource;
  start_at: string;
  end_at: string;
  event_type_label: string | null;
  appointment_ref: string | null;
  jb_ref: string | null;
  cancel_reason: string | null;
  notes: string | null;
  reschedule_to_id: string | null;
  staff_account_id: string | null;
  location_id: string;
  patient_id: string;
  join_url: string | null;
  intake: ReadonlyArray<{ question: string; answer: string }> | null;
  deposit_pence: number | null;
  deposit_currency: string | null;
  deposit_provider: 'paypal' | 'stripe' | null;
  deposit_status: 'paid' | 'failed' | null;
}

export function useAppointmentDetail(appointmentId: string | undefined | null): UseAppointmentDetailResult {
  const [result, setResult] = useState<AppointmentDetailResult>({
    state: 'loading',
    data: null,
    error: null,
  });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!appointmentId) {
      setResult({ state: 'not_found', data: null, error: null });
      return;
    }
    setResult({ state: 'loading', data: null, error: null });

    (async () => {
      try {
        const { data: rawAppt, error: apptErr } = await supabase
          .from('lng_appointments')
          .select(
            'id, status, source, start_at, end_at, event_type_label, appointment_ref, jb_ref, cancel_reason, notes, reschedule_to_id, staff_account_id, location_id, patient_id, join_url, intake, deposit_pence, deposit_currency, deposit_provider, deposit_status',
          )
          .eq('id', appointmentId)
          .maybeSingle();

        if (cancelled) return;
        if (apptErr) {
          await logFailure({
            source: 'useAppointmentDetail.appointment',
            severity: 'error',
            message: apptErr.message,
            context: { appointmentId },
          });
          setResult({ state: 'error', data: null, error: apptErr.message });
          return;
        }
        if (!rawAppt) {
          // Either the row doesn't exist or RLS hides it. Either way,
          // the page surfaces a not-found state — never silently fall
          // back to "loading" forever.
          setResult({ state: 'not_found', data: null, error: null });
          return;
        }

        const appt = rawAppt as RawAppointment;

        // Fetch patient + location + staff + visit in parallel so the
        // page paints with everything on first useable render.
        const [patientRes, locationRes, staffRes, visitRes] = await Promise.all([
          supabase
            .from('patients')
            .select('id, first_name, last_name, email, phone, avatar_data, internal_ref, lwo_ref')
            .eq('id', appt.patient_id)
            .maybeSingle(),
          supabase
            .from('locations')
            .select('id, name, city')
            .eq('id', appt.location_id)
            .maybeSingle(),
          appt.staff_account_id
            ? supabase
                .from('accounts')
                .select('id, first_name, last_name')
                .eq('id', appt.staff_account_id)
                .maybeSingle()
            : Promise.resolve({ data: null, error: null }),
          supabase
            .from('lng_visits')
            .select('id, opened_at')
            .eq('appointment_id', appt.id)
            .maybeSingle(),
        ]);
        if (cancelled) return;

        // Patient is non-optional. A missing row here is a data
        // integrity break (the FK forbids it) — log loudly. The page
        // still tries to render but with name fallbacks.
        if (patientRes.error) {
          await logFailure({
            source: 'useAppointmentDetail.patient',
            severity: 'error',
            message: patientRes.error.message,
            context: { appointmentId, patientId: appt.patient_id },
          });
        }
        if (locationRes.error) {
          await logFailure({
            source: 'useAppointmentDetail.location',
            severity: 'warning',
            message: locationRes.error.message,
            context: { appointmentId, locationId: appt.location_id },
          });
        }
        if (staffRes.error) {
          await logFailure({
            source: 'useAppointmentDetail.staff',
            severity: 'warning',
            message: staffRes.error.message,
            context: { appointmentId, staffId: appt.staff_account_id },
          });
        }
        if (visitRes.error) {
          await logFailure({
            source: 'useAppointmentDetail.visit',
            severity: 'warning',
            message: visitRes.error.message,
            context: { appointmentId },
          });
        }

        const patientRow =
          (patientRes.data as {
            id: string;
            first_name: string | null;
            last_name: string | null;
            email: string | null;
            phone: string | null;
            avatar_data: string | null;
            internal_ref: string | null;
            lwo_ref: string | null;
          } | null) ?? {
            id: appt.patient_id,
            first_name: null,
            last_name: null,
            email: null,
            phone: null,
            avatar_data: null,
            internal_ref: null,
            lwo_ref: null,
          };

        const row: AppointmentDetailRow = {
          id: appt.id,
          status: appt.status,
          source: appt.source,
          start_at: appt.start_at,
          end_at: appt.end_at,
          event_type_label: appt.event_type_label,
          appointment_ref: appt.appointment_ref,
          jb_ref: appt.jb_ref,
          cancel_reason: appt.cancel_reason,
          notes: appt.notes,
          reschedule_to_id: appt.reschedule_to_id,
          staff_account_id: appt.staff_account_id,
          location_id: appt.location_id,
          patient_id: appt.patient_id,
          join_url: appt.join_url,
          intake: appt.intake,
          deposit_pence: appt.deposit_pence,
          deposit_currency: appt.deposit_currency,
          deposit_provider: appt.deposit_provider,
          deposit_status: appt.deposit_status,
          patient: patientRow,
          location:
            (locationRes.data as { id: string; name: string | null; city: string | null } | null) ?? null,
          staff:
            (staffRes.data as { id: string; first_name: string | null; last_name: string | null } | null) ??
            null,
          visit:
            (visitRes.data as { id: string; opened_at: string } | null) ?? null,
        };

        setResult({ state: 'loaded', data: row, error: null });
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : 'Could not load appointment';
        await logFailure({
          source: 'useAppointmentDetail.unhandled',
          severity: 'error',
          message,
          context: { appointmentId },
        });
        setResult({ state: 'error', data: null, error: message });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [appointmentId, tick]);

  return { result, refresh: () => setTick((t) => t + 1) };
}

// ─────────────────────────────────────────────────────────────────────────────
// availableActions — single source of truth for which actions the
// detail page should offer for any given appointment state. Pulled
// out as a pure function (no React, no Supabase) so the rules can be
// unit-tested and audited in one place. Adding a new status or
// changing a rule means editing here, not chasing if-branches in the
// JSX.
// ─────────────────────────────────────────────────────────────────────────────

export type AppointmentAction =
  | 'view_patient_profile'   // every state
  | 'mark_arrived'           // booked, on or near the slot day
  | 'mark_no_show'           // booked, past start time
  | 'edit'                   // booked + native source (Calendly edits live in Calendly)
  | 'reschedule'             // booked + native source
  | 'cancel'                 // booked + native source
  | 'resend_confirmation'    // booked + native source + patient has email
  | 'reverse_cancellation'   // cancelled
  | 'reverse_no_show'        // no_show
  | 'view_rescheduled_to'    // rescheduled with a forward link
  | 'view_visit';            // arrived / in_progress / complete with a visit

export interface AvailableActionsInput {
  status: AppointmentStatus;
  source: AppointmentSource;
  hasPatientEmail: boolean;
  hasVisit: boolean;
  hasRescheduleTarget: boolean;
}

export function availableActions(input: AvailableActionsInput): AppointmentAction[] {
  const out: AppointmentAction[] = ['view_patient_profile'];
  const { status, source, hasPatientEmail, hasVisit, hasRescheduleTarget } = input;
  const isCalendly = source === 'calendly';

  if (status === 'booked') {
    out.push('mark_arrived');
    out.push('mark_no_show');
    if (!isCalendly) {
      out.push('edit');
      out.push('reschedule');
      out.push('cancel');
      if (hasPatientEmail) out.push('resend_confirmation');
    }
  } else if (status === 'cancelled') {
    out.push('reverse_cancellation');
  } else if (status === 'no_show') {
    out.push('reverse_no_show');
  } else if (status === 'rescheduled') {
    if (hasRescheduleTarget) out.push('view_rescheduled_to');
  } else if (
    status === 'arrived' ||
    status === 'in_progress' ||
    status === 'complete'
  ) {
    if (hasVisit) out.push('view_visit');
  }

  return out;
}
