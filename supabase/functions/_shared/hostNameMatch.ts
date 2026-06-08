// _shared/hostNameMatch.ts
//
// Pure name-matching helpers for Meet host recognition. Kept completely
// dependency free (no Deno, no node, no esm.sh) so two very different
// runtimes can import the SAME logic:
//
//   • the Deno edge runtime (meetAttendanceCore) at attendance-fetch time
//   • the Node / vitest unit test (src/lib/hostNameMatch.test.ts)
//
// A staff member who runs a virtual appointment joins the Meet under
// whatever display name their Google account shows ("Karly", "Karly I.",
// "Karly Innes (iPad)"). We need to recognise them as the host without a
// connected OAuth grant. Two levels:
//
//   • staffHostNameMatches — LOOSE, used to LABEL a participant as the
//     host. Flexible enough for real-world Meet names.
//   • staffHostNameExact   — STRICT, used to AUTO-BIND a stable Google
//     user id onto the staff host. We only persist an un-forgeable id
//     when we are certain, so a loose label match can never lock the
//     wrong person's id onto a staff record.

// Normalise a display name for comparison: lower-case, drop a trailing
// parenthetical device tag like "(iPad)" / "(mobile)", strip emoji and
// stray punctuation, collapse whitespace.
export function normalizeHostName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Tokenise to meaningful name parts. Tokens shorter than two characters
// (bare initials like "k.") are dropped so "Karly K" can never match a
// patient whose name is just "K".
export function hostNameTokens(raw: string): string[] {
  return normalizeHostName(raw)
    .split(' ')
    .map((t) => t.replace(/^['-]+|['-]+$/g, ''))
    .filter((t) => t.length >= 2);
}

// LOOSE label match: every token of the shorter name must appear in the
// longer name, and both must have at least one token. This lets "Karly"
// match "Karly Innes", and "Karly Innes (iPad)" match "Karly Innes",
// while keeping "John Doe" from matching "John Smith".
export function staffHostNameMatches(staffName: string, participantName: string): boolean {
  const a = hostNameTokens(staffName);
  const b = hostNameTokens(participantName);
  if (a.length === 0 || b.length === 0) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  const longerSet = new Set(longer);
  return shorter.every((t) => longerSet.has(t));
}

// STRICT bind match: normalised names must be exactly equal.
export function staffHostNameExact(staffName: string, participantName: string): boolean {
  const a = normalizeHostName(staffName);
  const b = normalizeHostName(participantName);
  return a.length > 0 && a === b;
}
