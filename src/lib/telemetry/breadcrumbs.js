// ============================================================================
// GENERATED FILE - DO NOT EDIT
//
// Vendored from telemetry/packages/telemetry-browser by scripts/sync-telemetry.mjs.
// Edit the source in the telemetry repo and re-run `npm run sync:sdk`.
// Local edits here will be silently overwritten on the next sync.
// ============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// breadcrumbs — the trail of what happened before the error
//
// A stack trace says where a program died. It almost never says why. The why is
// usually in the sequence: which route the user was on, which button they hit,
// which request came back 409 eight hundred milliseconds earlier. This module
// keeps the last 40 of those, in memory, and attaches them to whatever error
// fires next.
//
// Design constraints that shaped it:
//
//   • Bounded and cheap. A fixed-size ring buffer with no allocation on
//     overwrite. Instrumentation sits on hot paths (every fetch, every click),
//     so anything that allocates or serialises per event is unacceptable.
//   • Never captures content. Clicks record what was clicked, not what it said,
//     except for controls (see labelFor). Network crumbs record method, path and
//     status, never request or response bodies.
//   • Nothing thrown from here can reach the app. Instrumentation that breaks
//     the app it observes is worse than no instrumentation, so every handler is
//     wrapped and every failure is swallowed.
//   • Reversible. install() returns an uninstall function that restores the
//     original fetch, XHR and console methods, so tests and hot reload do not
//     accumulate layers of wrappers.
// ─────────────────────────────────────────────────────────────────────────────

import { scrubText, scrubUrl } from './scrub.js'

const MAX_CRUMBS = 40

// Fixed-size ring. head is the next write position; count saturates at capacity.
const ring = new Array(MAX_CRUMBS)
let head = 0
let count = 0

/** Append a crumb. Never throws. */
export function addCrumb(crumb) {
  try {
    ring[head] = { t: Date.now(), ...crumb }
    head = (head + 1) % MAX_CRUMBS
    if (count < MAX_CRUMBS) count++
  } catch {
    // A logging failure must never surface in the app.
  }
}

/** Oldest-first snapshot of the trail, with timestamps made relative. */
export function snapshotCrumbs() {
  try {
    const out = []
    const start = count < MAX_CRUMBS ? 0 : head
    for (let i = 0; i < count; i++) out.push(ring[(start + i) % MAX_CRUMBS])

    // Relative offsets rather than absolute clocks. "-4.2s" is what you actually
    // read when triaging, and it keeps the payload small.
    const now = Date.now()
    return out.map(c => {
      const { t, ...rest } = c
      return { ago_ms: now - t, ...rest }
    })
  } catch {
    return []
  }
}

export function clearCrumbs() {
  head = 0
  count = 0
  ring.fill(undefined)
}

// ── Element description ─────────────────────────────────────────────────────

/**
 * Text label for a clicked element, or null.
 *
 * Only controls contribute their text. A button reads "Approve" or "Send to
 * Cairo", which is exactly the breadcrumb you want. A table row reads the
 * patient's name, which is exactly the breadcrumb you must not have. Limiting
 * text capture to controls draws that line structurally rather than hoping a
 * regex catches every name.
 */
function labelFor(el) {
  const tag = el.tagName ? el.tagName.toLowerCase() : ''
  const role = el.getAttribute ? el.getAttribute('role') : null
  const isControl =
    tag === 'button' ||
    tag === 'a' ||
    tag === 'summary' ||
    role === 'button' ||
    role === 'tab' ||
    role === 'menuitem' ||
    (tag === 'input' && ['submit', 'button', 'reset'].includes((el.type || '').toLowerCase()))

  if (!isControl) return null
  const text = (el.textContent || el.value || '').trim().replace(/\s+/g, ' ')
  if (!text) return null
  // Scrubbed anyway, as belt and braces against a control whose label is
  // generated from data.
  return scrubText(text.slice(0, 60), 60)
}

/** Stable, content-free selector-ish description of an element. */
function describe(el) {
  try {
    if (!el || !el.tagName) return 'unknown'
    const parts = [el.tagName.toLowerCase()]
    if (el.id) parts.push(`#${el.id}`)

    const testId = el.getAttribute && (el.getAttribute('data-testid') || el.getAttribute('data-tel'))
    if (testId) parts.push(`[${testId}]`)

    if (el.className && typeof el.className === 'string') {
      const cls = el.className.trim().split(/\s+/).slice(0, 2).join('.')
      if (cls) parts.push(`.${cls}`)
    }
    return parts.join('')
  } catch {
    return 'unknown'
  }
}

// ── Instrumentation ─────────────────────────────────────────────────────────

/**
 * Install every listener and wrapper. Returns an uninstall function.
 *
 * `resolveRoute` is optional and app-supplied: it turns location.pathname into
 * the router's path PATTERN ('/cases/:id' rather than '/cases/8fa1...'). Route
 * patterns keep crumb cardinality low and keep record ids out of the payload.
 */
