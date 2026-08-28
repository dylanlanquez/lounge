// ============================================================================
// GENERATED FILE - DO NOT EDIT
//
// Vendored from telemetry/packages/telemetry-browser by scripts/sync-telemetry.mjs.
// Edit the source in the telemetry repo and re-run `npm run sync:sdk`.
// Local edits here will be silently overwritten on the next sync.
// ============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// @venneir/telemetry — browser SDK
//
// One call wires an app up:
//
//   import { initTelemetry } from './lib/telemetry'
//
//   initTelemetry({
//     app: 'meridian',
//     ingestUrl: 'https://hqapybwseplcqjhxbllz.supabase.co/functions/v1/tel-ingest',
//     anonKey: import.meta.env.VITE_TELEMETRY_KEY,
//     release: import.meta.env.VITE_RELEASE,
//     resolveRoute: path => path.replace(/\/[0-9a-f-]{36}/g, '/:id'),
//   })
//
// This file is VENDORED into each app from telemetry/packages/telemetry-browser.
// Do not edit the copy inside an app: edit the source here and run
// `npm run sync:sdk` from the telemetry repo. There is no private npm registry
// in this setup, and four hand-maintained copies would diverge within a month.
//
// What it captures automatically:
//   • uncaught errors (window.onerror)
//   • unhandled promise rejections
//   • React render errors, via the exported ErrorBoundary
//   • breadcrumbs: navigation, clicks, focus, fetch, XHR, console, visibility,
//     connectivity
//   • a heartbeat, so the dashboard can tell "no errors" from "not reporting"
//
// What it deliberately does not capture: form values, request bodies, response
// bodies, or screen recordings. These apps display dental patient data, so the
// SDK is built to be safe by construction rather than by configuration.
//
// It DOES capture the signed-in staff member's name and email, so an issue can be
// traced to the people affected. That is staff data, not patient data, it is a
// deliberate decision rather than a leak, and it is governed by the
// `capture_identity` setting in the collector. Call setTelemetryUser(null) on
// sign-out so one person's identity is not attached to the next person's errors
// on a shared machine.
// ─────────────────────────────────────────────────────────────────────────────

import { scrubText, scrubUrl, scrubValue } from './scrub.js'
import { addCrumb, clearCrumbs, install as installCrumbs, snapshotCrumbs } from './breadcrumbs.js'
import { configureTransport, enqueue, flush, installFlushHooks } from './transport.js'

const HEARTBEAT_MS = 4 * 60 * 1000

let state = null

function randomId(prefix) {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 16)
    }
  } catch { /* fall through */ }
  return prefix + Math.random().toString(36).slice(2, 18)
}

/**
 * Identity, as three explicit fields rather than a hash.
 *
 * An earlier version stored only a salted hash of the user id, so an issue could
 * say "three people hit this" but never which three. That was the right default
 * for a system whose payloads might carry patient data, and the wrong answer to
 * the question this tool actually gets asked, which is "who hit it, so I can go
 * and ask them what they were doing".
 *
 * These are staff using internal tooling. The fields are top-level and set on
 * purpose, which is also why they survive the scrubbers: the key deny-list and
 * the value patterns both operate on free-text context, and deliberately do not
 * touch a field the caller filled in knowing what it was for.
 *
 * Governed by the `capture_identity` setting, read from the collector on init.
 * When it is off, nothing here is sent and issues fall back to counting.
 */
function identityFields() {
  if (!state.captureIdentity || !state.user) return {}
  return {
    user_ref: state.user.id ? String(state.user.id).slice(0, 80) : null,
    user_name: state.user.name ? String(state.user.name).slice(0, 120) : null,
    user_email: state.user.email ? String(state.user.email).slice(0, 160) : null,
  }
}

function viewport() {
  try {
    return `${window.innerWidth}x${window.innerHeight}`
  } catch {
    return null
  }
}

/** Cheap client-side identity, used only for dedupe. Real grouping is server-side. */
function signatureOf(kind, message, stack) {
  const head = (stack || '').split('\n').slice(0, 3).join('|')
  return `${kind}::${String(message).slice(0, 200)}::${head.slice(0, 300)}`
}

