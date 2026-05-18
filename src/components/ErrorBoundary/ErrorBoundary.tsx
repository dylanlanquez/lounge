import { Component, type ReactNode } from 'react';
import { theme } from '../../theme/index.ts';

// Catches any throw during render or in lifecycle methods of its
// children and shows a recovery surface instead of letting React unmount
// the whole tree. Until this landed, an unhandled error anywhere under
// /arrival, /in-clinic, /admin etc. just blanked the page — the
// receptionist would have to hard-reload with no idea what failed.
//
// Design notes:
// - One global boundary in App.tsx is enough for v1; if a single route
//   starts crashing repeatedly we can add a second boundary inside that
//   route so neighbouring chrome stays visible.
// - We log the full error + componentStack to console.error so Dylan
//   can paste the trace back without us asking him to dig.
// - Reset just bumps a key on the children — no full page reload —
//   so React remounts the broken subtree fresh. Dylan can also tap
//   "Reload page" if state outside React (router, fetched data) is
//   what got the surface stuck.

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  resetCount: number;
}

// True when the error looks like a stale-chunk dynamic import
// failure — what Vite throws after a new deploy when the open tab
// still holds references to the OLD hashed chunk filenames. The CDN
// has rotated to the new bundle, the old chunks 404, and the SPA's
// `*` fallback serves index.html for the missing /assets/X.js — so
// the browser reports both:
//
//   * "Failed to fetch dynamically imported module: …/Admin-….js"
//   * "Expected a JavaScript-or-Wasm module script but the server
//      responded with a MIME type of text/html"
//
// The fix is one reload. We do it automatically — no point asking
// a receptionist mid-arrival to read an error toast. Defended
// against an infinite reload loop by stamping a sessionStorage flag
// so the SECOND consecutive stale-chunk error inside the same
// session falls through to the regular error surface; if reloading
// didn't help, the user can see the message instead of getting
// stuck spinning.
function isStaleChunkError(err: Error | null | undefined): boolean {
  if (!err) return false;
  const msg = String(err.message ?? '');
  return (
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg) ||
    // Safari's flavour of the dynamic-import failure.
    /error loading dynamically imported module/i.test(msg) ||
    // Chrome flavour when index.html lands in place of a 404.
    /Expected a JavaScript-or-Wasm module script/i.test(msg) ||
    // iOS/Safari flavour of the same MIME-mismatch — the CDN served
    // index.html in place of the missing hashed chunk and Safari
    // refuses to execute it as JS. Different exact wording than
    // Chrome, so it needs its own pattern or staff stay stuck on
    // the "Try again / Reload page" screen forever.
    /is not a valid JavaScript MIME type/i.test(msg) ||
    /MIME type ['"]text\/html['"]/i.test(msg) ||
    // Firefox flavour.
    /Loading module from .* was blocked because of a disallowed MIME type/i.test(msg)
  );
}

const STALE_RELOAD_FLAG = 'lng.staleChunkReload';
// How long to honour the "we just auto-reloaded" guard before we let
// another auto-reload through. Without an expiry, a stale flag from
// an old session sticks around and any future stale-chunk lands the
// user on the manual error screen even though a fresh auto-reload
// would have fixed it. 60s is long enough to short-circuit a real
// loop (the second reload arrives well inside that window) and
// short enough that a separate stale-chunk hours later behaves like
// a first-time event.
const STALE_RELOAD_TTL_MS = 60_000;

