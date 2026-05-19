// properCase — mirror of the client-side helper in
// src/lib/queries/appointments.ts. Edge functions can't import from
// src/, so the canonical implementation lives here and the client
// file should be kept identical. Whenever one changes, change both.
//
// Used at the patient_first_name / patient_last_name boundary so a
// row stored as "DARREN" or "darren" renders as "Darren" before it
// lands in an SMS body, email subject, or visible UI string.
//
// Behaviour:
//   - Splits on whitespace, hyphens, and apostrophes (straight + curly).
//   - Honorifics (Mr/Mrs/Miss/Ms/Dr/Prof, optionally dotted) keep their
//     established casing regardless of input.
//   - Single-letter tokens are treated as initials (kept uppercase).
//   - All-lower → capitalise first letter.
//   - All-upper → capitalise first letter, lowercase the rest.
//   - Mixed case (already "McBride", "DeFranco") is left alone.

const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof']);

export function properCase(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .split(/(\s+|-|’|')/)
    .map((part) => {
      if (!part || /^[\s\-'’]+$/.test(part)) return part;
      const lower = part.toLowerCase();
      const dotted = lower.endsWith('.');
      const stem = dotted ? lower.slice(0, -1) : lower;
      if (HONORIFICS.has(stem)) {
        return stem.charAt(0).toUpperCase() + stem.slice(1) + (dotted ? '.' : '');
      }
      if (part.length === 1) return part.toUpperCase();
      const isAllLower = lower === part;
      const isAllUpper = part.toUpperCase() === part;
      if (isAllLower) return part.charAt(0).toUpperCase() + part.slice(1);
      if (isAllUpper) return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
      return part;
    })
    .join('');
}
