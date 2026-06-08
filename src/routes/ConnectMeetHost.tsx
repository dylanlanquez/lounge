import { useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Loader2, Video, XCircle } from 'lucide-react';
import { theme } from '../theme/index.ts';
import { startMeetHostOAuth, validateMeetHostInvite } from '../lib/queries/meetHosts.ts';

// Public page (no Lounge login) a remote person opens from a connect
// link an admin sent them. Validates the one-time token, then lets them
// sign into their own Google to become a Meet host. The token is the
// authorisation end to end: meet-auth-init and meet-auth-callback accept
// it in place of a Lounge session.

type Phase = 'checking' | 'ready' | 'opening' | 'invalid';

export function ConnectMeetHost() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const [phase, setPhase] = useState<Phase>('checking');
  const [label, setLabel] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setError('This link is missing its token. Ask for a fresh link.');
      setPhase('invalid');
      return;
    }
    let cancelled = false;
    (async () => {
      const res = await validateMeetHostInvite(token);
      if (cancelled) return;
      if (res.ok) {
        setLabel(res.label ?? null);
        setWorkspace(res.workspaceLabel ?? null);
        setPhase('ready');
      } else {
        setError(res.error ?? 'This link is not valid.');
        setPhase('invalid');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const onConnect = async () => {
    if (!token) return;
    setPhase('opening');
    const res = await startMeetHostOAuth(null, null, token);
    if (res.ok && res.url) {
      window.location.assign(res.url);
    } else {
      setError(res.error ?? 'Could not start Google sign-in. Ask for a fresh link.');
      setPhase('invalid');
    }
  };

  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: theme.color.bg,
        padding: theme.space[6],
      }}
    >
      <style>{`@keyframes lng-meet-spin { to { transform: rotate(360deg); } }`}</style>
      <div
        style={{
          maxWidth: 440,
          width: '100%',
          background: theme.color.surface,
          border: `1px solid ${theme.color.border}`,
          borderRadius: theme.radius.card,
          padding: theme.space[6],
          textAlign: 'center',
          boxShadow: theme.shadow.card,
        }}
      >
        {phase === 'checking' ? (
          <>
            <Loader2
              size={36}
              color={theme.color.accent}
              aria-hidden
              style={{ animation: 'lng-meet-spin 800ms linear infinite' }}
            />
            <Title>Checking your link</Title>
          </>
        ) : phase === 'invalid' ? (
          <>
            <XCircle size={36} color={theme.color.alert} aria-hidden />
            <Title>Link can’t be used</Title>
            <Body>{error ?? 'This link is not valid.'}</Body>
          </>
        ) : (
          <>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 56,
                height: 56,
                borderRadius: theme.radius.pill,
                background: theme.color.accentBg,
                color: theme.color.accent,
              }}
              aria-hidden
            >
              <Video size={26} />
            </span>
            <Title>Connect your Google account</Title>
            <Body>
              {label ? `${label}, this` : 'This'} links your Google account so you can host Lounge virtual
              appointments and have your attendance recorded.
              {workspace ? ` You’ll sign in to your ${workspace} Google account.` : ''}
            </Body>
            <button
              type="button"
              onClick={onConnect}
              disabled={phase === 'opening'}
              style={{
                appearance: 'none',
                marginTop: theme.space[5],
                width: '100%',
                padding: `${theme.space[3]}px ${theme.space[5]}px`,
                borderRadius: theme.radius.pill,
                border: 'none',
                background: theme.color.accent,
                color: '#fff',
                cursor: phase === 'opening' ? 'wait' : 'pointer',
                fontFamily: 'inherit',
                fontSize: theme.type.size.base,
                fontWeight: theme.type.weight.semibold,
                opacity: phase === 'opening' ? 0.7 : 1,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: theme.space[2],
              }}
            >
              <Video size={18} aria-hidden />
              {phase === 'opening' ? 'Opening Google…' : 'Continue with Google'}
            </button>
            <p style={{ margin: `${theme.space[4]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
              This link works once and expires. If it stops working, ask for a new one.
            </p>
          </>
        )}
      </div>
    </main>
  );
}

function Title({ children }: { children: ReactNode }) {
  return (
    <h1
      style={{
        margin: `${theme.space[4]}px 0 ${theme.space[2]}px`,
        fontSize: theme.type.size.xl,
        fontWeight: theme.type.weight.semibold,
        color: theme.color.ink,
      }}
    >
      {children}
    </h1>
  );
}

function Body({ children }: { children: ReactNode }) {
  return (
    <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted, lineHeight: 1.5 }}>
      {children}
    </p>
  );
}
