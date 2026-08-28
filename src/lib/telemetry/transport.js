// ============================================================================
// GENERATED FILE - DO NOT EDIT
//
// Vendored from telemetry/packages/telemetry-browser by scripts/sync-telemetry.mjs.
// Edit the source in the telemetry repo and re-run `npm run sync:sdk`.
// Local edits here will be silently overwritten on the next sync.
// ============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// transport — get events out of the tab, without ever making things worse
//
// The failure mode this module exists to prevent: a React render loop throwing
// the same error sixty times a second, each throw firing a POST, the tab
// saturating its connection pool, and the collector taking thousands of writes a
// second from one broken user. That turns a visual bug into an outage and a
// bill. Three mechanisms stop it.
//
//   1. Dedupe. Identical signatures inside DEDUPE_WINDOW_MS collapse into one
//      queued event with a rising duplicate_count. A render loop becomes one
//      event that says "and 4,812 more".
//   2. Rate limit. A hard ceiling per session per minute. Past it, events are
//      counted and dropped, and the next event that does get through carries the
//      dropped tally so the gap is visible rather than silent.
//   3. Circuit breaker. Consecutive transport failures back off exponentially,
//      so a collector that is down or rate-limiting is not hammered.
//
// Delivery uses sendBeacon on page hide and keepalive fetch otherwise. A crash
// is very often immediately followed by the user closing the tab or navigating
// away, and a plain fetch is cancelled on unload, which loses precisely the
// events that matter most.
// ─────────────────────────────────────────────────────────────────────────────

const FLUSH_DEBOUNCE_MS = 1200
const DEDUPE_WINDOW_MS = 10_000
const MAX_QUEUE = 30
const MAX_EVENTS_PER_MINUTE = 20
const MAX_BODY_BYTES = 400_000

let config = null
let queue = []
let flushTimer = null

// signature -> { at, event }
const recent = new Map()

let windowStartedAt = 0
let windowCount = 0
let droppedSinceLastSend = 0

let consecutiveFailures = 0
let blockedUntil = 0

export function configureTransport(next) {
  config = next
}

function nowMs() {
  return Date.now()
}

function rateLimited() {
  const now = nowMs()
  if (now - windowStartedAt > 60_000) {
    windowStartedAt = now
    windowCount = 0
  }
  if (windowCount >= MAX_EVENTS_PER_MINUTE) return true
  windowCount++
  return false
}

/**
 * Queue an event for delivery.
 *
 * `signature` is a cheap client-side identity used only for dedupe. The real
 * fingerprint that drives grouping is computed server-side in tel-ingest, so
 * grouping logic can be corrected without redeploying four applications.
 */
export function enqueue(event, signature) {
  if (!config || !config.ingestUrl) return

  const now = nowMs()

  // Dedupe first, so a repeat does not consume rate-limit budget.
  const seen = recent.get(signature)
  if (seen && now - seen.at < DEDUPE_WINDOW_MS) {
    seen.event.duplicate_count = (seen.event.duplicate_count || 1) + 1
    seen.at = now
    scheduleFlush()
    return
  }

  if (rateLimited()) {
    droppedSinceLastSend++
    return
  }

  if (droppedSinceLastSend > 0) {
    event.dropped_before = droppedSinceLastSend
    droppedSinceLastSend = 0
  }

  // Oldest-first drop. When the queue is full the newest events are the ones
  // most likely to describe the current problem, so the front is what goes.
  if (queue.length >= MAX_QUEUE) queue.shift()

  queue.push(event)
  recent.set(signature, { at: now, event })

  // Bound the dedupe map. Without this a long-lived tab with many distinct
  // errors leaks one entry per signature for the life of the session.
  if (recent.size > 100) {
    for (const [key, value] of recent) {
      if (now - value.at > DEDUPE_WINDOW_MS) recent.delete(key)
      if (recent.size <= 100) break
    }
  }

  scheduleFlush()
}

function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flush()
  }, FLUSH_DEBOUNCE_MS)
}

function buildBody(events) {
  const body = JSON.stringify({ app: config.app, events })
  if (body.length <= MAX_BODY_BYTES) return body

  // Oversized batch. Rather than dropping it, send the events with their stacks
  // and breadcrumbs trimmed: a truncated trail still identifies the bug, whereas
  // a rejected 413 tells you nothing at all.
  return JSON.stringify({
    app: config.app,
    events: events.map(e => ({
      ...e,
      stack: e.stack ? String(e.stack).slice(0, 4000) : e.stack,
      breadcrumbs: Array.isArray(e.breadcrumbs) ? e.breadcrumbs.slice(-10) : e.breadcrumbs,
      context: { _trimmed: true },
    })),
  })
}

/**
 * Send everything queued.
 *
 * `useBeacon` is set on page hide, where a normal fetch would be cancelled.
 */
export function flush(useBeacon = false) {
  if (!config || !config.ingestUrl) return
  if (queue.length === 0) return
  if (nowMs() < blockedUntil) return

  const batch = queue
  queue = []

  let body
  try {
    body = buildBody(batch)
  } catch {
    // Unserialisable payload. Dropping it is correct: retrying will not make it
    // serialisable, and the console already has the original error.
    return
  }

  if (useBeacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    try {
      // sendBeacon cannot set an Authorization header, so the anon key travels
      // as a query param here. That is not a secret being exposed: the anon key
      // is already in the public bundle, and tel-ingest treats it as a routing
      // token rather than as proof of anything.
      const url = `${config.ingestUrl}?apikey=${encodeURIComponent(config.anonKey)}`
      const ok = navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))
      if (ok) return
      // Beacon refused, usually because the payload exceeds the browser's
      // 64KB limit. Fall through to keepalive fetch.
    } catch { /* fall through */ }
  }

  fetch(config.ingestUrl, {
    method: 'POST',
    keepalive: true,
    headers: {
      'Content-Type': 'application/json',
      apikey: config.anonKey,
      Authorization: `Bearer ${config.anonKey}`,
    },
    body,
  })
    .then(response => {
      if (response.ok) {
        consecutiveFailures = 0
        return
      }
      // 4xx means this payload is unacceptable and always will be, so it is not
      // requeued. Only 5xx and network errors are worth retrying.
      if (response.status >= 500) requeue(batch)
      else consecutiveFailures = 0
      backoff()
    })
    .catch(() => {
      requeue(batch)
      backoff()
    })
}

function requeue(batch) {
  const room = MAX_QUEUE - queue.length
  if (room <= 0) return
  queue = batch.slice(-room).concat(queue)
}

function backoff() {
  consecutiveFailures++
  if (consecutiveFailures < 3) return
  // 3 failures -> 30s, 4 -> 60s, 5 -> 120s, capped at 10 minutes.
  const delay = Math.min(30_000 * 2 ** (consecutiveFailures - 3), 600_000)
  blockedUntil = nowMs() + delay
}

/** Install page-lifecycle flush hooks. Returns an uninstall function. */
export function installFlushHooks() {
  if (typeof window === 'undefined') return () => {}

  // pagehide, not beforeunload: beforeunload is unreliable on mobile Safari and
  // blocks the back/forward cache. visibilitychange covers tab switches and the
  // app-backgrounded case on iOS, which is where a phone actually loses the tab.
  const onPageHide = () => flush(true)
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') flush(true)
  }

  window.addEventListener('pagehide', onPageHide)
  document.addEventListener('visibilitychange', onVisibility)

  return () => {
    window.removeEventListener('pagehide', onPageHide)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}
