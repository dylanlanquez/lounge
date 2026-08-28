// ============================================================================
// GENERATED FILE - DO NOT EDIT
//
// Vendored from telemetry/packages/telemetry-browser by scripts/sync-telemetry.mjs.
// Edit the source in the telemetry repo and re-run `npm run sync:sdk`.
// Local edits here will be silently overwritten on the next sync.
// ============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// scrub — strip personal data before anything leaves the browser
//
// These apps put dental patient names, addresses, phone numbers and clinical
// notes on screen, which makes every error payload a potential UK GDPR incident
// if it is shipped verbatim. Scrubbing happens here, on the client, before the
// event is queued: data that never leaves cannot leak from the collector, from a
// backup, or from a future dashboard bug.
//
// Two independent passes, because they catch different things:
//
//   1. KEY-BASED, for structured data. `{ patient_name: '...' }` is redacted on
//      the strength of the key alone, whatever the value looks like.
//   2. VALUE-BASED, for free text. Error messages are unstructured, so an email
//      or a postcode embedded in a sentence is caught by pattern.
//
// Neither pass is sufficient alone and neither is perfect. Value patterns cannot
// recognise "Failed to save case for John Smith" as containing a name, because
// nothing in the string marks it as one. That residual risk is the reason the
// SDK never captures form values, never captures network request or response
// bodies, and never records the screen.
// ─────────────────────────────────────────────────────────────────────────────

export const REDACTED = '[redacted]'

// Key tokens that always redact. Compared against the key both as a whole with
// separators removed ('first_name' -> 'firstname') and as individual tokens
// ('patient_name' -> ['patient', 'name']), so both naming styles are caught.
const DENY_TOKENS = new Set([
  // Credentials and secrets
  'password', 'passwd', 'pwd', 'secret', 'token', 'jwt', 'apikey', 'authorization',
  'auth', 'bearer', 'credential', 'credentials', 'signature', 'privatekey',
  // Payment
  'card', 'cardnumber', 'pan', 'cvv', 'cvc', 'iban', 'sortcode', 'accountnumber',
  // Identity
  'name', 'firstname', 'lastname', 'fullname', 'surname', 'forename', 'username',
  'patient', 'customer', 'nhs', 'ssn', 'nino',
  // Contact
  'email', 'emails', 'phone', 'mobile', 'telephone', 'tel', 'address', 'address1',
  'address2', 'street', 'postcode', 'postalcode', 'zip', 'city', 'town',
  // Sensitive free text and dates of birth. Case notes in these apps routinely
  // describe a named patient's clinical situation.
  'notes', 'note', 'comment', 'comments', 'dob', 'dateofbirth', 'birthdate',
])

// Keys that LOOK sensitive under the rule above but are safe and materially
// useful for debugging, so they are allowed back through. A case reference is an
// opaque internal identifier, not personal data, and it is the single most
// useful thing to have in a trace.
const ALLOW_KEYS = new Set([
  'case_reference', 'casereference', 'order_number', 'ordernumber', 'order_name',
  'ordername', 'app_key', 'appkey', 'case_type', 'casetype', 'route', 'status',
])

const VALUE_PATTERNS = [
  // Email
  [/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, '[email]'],
  // JWT / bearer-looking blobs
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, '[jwt]'],
  // UK postcode, full or outward+inward with optional space
  [/\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/gi, '[postcode]'],
  // Card-like runs of 13 to 19 digits, optionally separated
  [/\b(?:\d[ -]?){13,19}\b/g, '[card]'],
  // UK phone numbers: 07xxx / +44 / 0xxxx with 9 or more digits
  [/(?:\+44|0)\s?\d(?:[\s-]?\d){8,12}\b/g, '[phone]'],
  // Supabase / Vercel style long opaque keys
  [/\b(?:sb|sbp|vercel)_[A-Za-z0-9_-]{16,}\b/gi, '[key]'],
]

/** Redact PII patterns from a free-text string. */
export function scrubText(input, maxLen = 4000) {
  if (typeof input !== 'string') return input
  let out = input
  for (const [pattern, replacement] of VALUE_PATTERNS) {
    out = out.replace(pattern, replacement)
  }
  return out.length > maxLen ? out.slice(0, maxLen) + '...[truncated]' : out
}

function keyIsDenied(key) {
  const flat = String(key).toLowerCase().replace(/[^a-z0-9]/g, '')
  if (ALLOW_KEYS.has(flat) || ALLOW_KEYS.has(String(key).toLowerCase())) return false
  if (DENY_TOKENS.has(flat)) return true
  return String(key)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .some(token => DENY_TOKENS.has(token))
}

/**
 * Deep-scrub an arbitrary value for transport.
 *
 * Caps depth, breadth and string length as it goes. Those caps are not
 * cosmetic: this runs on the error path, sometimes inside a render loop, and an
 * unbounded walk over a large object graph would turn one bug into a frozen tab.
 */
export function scrubValue(value, depth = 0) {
  const MAX_DEPTH = 6
  const MAX_KEYS = 60
  const MAX_ARRAY = 40

  if (value == null) return value
  if (typeof value === 'string') return scrubText(value, 2000)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'function') return '[function]'
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'symbol') return '[symbol]'

  if (depth >= MAX_DEPTH) return '[max depth]'

  if (value instanceof Error) {
    return { name: value.name, message: scrubText(value.message), stack: scrubText(value.stack, 8000) }
  }
  if (value instanceof Date) return value.toISOString()

  if (Array.isArray(value)) {
    const slice = value.slice(0, MAX_ARRAY).map(v => scrubValue(v, depth + 1))
    if (value.length > MAX_ARRAY) slice.push(`[${value.length - MAX_ARRAY} more]`)
    return slice
  }

  if (typeof value === 'object') {
    // DOM nodes, React elements, Supabase clients and similar host objects have
    // enormous graphs and no debugging value once described. Name them, do not
    // walk them.
    if (typeof Node !== 'undefined' && value instanceof Node) return `[${value.nodeName}]`
    if (value.$$typeof) return '[react element]'

    const out = {}
    let count = 0
    for (const key of Object.keys(value)) {
      if (count >= MAX_KEYS) { out['...'] = 'truncated'; break }
      count++
      out[key] = keyIsDenied(key) ? REDACTED : scrubValue(value[key], depth + 1)
    }
    return out
  }

  return '[unserialisable]'
}

/**
 * Reduce a URL to something safe and low-cardinality.
 *
 * The query string is dropped whole rather than filtered. Query params in these
 * apps carry patient search terms and customer ids, and a deny-list of param
 * names would be one forgotten param away from leaking. Dropping everything is
 * the only version that stays correct as the apps change.
 */
export function scrubUrl(rawUrl) {
  if (!rawUrl) return null
  try {
    const url = new URL(rawUrl, typeof location !== 'undefined' ? location.href : 'https://x.invalid')
    const search = url.search ? '?[stripped]' : ''
    return `${url.origin}${url.pathname}${search}`
  } catch {
    // Not a parseable URL. Fall back to text scrubbing so a malformed value is
    // still safe to send.
    return scrubText(String(rawUrl), 500)
  }
}
