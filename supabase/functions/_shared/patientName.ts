// patientName.ts
//
// Shared rules for deciding when a patient's stored name is "real" vs a
// system-generated placeholder or blank that should be treated as
// missing data.
//
// Background: the Meridian shopify-orders-webhook historically stamped
// the literal first name "Customer" (and an empty-string last name)
// whenever a Shopify order's customer object carried no name, which is
// the norm for express checkouts (Shop Pay, PayPal, Apple Pay, One
// Click) where the name lives on the shipping/billing address. The
// Lounge widget also wrote "Patient" as an insert fallback. Those
// placeholders are NOT real data, so a fill-blanks merge must be allowed
// to overwrite them, and recovery tooling must be able to spot them.

// Literal placeholder names that earlier code paths wrote in place of a
// real (missing) name. Compared case-insensitively after trimming.
export const PLACEHOLDER_NAMES = ['customer', 'patient'] as const;

// True when a stored name value carries no real information: null,
// empty/whitespace, or one of the known placeholders. Such a value
// should be treated as a blank that a real value is free to overwrite.
export function isPlaceholderName(value: string | null | undefined): boolean {
  const v = (value ?? '').trim();
  if (v === '') return true;
  return PLACEHOLDER_NAMES.includes(v.toLowerCase() as (typeof PLACEHOLDER_NAMES)[number]);
}

// Normalise a candidate name for storage. patients.first_name and
// patients.last_name are NOT NULL, so the canonical "no name" value is
// the empty string (the UI already renders '' as an em-dash). Trims the
// value and collapses a blank or placeholder to '' so the DB never holds
// a fake like "Customer". Never invents a value.
export function cleanName(value: string | null | undefined): string {
  const v = (value ?? '').trim();
  if (v === '' || isPlaceholderName(v)) return '';
  return v;
}
