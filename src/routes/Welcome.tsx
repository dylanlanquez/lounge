import { type FormEvent, useEffect, useState } from 'react';
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

export function Welcome() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const [mode] = useState<Mode>(() => readHashMode());
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // After a successful update, give the auth context a moment to
  // settle, then bounce to the app shell. The router does the
  // RequireStaff check there.
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => navigate('/schedule', { replace: true }), 800);
    return () => clearTimeout(t);
  }, [done, navigate]);

  if (loading) {
    return (
      <Shell>
        <p style={{ color: theme.color.inkMuted, margin: 0 }}>Checking your invite…</p>
      </Shell>
    );
  }

  // No session means the link was opened but no token attached, or
  // the token already expired and Supabase rejected it. Either way
  // the user can't proceed from here without a fresh invite.
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
