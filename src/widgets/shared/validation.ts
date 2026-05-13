import type { WidgetDetails } from './state.ts';
import { findCountry } from './countries.ts';

// Form validation for the Details step.
//
// One source of truth for every required-field rule, shared by:
//
//   • Per-field error messages rendered inline under each input.
//   • The Summary CTA's disabled state (prevents the Pay /
//     Book button from firing while the form is invalid).
//   • The widget shell's submit-error fallback (covers the case
//     where the user manually navigated past Details).
//
// The validators take only the raw fields they need so a future
// component can re-use them outside the WidgetDetails type.

export type DetailsField = 'firstName' | 'lastName' | 'email' | 'phoneNumber' | 'agreeTerms';

export interface DetailsErrors {
  firstName?: string;
  lastName?: string;
  email?: string;
  phoneNumber?: string;
  agreeTerms?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateFirstName(v: string): string | null {
  return v.trim().length === 0 ? "Enter your first name." : null;
}

export function validateLastName(v: string): string | null {
  return v.trim().length === 0 ? "Enter your last name." : null;
}

export function validateEmail(v: string): string | null {
  const trimmed = v.trim();
  if (trimmed.length === 0) return "Enter an email address.";
  if (!EMAIL_RE.test(trimmed)) return "That doesn't look like a valid email address.";
  return null;
}

export function validatePhone(rawNumber: string, countryCode: string): string | null {
  const digits = rawNumber.replace(/\D/g, '');
  if (digits.length === 0) return "Enter your mobile number.";
  const country = findCountry(countryCode);
  // Strip a leading 0 — UK / IE / many EU numbers use a domestic
  // trunk prefix that's dropped when dialled internationally. The
  // server applies the same rule when composing the E.164 number.
  const trimmed = digits.startsWith('0') ? digits.slice(1) : digits;
  if (trimmed.length < country.minDigits) {
    return `That's too short for a ${country.label} number.`;
  }
  return null;
}

export function validateAgreeTerms(v: boolean): string | null {
  return v ? null : "Please agree to the terms to continue.";
}

export function validateDetails(d: WidgetDetails): DetailsErrors {
  const out: DetailsErrors = {};
  const fn = validateFirstName(d.firstName);
  if (fn) out.firstName = fn;
  const ln = validateLastName(d.lastName);
  if (ln) out.lastName = ln;
  const em = validateEmail(d.email);
  if (em) out.email = em;
  const ph = validatePhone(d.phoneNumber, d.phoneCountry);
  if (ph) out.phoneNumber = ph;
  const at = validateAgreeTerms(d.agreeTerms);
  if (at) out.agreeTerms = at;
  return out;
}

export function isDetailsValid(d: WidgetDetails): boolean {
  return Object.keys(validateDetails(d)).length === 0;
}