function recentlyAutoReloaded(): boolean {
  try {
    const raw = sessionStorage.getItem(STALE_RELOAD_FLAG);
    if (!raw) return false;
    const at = Number(raw);
    if (!Number.isFinite(at)) return false;
    return Date.now() - at < STALE_RELOAD_TTL_MS;
  } catch {
    return false;
  }
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false, error: null, resetCount: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  override componentDidCatch(
    error: Error,
    info: { componentStack: string | null | undefined }
  ): void {
    console.error('[ErrorBoundary]', error, info.componentStack);
    // Auto-recover from a stale dynamic-import on first hit. We
    // hard-reload so the browser fetches the new index.html and
    // its new hashed chunk references. sessionStorage flag means
    // we don't loop if the reload itself still produces the same
    // error (e.g. the new bundle is actually broken).
    if (isStaleChunkError(error)) {
      try {
        if (!recentlyAutoReloaded()) {
          sessionStorage.setItem(STALE_RELOAD_FLAG, String(Date.now()));
          window.location.reload();
        }
      } catch {
        // sessionStorage can throw in private mode / iframes; just
        // reload anyway. Worst case we loop once and the user sees
        // the error surface on the second hit.
        window.location.reload();
      }
    } else {
      // Non-stale-chunk error — clear the reload flag so a future
      // stale-chunk crash gets its one auto-reload back.
      try {
        sessionStorage.removeItem(STALE_RELOAD_FLAG);
      } catch {
        // No-op.
      }
    }
  }

  reset = (): void => {
    // Clear the auto-reload guard so a stale-chunk error AFTER this
    // manual recovery is allowed to auto-reload once more. Without
    // this clear, staff who tap "Try again" then hit a fresh stale
    // chunk would see the manual error screen instead of the
    // automatic reload they expected on the first incident.
    try {
      sessionStorage.removeItem(STALE_RELOAD_FLAG);
    } catch {
      // No-op.
    }
    this.setState((s) => ({ hasError: false, error: null, resetCount: s.resetCount + 1 }));
  };

  reload = (): void => {
    try {
      sessionStorage.removeItem(STALE_RELOAD_FLAG);
    } catch {
      // No-op.
    }
    window.location.reload();
  };

  override render(): ReactNode {
    if (this.state.hasError) {
      // For a stale-chunk error we trigger window.location.reload()
      // in componentDidCatch. The reload is async (the browser
      // navigates on the next event-loop tick) — render a quiet
      // "Updating…" state in the gap so staff don't see the
      // regular "This page hit an error" surface flash by.
      const staleChunk = isStaleChunkError(this.state.error);
      const alreadyReloaded = recentlyAutoReloaded();
      if (staleChunk && !alreadyReloaded) {
        return (
          <main
            role="status"
            aria-live="polite"
            style={{
              minHeight: '100dvh',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: theme.space[6],
              background: theme.color.bg,
              color: theme.color.inkMuted,
              fontSize: theme.type.size.sm,
            }}
          >
            Updating to the latest version…
          </main>
        );
      }
      return (
        <main
          role="alert"
          style={{
            minHeight: '100dvh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: theme.space[6],
            background: theme.color.bg,
          }}
        >
          <div
            style={{
              maxWidth: 520,
              width: '100%',
              background: theme.color.surface,
              border: `1px solid ${theme.color.border}`,
              borderRadius: theme.radius.card,
              padding: theme.space[6],
              boxShadow: theme.shadow.card,
              display: 'flex',
              flexDirection: 'column',
              gap: theme.space[4],
            }}
          >
            <div>
              <p
                style={{
                  margin: 0,
                  fontSize: theme.type.size.xs,
                  fontWeight: theme.type.weight.semibold,
                  color: theme.color.alert,
                  textTransform: 'uppercase',
                  letterSpacing: theme.type.tracking.wide,
                }}
              >
                Something broke
              </p>
              <h1
                style={{
                  margin: `${theme.space[2]}px 0 0`,
                  fontSize: theme.type.size.xl,
                  fontWeight: theme.type.weight.semibold,
                  color: theme.color.ink,
                  letterSpacing: theme.type.tracking.tight,
                }}
              >
                This page hit an error
              </h1>
            </div>
            <p style={{ margin: 0, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
              {this.state.error?.message || 'Unknown error.'}
            </p>
            {this.state.error?.stack ? (
              <details
                style={{
                  background: theme.color.bg,
                  border: `1px solid ${theme.color.border}`,
                  borderRadius: theme.radius.input,
                  padding: theme.space[3],
                }}
              >
                <summary
                  style={{
                    cursor: 'pointer',
                    fontSize: theme.type.size.xs,
                    fontWeight: theme.type.weight.medium,
                    color: theme.color.inkMuted,
                  }}
                >
                  Show technical detail
                </summary>
                <pre
                  style={{
                    margin: `${theme.space[2]}px 0 0`,
                    fontSize: 11,
                    lineHeight: 1.4,
                    color: theme.color.ink,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {this.state.error.stack}
                </pre>
              </details>
            ) : null}
            <div style={{ display: 'flex', gap: theme.space[2], justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={this.reset}
                style={{
                  appearance: 'none',
                  border: `1px solid ${theme.color.border}`,
                  background: theme.color.surface,
                  color: theme.color.ink,
                  borderRadius: theme.radius.pill,
                  padding: `${theme.space[2]}px ${theme.space[4]}px`,
                  fontFamily: 'inherit',
                  fontSize: theme.type.size.sm,
                  fontWeight: theme.type.weight.medium,
                  cursor: 'pointer',
                }}
              >
                Try again
              </button>
              <button
                type="button"
                onClick={this.reload}
                style={{
                  appearance: 'none',
                  border: 'none',
                  background: theme.color.ink,
                  color: theme.color.surface,
                  borderRadius: theme.radius.pill,
                  padding: `${theme.space[2]}px ${theme.space[4]}px`,
                  fontFamily: 'inherit',
                  fontSize: theme.type.size.sm,
                  fontWeight: theme.type.weight.semibold,
                  cursor: 'pointer',
                }}
              >
                Reload page
              </button>
            </div>
          </div>
        </main>
      );
    }
    return <ErrorBoundaryChild key={this.state.resetCount}>{this.props.children}</ErrorBoundaryChild>;
  }
}

// Stable wrapper so React can re-mount children on reset by changing
// the key without losing the boundary itself.
function ErrorBoundaryChild({ children }: { children: ReactNode }): ReactNode {
  return children;
}