export function install({ resolveRoute } = {}) {
  if (typeof window === 'undefined') return () => {}

  const teardown = []
  const routeOf = path => {
    try {
      return (resolveRoute && resolveRoute(path)) || path
    } catch {
      return path
    }
  }

  // ── Navigation ──
  // history.pushState is patched rather than listened to because SPAs navigate
  // without firing any event; popstate alone would miss every in-app link.
  const origPush = history.pushState
  const origReplace = history.replaceState

  const onNav = (kind, url) => {
    addCrumb({
      type: 'navigation',
      kind,
      to: routeOf(typeof url === 'string' ? url : location.pathname),
    })
  }

  history.pushState = function patchedPushState(...args) {
    const result = origPush.apply(this, args)
    try { onNav('push', args[2]) } catch { /* never break navigation */ }
    return result
  }
  history.replaceState = function patchedReplaceState(...args) {
    const result = origReplace.apply(this, args)
    try { onNav('replace', args[2]) } catch { /* never break navigation */ }
    return result
  }
  teardown.push(() => {
    history.pushState = origPush
    history.replaceState = origReplace
  })

  const onPopState = () => onNav('pop', location.pathname)
  window.addEventListener('popstate', onPopState)
  teardown.push(() => window.removeEventListener('popstate', onPopState))

  // ── Clicks ──
  // Capture phase, passive, so a crumb is recorded even when a handler further
  // down stops propagation or throws.
  const onClick = event => {
    try {
      const el = event.target
      if (!el || el.nodeType !== 1) return
      addCrumb({ type: 'click', target: describe(el), label: labelFor(el) })
    } catch { /* swallow */ }
  }
  window.addEventListener('click', onClick, { capture: true, passive: true })
  teardown.push(() => window.removeEventListener('click', onClick, { capture: true }))

  // ── Input focus ──
  // Which field they were in, never what they typed.
  const onFocus = event => {
    try {
      const el = event.target
      if (!el || !el.tagName) return
      const tag = el.tagName.toLowerCase()
      if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return
      addCrumb({ type: 'focus', target: describe(el), field: el.name || el.id || null })
    } catch { /* swallow */ }
  }
  window.addEventListener('focusin', onFocus, { capture: true, passive: true })
  teardown.push(() => window.removeEventListener('focusin', onFocus, { capture: true }))

  // ── fetch ──
  if (typeof window.fetch === 'function') {
    const origFetch = window.fetch
    window.fetch = function patchedFetch(input, init) {
      const started = Date.now()
      let method = 'GET'
      let url = ''
      try {
        method = (init && init.method) || (input && input.method) || 'GET'
        url = typeof input === 'string' ? input : (input && input.url) || String(input)
      } catch { /* fall through with defaults */ }

      return origFetch.apply(this, arguments).then(
        response => {
          addCrumb({
            type: 'fetch',
            method: String(method).toUpperCase(),
            url: scrubUrl(url),
            status: response.status,
            ms: Date.now() - started,
          })
          return response
        },
        error => {
          addCrumb({
            type: 'fetch',
            method: String(method).toUpperCase(),
            url: scrubUrl(url),
            status: 0,
            ms: Date.now() - started,
            error: scrubText(error && error.message ? error.message : 'network error', 200),
          })
          // Rethrow untouched. The wrapper observes; it must not alter the
          // rejection the caller sees.
          throw error
        }
      )
    }
    teardown.push(() => { window.fetch = origFetch })
  }

  // ── XMLHttpRequest ──
  // Supabase Storage uploads and a few older paths still use XHR, so fetch
  // instrumentation alone would leave gaps exactly where large operations fail.
  if (typeof XMLHttpRequest !== 'undefined') {
    const origOpen = XMLHttpRequest.prototype.open
    const origSend = XMLHttpRequest.prototype.send

    XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
      try {
        this.__tel = { method: String(method || 'GET').toUpperCase(), url: String(url || '') }
      } catch { /* swallow */ }
      return origOpen.call(this, method, url, ...rest)
    }

    XMLHttpRequest.prototype.send = function patchedSend(...args) {
      try {
        const meta = this.__tel
        if (meta) {
          meta.started = Date.now()
          this.addEventListener('loadend', () => {
            addCrumb({
              type: 'xhr',
              method: meta.method,
              url: scrubUrl(meta.url),
              status: this.status,
              ms: Date.now() - meta.started,
            })
          })
        }
      } catch { /* swallow */ }
      return origSend.apply(this, args)
    }

    teardown.push(() => {
      XMLHttpRequest.prototype.open = origOpen
      XMLHttpRequest.prototype.send = origSend
    })
  }

  // ── console.error / console.warn ──
  // These four apps hold 510 console.error calls between them. Wrapping console
  // turns every one of those, written years before this system existed, into a
  // breadcrumb for free.
  const wrapped = ['error', 'warn']
  const origConsole = {}
  for (const level of wrapped) {
    if (typeof console[level] !== 'function') continue
    origConsole[level] = console[level]
    console[level] = function patchedConsole(...args) {
      try {
        const message = args
          .map(a => {
            if (typeof a === 'string') return a
            if (a instanceof Error) return `${a.name}: ${a.message}`
            try { return JSON.stringify(a) } catch { return String(a) }
          })
          .join(' ')
        addCrumb({ type: 'console', level, message: scrubText(message, 300) })
      } catch { /* swallow */ }
      return origConsole[level].apply(console, args)
    }
  }
  teardown.push(() => {
    for (const level of wrapped) {
      if (origConsole[level]) console[level] = origConsole[level]
    }
  })

  // ── Visibility ──
  // A tab that was backgrounded for twenty minutes explains a great many
  // "impossible" stale-state bugs and expired-token failures.
  const onVisibility = () => addCrumb({ type: 'visibility', state: document.visibilityState })
  document.addEventListener('visibilitychange', onVisibility)
  teardown.push(() => document.removeEventListener('visibilitychange', onVisibility))

  // ── Connectivity ──
  const onOnline = () => addCrumb({ type: 'connectivity', state: 'online' })
  const onOffline = () => addCrumb({ type: 'connectivity', state: 'offline' })
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)
  teardown.push(() => {
    window.removeEventListener('online', onOnline)
    window.removeEventListener('offline', onOffline)
  })

  return function uninstall() {
    for (const fn of teardown) {
      try { fn() } catch { /* swallow */ }
    }
  }
}
