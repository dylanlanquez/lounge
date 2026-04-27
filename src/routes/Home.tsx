import { useState } from 'react';
import { Mail } from 'lucide-react';
import { Button, Card, Input, StatusPill } from '../components/index.ts';
import { theme } from '../theme/index.ts';

// Phase 2 preview home. NOT the real sign-in (that ships in Phase 3 slice 1).
// This page exists so progress is visible on the deployed site as the design
// system fills in. It composes Button + Input + Card + StatusPill so we can see
// the primitives behaving in realistic context.

export function Home() {
  const [email, setEmail] = useState('');
  const [pin, setPin] = useState('');

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
            Receptionist email and 6-digit PIN.
          </p>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              // Phase 2 preview only. Real flow lands in slice 1.
            }}
            style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}
          >
            <Input
              label="Email"
              type="email"
              placeholder="dylan@venneir.com"
              autoComplete="email"
              leadingIcon={<Mail size={20} />}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Input
              label="PIN"
              type="password"
              placeholder="••••••"
              inputMode="numeric"
              autoComplete="current-password"
              maxLength={6}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
            />
            <Button type="submit" variant="primary" size="lg" fullWidth showArrow disabled>
              Sign in
            </Button>
          </form>
        </Card>

        <PreviewNote />
      </div>
    </main>
  );
}

function PreviewNote() {
  return (
    <div
      style={{
        marginTop: theme.space[8],
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: theme.space[3],
      }}
    >
      <div style={{ display: 'flex', gap: theme.space[2], flexWrap: 'wrap', justifyContent: 'center' }}>
        <StatusPill tone="neutral" size="sm">Phase 2</StatusPill>
        <StatusPill tone="in_progress" size="sm">Design system</StatusPill>
        <StatusPill tone="complete" size="sm">Foundation done</StatusPill>
      </div>
      <p
        style={{
          margin: 0,
          fontSize: theme.type.size.xs,
          color: theme.color.inkSubtle,
          textAlign: 'center',
          maxWidth: 320,
        }}
      >
        Preview build. Sign-in flow lands in Phase 3 slice 1; the form here is for visual review of the design primitives.
      </p>
    </div>
  );
}
