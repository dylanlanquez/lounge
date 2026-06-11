// _shared/phone.ts
//
// usablePhone — gate a phone string so obvious placeholders are treated
// as "no number" rather than a real contact.
//
// Why this exists: the One Click / venneir.com checkout writes a dummy
// "+44000000000" as the Shopify CUSTOMER's phone. Patients created from
// those orders (before the Meridian webhook's usablePhone fix) stored the
// dummy. Every booking path that does a fill-blanks on phone treated the
// non-empty dummy as a real value, so a real number (typed in the widget,
// passed from Checkpoint) could never overwrite it. usablePhone returns
// null for the dummy (and other all-zero / too-short junk) so a fill-
// blanks check treats it as blank and lets the real number win. Mirrors
// meridian-app/supabase/functions/_shared/phone.ts — keep in lockstep.

export function usablePhone(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  const digits = v.replace(/\D/g, '');
  // Too short to be a real phone.
  if (digits.length < 7) return null;
  // All the same digit: 00000000000, 11111111111, etc.
  if (/^(\d)\1+$/.test(digits)) return null;
  // A country/trunk prefix (44 or a leading 0) followed by only zeros:
  // catches +44000000000 and 00000000000.
  if (/^(?:44|0)?0+$/.test(digits)) return null;
  return v;
}

// True when a stored phone is missing or a known placeholder, so a real
// number is free to overwrite it in a fill-blanks merge.
export function isPlaceholderPhone(value: string | null | undefined): boolean {
  return usablePhone(value) === null;
}
