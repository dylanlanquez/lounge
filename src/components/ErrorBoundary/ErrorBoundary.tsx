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
  }

  reset = (): void => {
    this.setState((s) => ({ hasError: false, error: null, resetCount: s.resetCount + 1 }));
  };

  reload = (): void => {
    window.location.reload();
  };

  override render(): ReactNode {
    if (this.state.hasError) {
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
