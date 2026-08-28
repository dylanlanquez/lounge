// ============================================================================
// GENERATED FILE - DO NOT EDIT
//
// Vendored from telemetry/packages/telemetry-browser by scripts/sync-telemetry.mjs.
// Edit the source in the telemetry repo and re-run `npm run sync:sdk`.
// Local edits here will be silently overwritten on the next sync.
// ============================================================================

import { Component } from 'react'
import { __captureRender } from './index.js'

// ─────────────────────────────────────────────────────────────────────────────
// ErrorBoundary
//
// A React render error unmounts the whole tree and leaves a blank white page.
// window.onerror does NOT fire for it, so without a boundary these are entirely
// invisible: the user sees nothing, the console entry is lost on the next
// reload, and nobody ever finds out. Three of the four apps had no boundary at
// all when this was written.
//
// componentDidCatch gives the one thing a plain error handler cannot: the
// component stack, which names the component that actually blew up rather than
// the minified function that happened to be on top.
//
// The fallback is deliberately plain and dependency-free. It renders while the
// app is broken, so it cannot rely on the app's theme provider, router, or design
// system being in a working state. It reads correctly in light and dark via
// prefers-color-scheme rather than via any app context.
// ─────────────────────────────────────────────────────────────────────────────

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    __captureRender(error?.message || 'React render error', error?.stack || null, {
      component_stack: String(info?.componentStack || '').slice(0, 4000),
      boundary: this.props.name || 'root',
    })

    // Still logged to the console. During development that is the fastest path
    // to a fix, and in production it means a developer screen-sharing with a user
    // can read the failure without waiting for the dashboard.
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error)
  }

  render() {
    if (!this.state.error) return this.props.children

    if (this.props.fallback) {
      return typeof this.props.fallback === 'function'
        ? this.props.fallback(this.state.error, () => this.setState({ error: null }))
        : this.props.fallback
    }

    return (
      <div
        role="alert"
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          padding: 24,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif',
          background: 'Canvas',
          color: 'CanvasText',
        }}
      >
        <div style={{ maxWidth: 420, textAlign: 'center' }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Something went wrong</h1>
          <p style={{ margin: '12px 0 24px', fontSize: 15, opacity: 0.7, lineHeight: 1.5 }}>
            This screen failed to load. The problem has been reported automatically. Reloading
            usually clears it.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              height: 38,
              padding: '0 20px',
              fontSize: 15,
              fontWeight: 500,
              cursor: 'pointer',
              borderRadius: 6,
              border: '1px solid CanvasText',
              background: 'Canvas',
              color: 'CanvasText',
            }}
          >
            Reload
          </button>
        </div>
      </div>
    )
  }
}
