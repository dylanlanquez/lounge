import { type FormEvent, useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Button, Card, Input, Toast } from '../components/index.ts';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useCurrentAccount } from '../lib/queries/currentAccount.tsx';
import { startTotpEnrolment, useMfaStatus, verifyTotp } from '../lib/mfa.ts';

// Two-factor enrolment surface for staff who have require_2fa = true
// and no verified TOTP factor yet. Drops any pending unverified
// factor on load (so a half-completed previous attempt doesn't
// shadow this one) and walks through:
//
//   1. Generate a QR code + secret via supabase.auth.mfa.enroll.
//   2. User adds it to their authenticator app.
//   3. They enter the first 6-digit code.
//   4. supabase.auth.mfa.challenge + verify upgrades the session AAL
//      to aal2; the auth gate then drops them into /schedule.
//
// We don't render this if:
//   • the user isn't signed in (→ /sign-in)
//   • the user is already AAL2 (→ /schedule)
//   • they already have a verified factor (→ /verify-2fa)

export function Enroll2fa() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { account, loading: accountLoading } = useCurrentAccount();
  const mfa = useMfaStatus();

  const [factorId, setFactorId] = useState<string | null>(null);
  const [qrSvg, setQrSvg] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enrolError, setEnrolError] = useState<string | null>(null);

  // Kick off enrolment as soon as we know the user is signed in and
  // doesn't already have a verified factor. Re-run if the auth state
  // resets (e.g. sign-out then sign-in mid-session).
  useEffect(() => {
    if (authLoading || mfa.loading || !user) return;
    if (mfa.hasVerifiedFactor) return;
    if (factorId) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await startTotpEnrolment();
        if (cancelled) return;
        setFactorId(r.factorId);
        setQrSvg(r.qrSvg);
        setSecret(r.secret);
      } catch (e) {
        if (cancelled) return;
        setEnrolError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, mfa.loading, user, mfa.hasVerifiedFactor, factorId]);

  if (authLoading || accountLoading || mfa.loading) {
    return (
      <Shell>
        <p style={{ color: theme.color.inkMuted, margin: 0 }}>Setting up two-factor…</p>
      </Shell>
    );
  }
  if (!user) return <Navigate to="/sign-in" replace />;
  if (account && !account.is_lng_staff) return <Navigate to="/no-access" replace />;
  if (mfa.aal === 'aal2') return <Navigate to="/schedule" replace />;
  if (mfa.hasVerifiedFactor) return <Navigate to="/verify-2fa" replace />;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!factorId) {
      setError('Enrolment is still loading. Try again in a second.');
      return;
    }
    if (code.replace(/\s/g, '').length !== 6) {
      setError('The code from your authenticator is six digits.');
      return;
    }
    setBusy(true);
    try {
      await verifyTotp({ factorId, code });
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
        <h1 style={titleStyle}>Set up two-factor authentication</h1>
        <p style={subtitleStyle}>
          Lounge requires an authenticator app for your account. Scan this code in Google
          Authenticator, 1Password, Authy, or any TOTP app, then enter the six-digit code below.
        </p>

        <div
          style={{
            margin: `${theme.space[6]}px 0 ${theme.space[6]}px`,
            display: 'flex',
            justifyContent: 'center',
            padding: theme.space[5],
            background: theme.color.bg,
            borderRadius: theme.radius.input,
            border: `1px solid ${theme.color.border}`,
          }}
        >
          {enrolError ? (
            <p style={{ margin: 0, color: theme.color.alert, fontSize: theme.type.size.sm }}>
              {enrolError}
            </p>
          ) : qrSvg ? (
            <div
              aria-label="QR code for authenticator app"
              style={{ width: 200, height: 200 }}
              dangerouslySetInnerHTML={{ __html: qrSvg }}
            />
          ) : (
            <p style={{ margin: 0, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
              Generating QR code…
            </p>
          )}
        </div>

        {secret ? (
          <div style={{ marginBottom: theme.space[6], display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
            <p style={{ margin: 0, fontSize: theme.type.size.xs, color: theme.color.inkMuted, letterSpacing: theme.type.tracking.wide, textTransform: 'uppercase', fontWeight: theme.type.weight.semibold }}>
              Or enter this key manually
            </p>
            <code
              style={{
                display: 'block',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: theme.type.size.sm,
                color: theme.color.ink,
                background: theme.color.bg,
                border: `1px solid ${theme.color.border}`,
                borderRadius: theme.radius.input,
                padding: theme.space[3],
                letterSpacing: '0.08em',
                wordBreak: 'break-all',
              }}
            >
              {secret}
            </code>
          </div>
        ) : null}

        <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
          <Input
            label="Six-digit code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            required
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
            disabled={!code || !factorId}
          >
            {busy ? 'Verifying…' : 'Verify and continue'}
          </Button>
        </form>
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
      <div style={{ width: '100%', maxWidth: 460 }}>
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
