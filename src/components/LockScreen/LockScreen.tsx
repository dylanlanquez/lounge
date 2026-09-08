import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Lock } from 'lucide-react';
import { Avatar } from '../Avatar/Avatar.tsx';
import { Button } from '../Button/Button.tsx';
import { Input } from '../Input/Input.tsx';
import { theme } from '../../theme/index.ts';
import { useScrollLock } from '../../lib/useScrollLock.ts';
import { IDLE_LOCK_MS } from '../../lib/idleLock.ts';
import { verifyPassword } from '../../lib/verifyPassword.ts';
import { logFailure } from '../../lib/failureLog.ts';

// ── LockScreen ───────────────────────────────────────────────────────────────
//
// Shown over the whole app once the tablet has been idle. Renders OVER the
// route rather than in place of it, so the work behind it survives: the blur
// is what hides the patient record, not an unmount.
//
// Shape follows the Windows lock screen because that is the thing every
// receptionist already knows: the time first, then one person's face and name,
// then a single password field. Nothing else is offered except the way out
// (Sign out), which is there for the case the lock is looking at the wrong
// person, or at someone who signs in by link and has no password to type.
export interface LockScreenProps {
  displayName: string;
  email: string;
  // Cleared once the password has been verified against the live account.
  onUnlock: () => void;
  onSignOut: () => void;
}

