// Voice calls: the shared vocabulary.
//
// A voice call is a booking with service_type = 'voice_call': a phone
// call between a patient and a voice call agent at a booked time. No
// chair, no lab, no Meet link. Agents are staff members flagged
// is_voice_call_agent; together they are the 'voice-call-agent' resource
// pool the booking consumes (migration 20260915000001).
//
// Everything that needs to say "is this a voice call?" reads it from
// here, so the schedule row, the detail sheet, the filter, the mode and
// the notifications can never disagree about what counts.

import type { AppointmentCategory } from './queries/appointments.ts';

export const VOICE_CALL_SERVICE_TYPE = 'voice_call' as const;

/** The staff-role pool every Voice call phase names (Admin, Booking types). */
export const VOICE_CALL_POOL = 'voice-call-agent';

/** The schedule category (colour bucket + filter row) voice calls land in. */
export const VOICE_CALL_CATEGORY: AppointmentCategory = 'voiceCall';

export function isVoiceCall(row: { service_type: string | null }): boolean {
  return row.service_type === VOICE_CALL_SERVICE_TYPE;
}

/** Statuses a call can be dialled from: booked, or already on the line. */
export function voiceCallIsLive(status: string): boolean {
  return status === 'booked' || status === 'arrived' || status === 'joined';
}

/**
 * tel: href for a stored phone number. Keeps digits and a leading +,
 * which is all a dialler needs; null when there is nothing dialable so
 * the caller can hide the button instead of offering a dead link.
 */
export function telHref(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  const plus = trimmed.startsWith('+') ? '+' : '';
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 7) return null;
  return `tel:${plus}${digits}`;
}
