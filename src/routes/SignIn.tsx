import { type FormEvent, useState } from 'react';
import { Mail } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { Button, Card, Input, Toast } from '../components/index.ts';
import { KIOSK_STATUS_BAR_HEIGHT } from '../components/KioskStatusBar/KioskStatusBar.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';

export function SignIn() {
  const { user, loading, signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (loading) {
    return (
      <main
        style={{
          minHeight: '100dvh',
          background: theme.color.bg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <p style={{ color: theme.color.inkMuted }}>Checking session…</p>
      </main>
    );
  }

  if (user) return <Navigate to="/today" replace />;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    setBusy(true);
    setError(null);
    const result = await signIn(email, password);
    setBusy(false);
    if (!result.ok) setError(result.error ?? 'Could not sign in.');
  };

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
        paddingTop: `calc(${KIOSK_STATUS_BAR_HEIGHT}px + ${theme.space[6]}px + env(safe-area-inset-top, 0px))`,
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
          <p
            style={{
              margin: 0,
              color: theme.color.inkMuted,
              fontSize: theme.type.size.md,
              textAlign: 'center',
            }}
          >
            Walk-ins and appointments by Venneir.
          </p>
        </header>

        <Card padding="lg">
          <h1
            style={{
              margin: 0,
              fontSize: theme.type.size.lg,
              fontWeight: theme.type.weight.semibold,
              letterSpacing: theme.type.tracking.tight,
            }}
          >
            Sign in to your tablet
          </h1>
          <p
            style={{
              margin: `${theme.space[2]}px 0 ${theme.space[6]}px`,
              color: theme.color.inkMuted,
              fontSize: theme.type.size.sm,
            }}
          >
            Receptionist email and PIN.
          </p>

          <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
            <Input
              label="Email"
              type="email"
              autoComplete="email"
              autoFocus
              required
              leadingIcon={<Mail size={20} />}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="dylan@venneir.com"
            />
            <Input
              label="PIN"
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••"
            />
            <Button
              type="submit"
              variant="primary"
              size="lg"
              fullWidth
              showArrow={!busy}
              loading={busy}
              disabled={!email || !password}
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </Card>

        <p
          style={{
            marginTop: theme.space[6],
            fontSize: theme.type.size.xs,
            color: theme.color.inkSubtle,
            textAlign: 'center',
          }}
        >
          Trouble signing in? Speak to Dylan; PIN reset takes 30 seconds.
        </p>
      </div>

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
          <Toast tone="error" title="Sign in failed" description={error} duration={6000} onDismiss={() => setError(null)} />
        </div>
      ) : null}
    </main>
  );
}