function buildEvent(kind, level, message, stack, extra) {
  return {
    kind,
    level,
    message: scrubText(message, 8000),
    stack: stack ? scrubText(stack, 12_000) : null,
    occurred_at: new Date().toISOString(),
    release: state.release,
    environment: state.environment,
    url: scrubUrl(typeof location !== 'undefined' ? location.href : null),
    route: state.resolveRoute
      ? safeRoute(state.resolveRoute)
      : typeof location !== 'undefined'
        ? location.pathname
        : null,
    ...identityFields(),
    session_ref: state.sessionRef,
    user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
    viewport: viewport(),
    context: scrubValue({ ...(state.context || {}), ...(extra || {}) }),
    breadcrumbs: snapshotCrumbs(),
  }
}

function safeRoute(resolveRoute) {
  try {
    return resolveRoute(location.pathname) || location.pathname
  } catch {
    return location.pathname
  }
}

/** Record an event. Never throws; a broken reporter must not break the app. */
function capture(kind, level, message, stack, extra) {
  if (!state) return null
  try {
    const event = buildEvent(kind, level, message, stack, extra)
    enqueue(event, signatureOf(kind, event.message, event.stack))
    return event
  } catch (err) {
    // Last resort. If the reporter itself is broken the original error must
    // still reach the console, so this is logged and swallowed.
    try {
      console.warn('[telemetry] capture failed:', err && err.message)
    } catch { /* nothing left to try */ }
    return null
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Wire up telemetry. Idempotent: calling twice is a no-op, which matters under
 * Vite HMR and React StrictMode double-invocation.
 */
export function initTelemetry(options) {
  if (state) return state
  if (typeof window === 'undefined') return null

  const {
    app,
    ingestUrl,
    anonKey,
    release = 'unknown',
    environment,
    resolveRoute,
    context,
    enabledInDev = false,
  } = options || {}

  if (!app || !ingestUrl || !anonKey) {
    console.warn('[telemetry] app, ingestUrl and anonKey are required; telemetry is off.')
    return null
  }

  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)
  const env = environment || (isLocal ? 'development' : 'production')

  // Off in local development by default. Otherwise every hot reload and every
  // half-finished refactor fills the dashboard with errors that were never real,
  // and the signal is lost. Opt in with enabledInDev when testing the SDK itself.
  if (isLocal && !enabledInDev) {
    console.info('[telemetry] local development: reporting disabled. Pass enabledInDev to override.')
    return null
  }

  state = {
    app,
    release,
    environment: env,
    resolveRoute,
    context: context || {},
    user: null,
    // Assumed on until the collector says otherwise. Erring towards capturing is
    // the right default for an internal tool: the setting exists to switch it
    // off deliberately, not to have it silently off because a fetch was slow.
    captureIdentity: true,
    sessionRef: randomId('s_'),
    teardown: [],
  }

  configureTransport({ app, ingestUrl, anonKey })

  state.teardown.push(installCrumbs({ resolveRoute }))
  state.teardown.push(installFlushHooks())

  // ── Uncaught errors ──
  const onError = event => {
    const error = event.error
    capture(
      'browser_error',
      'error',
      error?.message || event.message || 'Unknown error',
      error?.stack || `at ${event.filename}:${event.lineno}:${event.colno}`
    )
  }
  window.addEventListener('error', onError)
  state.teardown.push(() => window.removeEventListener('error', onError))

  // ── Unhandled rejections ──
  // A rejected promise nobody awaited is the single commonest way an async
  // failure disappears in these apps, and it produces no console entry a user
  // would ever report.
  const onRejection = event => {
    const reason = event.reason
    const message =
      reason instanceof Error
        ? reason.message
        : typeof reason === 'string'
          ? reason
          : (() => {
              try {
                return JSON.stringify(reason)
              } catch {
                return 'Unhandled promise rejection'
              }
            })()
    capture('unhandled_rejection', 'error', message, reason instanceof Error ? reason.stack : null)
  }
  window.addEventListener('unhandledrejection', onRejection)
  state.teardown.push(() => window.removeEventListener('unhandledrejection', onRejection))

  // ── Heartbeat ──
  // Sent on load and every four minutes, against a fifteen minute staleness
  // window in the dashboard. Three chances to be heard before an app is marked
  // as silent, so one dropped request does not raise a false alarm.
  const beat = () => {
    try {
      fetch(ingestUrl, {
        method: 'POST',
        keepalive: true,
        headers: {
          'Content-Type': 'application/json',
          apikey: anonKey,
          Authorization: `Bearer ${anonKey}`,
        },
        body: JSON.stringify({ app, heartbeat: true, release, environment: env }),
      }).catch(() => {})
    } catch { /* swallow */ }
  }
  beat()
  const heartbeatTimer = setInterval(beat, HEARTBEAT_MS)
  state.teardown.push(() => clearInterval(heartbeatTimer))

  // Ask the collector whether identity capture is on. Fire-and-forget: if this
  // fails the SDK keeps the assumed default rather than blocking init, because
  // error reporting must not depend on a settings lookup succeeding.
  //
  // The response is honoured for the life of the page. A toggle in the dashboard
  // takes effect on the next load, which is soon enough for a setting that
  // changes about once.
  fetch(`${ingestUrl}?settings=1`, {
    method: 'GET',
    headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
  })
    .then(response => (response.ok ? response.json() : null))
    .then(body => {
      if (body && typeof body.capture_identity === 'boolean') {
        state.captureIdentity = body.capture_identity
      }
    })
    .catch(() => {})

  return state
}

/**
 * Attach the signed-in person. Call after auth resolves, and again with null on
 * sign-out so their identity is not attached to the next person's errors on a
 * shared machine, which is the normal case on a lab or kiosk device.
 *
 * Accepts either an object or a bare id, so an app that only has the id still
 * gets useful grouping.
 */
export function setTelemetryUser(user) {
  if (!state) return
  if (!user) {
    state.user = null
    return
  }
  if (typeof user === 'string') {
    state.user = { id: user, name: null, email: null }
    return
  }
  state.user = {
    id: user.id ?? user.user_id ?? null,
    name: user.name ?? user.full_name ?? user.display_name ?? null,
    email: user.email ?? null,
  }
}

/** Merge extra context onto every subsequent event. Scrubbed like everything else. */
export function setTelemetryContext(extra) {
  if (!state) return
  state.context = { ...state.context, ...(extra || {}) }
}

/**
 * Report something the app knows is wrong but that never threw: a 409 from an
 * edge function, a validation failure, a state the code should not reach.
 *
 * Returns the event so a caller can surface a reference to the user.
 */
export function captureError(error, extra) {
  const isError = error instanceof Error
  return capture(
    'manual',
    'error',
    isError ? error.message : String(error),
    isError ? error.stack : null,
    extra
  )
}

export function captureMessage(message, level = 'warn', extra) {
  return capture('manual', level, message, null, extra)
}

/** Add an app-specific breadcrumb, for steps the automatic hooks cannot see. */
export function trail(message, data) {
  addCrumb({ type: 'manual', message: scrubText(String(message), 200), data: scrubValue(data) })
}

/** Send anything queued right now. Rarely needed; page-hide hooks handle it. */
export function flushTelemetry() {
  flush()
}

/** Tear everything down. For tests and hot reload, not for production use. */
export function shutdownTelemetry() {
  if (!state) return
  for (const fn of state.teardown) {
    try {
      fn()
    } catch { /* swallow */ }
  }
  clearCrumbs()
  state = null
}

export { default as ErrorBoundary } from './ErrorBoundary.jsx'
export { addCrumb, snapshotCrumbs }

/** Internal, exported for ErrorBoundary. Not part of the public API. */
export function __captureRender(message, stack, extra) {
  return capture('react_render', 'error', message, stack, extra)
}