export function LockScreen({ displayName, email, onUnlock, onSignOut }: LockScreenProps) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped on each rejection to restart the shake animation: re-rendering
  // with the same key would leave the CSS animation already finished.
  const [rejections, setRejections] = useState(0);
  const now = useNow();
  // Read from the timeout itself, so the copy cannot drift away from the
  // behaviour if the deadline is ever retuned.
  const idleMinutes = Math.round(IDLE_LOCK_MS / 60_000);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);

  useScrollLock(true);

  // The app behind the lock is still mounted and still focusable, so a Tab
  // would walk into the record the lock is meant to be covering. Keep focus
  // inside, and take it on mount.
  useEffect(() => {
    passwordRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const root = containerRef.current;
      if (!root) return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (!root.contains(active)) {
        e.preventDefault();
        first.focus();
        return;
      }
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    const result = await verifyPassword(email, password);
    setBusy(false);
    if (result.ok) {
      setPassword('');
      onUnlock();
      return;
    }
    setPassword('');
    setRejections((n) => n + 1);
    passwordRef.current?.focus();
    if (result.reason === 'wrong_password') {
      setError('That password is not right. Try again.');
      return;
    }
    // Not a rejection: the check itself could not be made. Say so rather
    // than implying the password was wrong, and record it, because a
    // locked-out reception desk with no explanation is an outage.
    setError(`Could not check the password: ${result.message}`);
    await logFailure({
      source: 'lock_screen.verifyPassword',
      severity: 'error',
      message: `Password check failed at the lock screen: ${result.message}`,
      context: { email },
    });
  };

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label="Lounge is locked"
      style={{
        position: 'fixed',
        inset: 0,
        // Above every other layer in the app, the photo lightbox (1000)
        // included: whatever was open when the desk went quiet has to end
        // up behind this, not in front of it.
        zIndex: 3000,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        // A tablet in landscape with the on-screen keyboard up leaves very
        // little height, and the password field is the one thing that must
        // never be pushed off screen. The gap and the clock both shrink
        // with the viewport, and anything still too tall scrolls.
        gap: `clamp(${theme.space[4]}px, 4vh, ${theme.space[10]}px)`,
        overflowY: 'auto',
        padding: theme.space[6],
        paddingTop: `calc(${theme.space[6]}px + env(safe-area-inset-top, 0px))`,
        // The app is still painted underneath. Blur plus a dark wash is what
        // makes the patient record unreadable while keeping the sense that
        // the screen was left mid-task rather than reset.
        backdropFilter: 'blur(26px) saturate(130%)',
        WebkitBackdropFilter: 'blur(26px) saturate(130%)',
        background:
          'linear-gradient(160deg, rgba(14, 20, 20, 0.82) 0%, rgba(14, 20, 20, 0.66) 45%, rgba(31, 77, 58, 0.62) 100%)',
        animation: `lng-lock-fade ${theme.motion.duration.slow}ms ${theme.motion.easing.standard} both`,
      }}
    >
      {/* Clock. First thing read on a lock screen, and the reason a glance
          at the desk tells you the tablet is idle rather than broken. */}
      <div
        className="lng-lock-clock"
        style={{
          textAlign: 'center',
          color: '#fff',
          animation: `lng-lock-rise ${theme.motion.duration.slow}ms ${theme.motion.easing.spring} both`,
        }}
      >
        <p
          style={{
            margin: 0,
            fontSize: `clamp(${theme.type.size.xl}px, 9vh, ${theme.type.size.hero}px)`,
            fontWeight: theme.type.weight.semibold,
            letterSpacing: theme.type.tracking.tight,
            lineHeight: theme.type.leading.tight,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {formatClock(now)}
        </p>
        <p
          style={{
            margin: `${theme.space[2]}px 0 0`,
            fontSize: theme.type.size.md,
            color: 'rgba(255, 255, 255, 0.72)',
          }}
        >
          {formatDay(now)}
        </p>
      </div>

      {/* The person. Name and email both shown: the tablet is shared, and
          "whose session is this" is the question staff actually have. */}
      <div
        style={{
          width: '100%',
          maxWidth: 380,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: theme.space[5],
          animation: `lng-lock-rise ${theme.motion.duration.slow}ms ${theme.motion.easing.spring} 80ms both`,
        }}
      >
        <Avatar name={displayName} size="xl" />
        <div style={{ textAlign: 'center' }}>
          <h1
            style={{
              margin: 0,
              color: '#fff',
              fontSize: theme.type.size.lg,
              fontWeight: theme.type.weight.semibold,
              letterSpacing: theme.type.tracking.tight,
            }}
          >
            {displayName}
          </h1>
          <p
            style={{
              margin: `${theme.space[1]}px 0 0`,
              color: 'rgba(255, 255, 255, 0.66)',
              fontSize: theme.type.size.sm,
            }}
          >
            {email}
          </p>
        </div>

        <form
          onSubmit={onSubmit}
          key={rejections}
          style={{
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            gap: theme.space[3],
            animation:
              rejections > 0
                ? `lng-lock-shake ${theme.motion.duration.base}ms ${theme.motion.easing.standard} both`
                : undefined,
          }}
        >
          <Input
            ref={passwordRef}
            type="password"
            autoComplete="current-password"
            aria-label="Password"
            placeholder="Enter your password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            fullWidth
          />
          <Button
            type="submit"
            variant="primary"
            size="lg"
            fullWidth
            loading={busy}
            // Deliberately NOT disabled on an empty field. A disabled
            // default submit button also blocks the browser's implicit
            // submission, so Enter would do nothing for anyone whose last
            // keystroke and Return land in the same frame, which is most
            // people typing a password. The empty case is refused in
            // onSubmit instead.
            disabled={busy}
          >
            {busy ? 'Checking…' : 'Unlock'}
          </Button>
        </form>

        {error ? (
          <p
            role="alert"
            style={{
              margin: 0,
              textAlign: 'center',
              color: '#FFD9D2',
              fontSize: theme.type.size.sm,
            }}
          >
            {error}
          </p>
        ) : null}

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: theme.space[2],
          }}
        >
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: theme.space[2],
              color: 'rgba(255, 255, 255, 0.55)',
              fontSize: theme.type.size.xs,
            }}
          >
            <Lock size={13} aria-hidden />
            {`Locked after ${idleMinutes} ${idleMinutes === 1 ? 'minute' : 'minutes'} with no activity. Your work is still open.`}
          </span>
          <button
            type="button"
            onClick={onSignOut}
            style={{
              appearance: 'none',
              border: 'none',
              background: 'none',
              padding: theme.space[2],
              color: 'rgba(255, 255, 255, 0.8)',
              fontFamily: 'inherit',
              fontSize: theme.type.size.sm,
              fontWeight: theme.type.weight.semibold,
              cursor: 'pointer',
              textDecoration: 'underline',
            }}
          >
            Not you? Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

// Ticks once a minute, aligned to the next minute boundary so the displayed
// time never sits a beat behind the wall clock.
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer = 0;
    const schedule = () => {
      const ms = 60_000 - (Date.now() % 60_000);
      timer = window.setTimeout(() => {
        setNow(new Date());
        schedule();
      }, ms);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, []);
  return now;
}

function formatClock(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

function formatDay(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(d);
}
