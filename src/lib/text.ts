// Shared text utilities for human-facing labels.
//
// Per the project rule: any string that lands in front of a human
// (referral source, free-text labels, statuses) reads as Title Case.
// titleCase capitalises the first letter of each word but leaves
// already-mixed-case or fully-uppercase words alone — so "facebook"
// becomes "Facebook" while "BBC News" or "iPhone repair" stay
// correct ("BBC News" / "IPhone Repair" would be wrong, the latter
// because the i prefix is a brand convention).

const SEPARATOR_RE = /(\s+|[-/&]|·)/;

export function titleCase(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .split(SEPARATOR_RE)
    .map((part) => {
      if (!part) return part;
      if (SEPARATOR_RE.test(part)) return part;
      const lower = part.toLowerCase();
      const upper = part.toUpperCase();
      // All lowercase ("facebook") → cap first letter.
      if (part === lower) return part.charAt(0).toUpperCase() + part.slice(1);
      // Already has any uppercase (BBC, iPhone, Klarna) — leave it.
      // Includes the all-uppercase case so acronyms survive.
      if (part === upper) return part; // pure acronym — leave as-is
      return part;
    })
    .join('');
}
