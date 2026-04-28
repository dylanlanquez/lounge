// Identity-resolution helpers shared between client + edge functions.
//
// Edge functions (Deno) cannot import from src/, so these utilities are
// duplicated verbatim into supabase/functions/calendly-webhook and
// supabase/functions/calendly-backfill. The vitest suite here is the
// source-of-truth for behaviour — keep both copies in sync.

const PLACEHOLDER_LOCAL_RE =
  /^(no[\-_.]?email|none|noaddress|no[\-_.]?reply|donotreply|do[\-_.]?not[\-_.]?reply|unknown|na|n\/a)$/;

const PLACEHOLDER_DOMAINS = new Set([
  'noemail.com',
  'noaddress.com',
  'example.com',
  'test.com',
  'invalid.com',
]);

// True when the email is missing, malformed, or matches a known placeholder
// pattern (noemail@*, none@*, n/a@*, noreply@*, etc.). Used to skip the
// email-based identity match in calendly-webhook + calendly-backfill so
// multiple invitees sharing a stub email don't all collapse onto one
// patient record.
export function isPlaceholderEmail(email: string | null | undefined): boolean {
  if (!email) return true;
  const trimmed = email.toLowerCase().trim();
  if (!trimmed) return true;
  if (!trimmed.includes('@')) return true;
  const [local, domain] = trimmed.split('@');
  if (!local || !domain) return true;
  if (PLACEHOLDER_LOCAL_RE.test(local)) return true;
  if (PLACEHOLDER_DOMAINS.has(domain)) return true;
  return false;
}
