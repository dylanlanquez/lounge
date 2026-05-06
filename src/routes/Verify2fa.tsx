import { type FormEvent, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Button, Card, Input, Toast } from '../components/index.ts';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useCurrentAccount } from '../lib/queries/currentAccount.ts';
import { useMfaStatus, verifyTotp } from '../lib/mfa.ts';

// AAL upgrade surface for staff who are already enrolled (have a
// verified TOTP factor) but whose current session is at AAL1 — i.e.
// they just signed in with email + password. They enter the current
// six-digit code from their authenticator and the session is
// upgraded to AAL2; the auth gate then drops them into /schedule.
//
// Lock-out recovery: if they no longer have access to their
// authenticator, an admin can use Account actions → Reset 2FA to
// drop the factor (chunk 2). On their next sign-in this surface is
// skipped (no verified factors) and they land on /enroll-2fa to
// pair a new device.

export function Verify2fa() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { account, loading: accountLoading } = useCurrentAccount();
  const mfa = useMfaStatus();

  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (authLoading || accountLoading || mfa.loading) {
    return (
      <Shell>
        <p style={{ color: theme.color.inkMuted, margin: 0 }}>Checking your session…</p>
      </Shell>
    );
  }
  if (!user) return <Navigate to="/sign-in" replace />;
  if (account && !account.is_lng_staff) return <Navigate to="/no-access" replace />;
  if (mfa.aal === 'aal2') return <Navigate to="/schedule" replace />;
  if (!mfa.hasVerifiedFactor) return <Navigate to="/enroll-2fa" replace />;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!mfa.verifiedFactorId) {
      setError('No authenticator is linked. Reload the page.');
      return;
    }
    if (code.replace(/\s/g, '').length !== 6) {
      setError('The code from your authenticator is six digits.');
      return;
    }
    setBusy(true);
    try {
      await verifyTotp({ factorId: mfa.verifiedFactorId, code });
      mfa.refresh();
      navigate('/schedule', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <Card padding="lg">
        <h1 style={titleStyle}>Two-factor sign in</h1>
        <p style={subtitleStyle}>
          Open your authenticator app and enter the six-digit code for Lounge.
        </p>

        <form
          onSubmit={onSubmit}
          style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5], marginTop: theme.space[6] }}
        >
          <Input
            label="Authenticator code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            required
            leadingIcon={<ShieldCheck size={20} />}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="123456"
          />
          <Button
            type="submit"
            variant="primary"
            size="lg"
            fullWidth
            showArrow={!busy}
            loading={busy}
            disabled={!code}
          >
            {busy ? 'Verifying…' : 'Continue'}
          </Button>
        </form>

        <p
          style={{
            marginTop: theme.space[6],
            fontSize: theme.type.size.xs,
            color: theme.color.inkSubtle,
            textAlign: 'center',
            lineHeight: theme.type.leading.relaxed,
          }}
        >
          Lost access to your authenticator? Speak to an admin and they can reset it for you in 30 seconds.
        </p>
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
          <Toast tone="error" title="Could not verify the code" description={error} duration={6000} onDismiss={() => setError(null)} />
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
