import { type ReactNode, createContext, useContext } from 'react';
import { useLocation } from 'react-router-dom';
import { LockScreen } from '../components/LockScreen/LockScreen.tsx';
import { useAuth } from './auth.tsx';
import { useCurrentAccount } from './queries/currentAccount.tsx';
import { useIdleLock } from './idleLock.ts';

// ── IdleLockProvider ─────────────────────────────────────────────────────────
//
// Owns the idle countdown, renders the lock over the whole app, and hands the
// chrome a way to lock on demand.
//
// A provider rather than a leaf component because two separate places need
// the same lock: the timer that fires on its own, and the "Lock" button in
// the profile sheet, which lives in KioskStatusBar. Someone stepping away
// from the desk should not have to wait five minutes for the screen they
// just left to be covered.
//
// Mounted above the chrome (status bar, bottom nav) and above the routes, so
// the lock covers all of it. Nothing unmounts when it appears: see
// src/lib/idleLock.ts for why that matters.

interface LockControls {
  lockNow: () => void;
}

const LockContext = createContext<LockControls | null>(null);

// Surfaces where a lock makes no sense: there is either nothing to protect
// or no session to unlock back into.
const LOCK_EXEMPT_PATHS = new Set([
  '/sign-in',
  '/welcome',
  '/enroll-2fa',
  '/verify-2fa',
  '/no-access',
  '/connect-meet-host',
]);

export function IdleLockProvider({ children }: { children: ReactNode }) {
  const { user, signOut } = useAuth();
  const { account } = useCurrentAccount();
  const { pathname } = useLocation();
  const exempt = LOCK_EXEMPT_PATHS.has(pathname) || pathname.startsWith('/auth/');
  const { locked, unlock, lockNow } = useIdleLock({ enabled: !!user && !exempt });

  // The account row carries the readable name; the session always carries the
  // email, and the email is what the password is checked against. A lock that
  // appears before the account row has landed still names the person by their
  // email rather than showing a blank card.
  const email = account?.login_email ?? user?.email ?? '';
  const shouldLock = locked && !!user;

  // Locked with no email is unrecoverable: nothing to verify the password
  // against, so the desk would be stuck behind a screen it cannot answer.
  // Treat it as a dead session instead, loudly, and let the routing gate
  // send them to /sign-in.
  if (shouldLock && !email) {
    console.error('[idle-lock] locked session has no email to verify against; signing out');
    void signOut();
  }

  return (
    <LockContext.Provider value={{ lockNow }}>
      {children}
      {shouldLock && email ? (
        <LockScreen
          displayName={account?.display_name ?? email}
          email={email}
          onUnlock={unlock}
          onSignOut={() => {
            void signOut();
            unlock();
          }}
        />
      ) : null}
    </LockContext.Provider>
  );
}

// Lock the tablet now. Returns a no-op outside the provider so a component
// rendered in isolation (Storybook, a unit test) does not have to build the
// whole auth tree to render a button it is not testing.
export function useLockControls(): LockControls {
  return useContext(LockContext) ?? { lockNow: () => {} };
}
