import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { Lock } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Input, Toast } from '../components/index.ts';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { supabase } from '../lib/supabase.ts';

// Landing surface for new staff who clicked the invite link in the
// staff_invite email. Supabase verifies the invite token and
// redirects here with an active session in the URL hash; the
// supabase-js client picks the hash up automatically and
// AuthProvider hydrates the session before this component mounts.
//
// The user is authenticated at this point but has no password set
// yet, so they'd be locked out the moment the session expires
// without a way to sign back in. This screen is the bridge: it
// captures a chosen password, calls auth.updateUser, then drops them
// into the app proper.
//
// Reused later (chunk 2) for password recovery — same UI, just
// triggered by a "Send password reset link" action from the staff
// admin instead of an invite. The detection switch reads the URL
// hash type on first load and stashes it in state.

type Mode = 'invite' | 'recovery' | 'unknown';

function readHashMode(): Mode {
  if (typeof window === 'undefined') return 'unknown';
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return 'unknown';
  const params = new URLSearchParams(hash);
  const t = params.get('type');
  if (t === 'invite') return 'invite';
  if (t === 'recovery') return 'recovery';
  return 'unknown';
}

// Read ?invite=<uuid> from the URL. This is the Lounge-side custom
// invite token the email contains — distinct from the Supabase
// session that lives in the hash fragment.
function readInviteToken(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const t = (params.get('invite') ?? '').trim();
  return t.length > 0 ? t : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type InviteExchangeState =
  | { kind: 'idle' }
  | { kind: 'exchanging' }
  | { kind: 'error'; message: string };

export function Welcome() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const [mode] = useState<Mode>(() => readHashMode());
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const inviteToken = useMemo(() => readInviteToken(), []);
  const [exchange, setExchange] = useState<InviteExchangeState>(() =>
    inviteToken ? { kind: 'exchanging' } : { kind: 'idle' },
  );

  // ── Custom-token exchange ──────────────────────────────────────
  // When the URL has ?invite=<uuid> AND we don't already have a
  // session (the user might already be signed in if they followed
  // through and reloaded), call lng-accept-invite. It validates the
  // token, mints a fresh Supabase magic-link, and we redirect the
  // browser to it. Supabase then verifies, signs the user in, and
  // bounces back to /welcome with a session in the URL hash —
  // which the supabase-js client picks up automatically and feeds
  // into AuthProvider.
  useEffect(() => {
    if (!inviteToken) return;
    if (user) {
      // Already signed in — the invite was already exchanged in a
      // previous tab or a previous click. Just drop the ?invite=
      // from the URL and let the password-set UI render.
      const next = new URL(window.location.href);
      next.searchParams.delete('invite');
      window.history.replaceState({}, '', next.toString());
      setExchange({ kind: 'idle' });
      return;
    }
    if (!UUID_RE.test(inviteToken)) {
      setExchange({ kind: 'error', message: 'The invite link is malformed.' });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { data, error: invokeErr } = await supabase.functions.invoke<unknown>(
          'lng-accept-invite',
          { body: { invite_token: inviteToken } },
        );
        if (cancelled) return;
        if (invokeErr) {
          setExchange({
            kind: 'error',
            message:
              'We could not validate your invite. Ask your administrator to resend it from the Staff tab.',
          });
          return;
        }
        const payload = (data ?? {}) as {
          ok?: boolean;
          action_link?: string;
          message?: string;
          reason?: string;
        };
        if (!payload.ok || !payload.action_link) {
          setExchange({
            kind: 'error',
            message:
              payload.message ??
              'This invite is no longer valid. Ask your administrator to resend it from the Staff tab.',
          });
          return;
        }
        // Hand the browser off to the Supabase magic-link. The page
        // will navigate away from this tab, so no further state
        // updates are needed.
        window.location.assign(payload.action_link);
      } catch (e) {
        if (cancelled) return;
        setExchange({
          kind: 'error',
          message:
            e instanceof Error
              ? e.message
              : 'Could not validate your invite. Please ask your administrator to resend it.',
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [inviteToken, user]);

  // After a successful update, give the auth context a moment to
  // settle, then bounce to the app shell. The router does the
  // RequireStaff check there.
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => navigate('/schedule', { replace: true }), 800);
    return () => clearTimeout(t);
  }, [done, navigate]);

  if (loading || exchange.kind === 'exchanging') {
    return (
      <Shell>
        <p style={{ color: theme.color.inkMuted, margin: 0 }}>
          {exchange.kind === 'exchanging' ? 'Signing you in…' : 'Checking your invite…'}
        </p>
      </Shell>
    );
  }

  // Custom-token exchange failed before we ever got a session. We
  // know what went wrong (expired / consumed / inactive) so the
  // copy here is specific instead of the generic "expired" page.
  if (exchange.kind === 'error') {
    return (
      <Shell>
        <Card padding="lg">
          <h1 style={titleStyle}>We could not sign you in</h1>
          <p style={subtitleStyle}>{exchange.message}</p>
          <div style={{ marginTop: theme.space[6] }}>
            <Button variant="secondary" fullWidth onClick={() => navigate('/sign-in', { replace: true })}>
              Go to sign in
            </Button>
          </div>
        </Card>
      </Shell>
    );
  }

  // No session AND no invite token in the URL means the link was
  // opened with neither the Supabase session hash NOR our custom
  // invite token. Either way the user can't proceed without a
  // fresh invite.
  if (!user) {
    return (
      <Shell>
        <Card padding="lg">
          <h1 style={titleStyle}>This invite link is no longer valid</h1>
          <p style={subtitleStyle}>
            Either it has expired, or it has already been used. Speak to your administrator
            and they can issue a fresh invite.
          </p>
          <div style={{ marginTop: theme.space[6] }}>
            <Button variant="secondary" fullWidth onClick={() => navigate('/sign-in', { replace: true })}>
              Go to sign in
            </Button>
          </div>
        </Card>
      </Shell>
    );
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('Use at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    const { error: upErr } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    setDone(true);
  };

  const heading = mode === 'recovery' ? 'Choose a new password' : 'Welcome to Lounge';
  const subhead =
    mode === 'recovery'
      ? "You're signed in via a one-time recovery link. Set a new password to finish."
      : "You're signed in via an invite link. Set a password to finish setting up your account.";

  return (
    <Shell>
      <Card padding="lg">
        <h1 style={titleStyle}>{heading}</h1>
        <p style={subtitleStyle}>{subhead}</p>

        {done ? (
          <div style={{ marginTop: theme.space[6], color: theme.color.accent }}>
            Password saved. Taking you in…
          </div>
        ) : (
          <form
            onSubmit={onSubmit}
            style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5], marginTop: theme.space[6] }}
          >
            <Input
              label="New password"
              type="password"
              autoComplete="new-password"
              autoFocus
              required
              leadingIcon={<Lock size={20} />}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
            />
            <Input
              label="Confirm password"
              type="password"
              autoComplete="new-password"
              required
              leadingIcon={<Lock size={20} />}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
            <Button
              type="submit"
              variant="primary"
              size="lg"
              fullWidth
              showArrow={!busy}
              loading={busy}
              disabled={!password || !confirm}
            >
              {busy ? 'Saving…' : 'Save password'}
            </Button>
          </form>
        )}
      </Card>

      {error ? (
        <div
          style={{
            position: 'fixed',
            bottom: theme.space[6],
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 100,
          }}
        >
          <Toast tone="error" title="Could not save password" description={error} duration={6000} onDismiss={() => setError(null)} />
        </div>
      ) : null}
    </Shell>
  );
}

const titleStyle = {
  margin: 0,
  fontSize: theme.type.size.lg,
  fontWeight: theme.type.weight.semibold,
  letterSpacing: theme.type.tracking.tight,
} as const;

const subtitleStyle = {
  margin: `${theme.space[2]}px 0 0`,
  color: theme.color.inkMuted,
  fontSize: theme.type.size.sm,
  lineHeight: theme.type.leading.relaxed,
} as const;

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main
      style={{
        minHeight: '100dvh',
        background: theme.color.bg,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: theme.space[6],
        paddingTop: `calc(${theme.space[6]}px + env(safe-area-inset-top, 0px))`,
        position: 'relative',
      }}
    >
      <div style={{ width: '100%', maxWidth: 420 }}>
        <header
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: theme.space[2],
            marginBottom: theme.space[8],
          }}
        >
          <img
            src="/lounge-logo.png"
            alt="Lounge"
            style={{ width: 'min(50vw, 200px)', height: 'auto' }}
          />
        </header>
        {children}
      </div>
    </main>
  );
}
