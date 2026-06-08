import { useEffect, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { theme } from '../theme/index.ts';
import { completeMeetHostOAuth } from '../lib/queries/meetHosts.ts';
import { useAuth } from '../lib/auth.tsx';

// Landing page after Google's OAuth consent redirect. Pulls ?code= +
// ?state= off the URL, hands them to the meet-auth-callback edge
// function, then routes back to Admin > Services with a toast-friendly
// querystring.
//
// Why this is a dedicated page and not an in-place modal: Google needs
// a stable HTTPS redirect URI registered with the Cloud Console, and
// it must resolve to a SPA route that loads quickly and is reachable
// without user interaction. Embedding the round-trip inside an admin
// dialog would force the admin to keep that dialog open during the
// Google flow, which the OAuth popup pattern doesn't guarantee.

export function GoogleMeetCallback() {
  const [params] = useSearchParams();
  const { user, loading: authLoading } = useAuth();
  const [status, setStatus] = useState<'pending' | 'success' | 'error'>('pending');
  const [message, setMessage] = useState<string | null>(null);
  const [redirectTo, setRedirectTo] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    const code = params.get('code');
    const state = params.get('state');
    const oauthError = params.get('error');

    // A remote self-connect carries a token in the state and needs NO
    // Lounge session — the token authorises it. Only the admin-initiated
    // flow requires sign-in.
    let isTokenFlow = false;
    if (state) {
      try {
        const decoded = JSON.parse(atob(state)) as { token?: string };
        isTokenFlow = !!(decoded.token && decoded.token.trim());
      } catch {
        isTokenFlow = false;
      }
    }

    if (!user && !isTokenFlow) {
      // Not signed in — bounce to sign-in carrying the callback url
      // so the user lands back here after auth.
      const next = `/auth/google/callback${window.location.search}`;
      window.location.replace(`/sign-in?next=${encodeURIComponent(next)}`);
      return;
    }
    if (oauthError) {
      setStatus('error');
      setMessage(`Google declined the request: ${oauthError}`);
      return;
    }
    if (!code) {
      setStatus('error');
      setMessage('No authorisation code returned from Google.');
      return;
    }
    let cancelled = false;
    (async () => {
      const result = await completeMeetHostOAuth({ code, state });
      if (cancelled) return;
      if (result.ok) {
        setStatus('success');
        setMessage(`Connected ${result.host?.display_name ?? 'host'} (${result.host?.google_email ?? ''})`);
        // Admin flow returns to Services. A remote host has no admin area
        // to return to, so the success screen is the end of their journey.
        if (!isTokenFlow) {
          setTimeout(() => setRedirectTo('/admin?tab=services&meet_connected=1'), 1100);
        }
      } else {
        setStatus('error');
        setMessage(result.error ?? 'Could not complete Google connection.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params, user, authLoading]);

  if (redirectTo) return <Navigate to={redirectTo} replace />;

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
          maxWidth: 420,
          width: '100%',
          background: theme.color.surface,
          border: `1px solid ${theme.color.border}`,
          borderRadius: theme.radius.card,
          padding: theme.space[6],
          textAlign: 'center',
          boxShadow: theme.shadow.card,
        }}
      >
        <Icon status={status} />
        <h1
          style={{
            margin: `${theme.space[4]}px 0 ${theme.space[2]}px`,
            fontSize: theme.type.size.xl,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
          }}
        >
          {status === 'pending'
            ? 'Connecting Google account'
            : status === 'success'
              ? 'Host connected'
              : 'Could not connect host'}
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            lineHeight: 1.5,
          }}
        >
          {message ?? 'Talking to Google.'}
        </p>
        {status === 'error' ? (
          <a
            href="/admin?tab=services"
            style={{
              display: 'inline-block',
              marginTop: theme.space[5],
              color: theme.color.accent,
              fontSize: theme.type.size.sm,
              fontWeight: theme.type.weight.semibold,
            }}
          >
            Back to Services
          </a>
        ) : null}
      </div>
    </main>
  );
}

function Icon({ status }: { status: 'pending' | 'success' | 'error' }) {
  if (status === 'pending') {
    return (
      <Loader2
        size={36}
        color={theme.color.accent}
        aria-hidden
        style={{ animation: 'lng-meet-spin 800ms linear infinite' }}
      />
    );
  }
  if (status === 'success') {
    return <CheckCircle2 size={36} color={theme.color.accent} aria-hidden />;
  }
  return <XCircle size={36} color={theme.color.alert} aria-hidden />;
}
