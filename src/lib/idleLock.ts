import { useCallback, useEffect, useRef, useState } from 'react';

// ── Idle lock ────────────────────────────────────────────────────────────────
//
// Lounge runs on tablets on a public reception desk. A receptionist walks a
// patient to the chair and the screen is left showing that patient's record:
// name, date of birth, phone number, payment history, photos. Anyone standing
// at the desk can read it, and on a shared device they can also act as the
// signed-in staff member. The 2FA gate only covers sign-in, so once the tablet
// is open it stays open all day.
//
// So: after IDLE_LOCK_MS of no interaction, cover the app and ask for the
// signed-in user's password again.
//
// Two design points worth stating, because both are easy to get wrong:
//
//   1. Wall-clock, not a timer. A backgrounded tab has its timers throttled
//      to once a minute or stopped entirely, so a countdown started before
//      the tablet was locked or the tab hidden cannot be trusted. We stamp
//      the last interaction and compare against Date.now() on a tick and
//      again the moment the tab becomes visible, which means a tablet left
//      asleep for an hour is locked before its first frame is legible.
//
//   2. Locking must not unmount anything. The lock renders OVER the app, it
//      does not replace the route. A half-typed walk-in form, an open sheet
//      and the scroll position are all still there afterwards, which is what
//      makes the lock cheap enough to have a short timeout. (Cf. the tab
//      switch bug where a remount silently discarded exactly that state.)
export const IDLE_LOCK_MS = 5 * 60 * 1000;

// How often the wall clock is checked. Fine-grained enough that the lock
// arrives within a few seconds of the deadline, cheap enough to be invisible.
const TICK_MS = 5_000;

// Interaction, as far as "is somebody using this tablet" goes. Deliberately
// not `mousemove`: a desk knock or a passing sleeve keeps a kiosk unlocked
// forever, which is the failure this whole thing exists to prevent. A person
// actually working produces taps, keys, wheels and scrolls.
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

export interface IdleLockResult {
  locked: boolean;
  // Called by the lock screen once the password has been re-verified.
  unlock: () => void;
  // Lock immediately, for a "Lock now" affordance and for tests.
  lockNow: () => void;
}

export function useIdleLock(args: {
  // False on the surfaces where a lock makes no sense (signed out, the
  // sign-in and 2FA screens, the public connect pages). Flipping this to
  // false clears any existing lock: there is nothing behind it to protect.
  enabled: boolean;
  timeoutMs?: number;
}): IdleLockResult {
  const { enabled, timeoutMs = IDLE_LOCK_MS } = args;
  const [locked, setLocked] = useState(false);
  const lastActiveRef = useRef(Date.now());
  // Read inside the listeners so they can be registered once and still see
  // the current value. A locked screen must not treat the typing in its own
  // password field as activity that would extend the session behind it.
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  const unlock = useCallback(() => {
    lastActiveRef.current = Date.now();
    setLocked(false);
  }, []);

  const lockNow = useCallback(() => {
    if (!enabled) return;
    setLocked(true);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setLocked(false);
      return;
    }

    lastActiveRef.current = Date.now();

    const markActive = () => {
      if (lockedRef.current) return;
      lastActiveRef.current = Date.now();
    };

    const check = () => {
      if (lockedRef.current) return;
      if (Date.now() - lastActiveRef.current >= timeoutMs) setLocked(true);
    };

    for (const evt of ACTIVITY_EVENTS) {
      window.addEventListener(evt, markActive, { passive: true });
    }
    // The page scroll lives on #root rather than the window (body is pinned
    // for the iPad rubber-band guard), so listen in the capture phase on the
    // document to catch it wherever it happens.
    document.addEventListener('scroll', markActive, { capture: true, passive: true });
    // Coming back to the tab is the moment the deadline matters most, and
    // the tick cannot be trusted to have run while hidden.
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);

    const interval = window.setInterval(check, TICK_MS);

    return () => {
      for (const evt of ACTIVITY_EVENTS) {
        window.removeEventListener(evt, markActive);
      }
      document.removeEventListener('scroll', markActive, { capture: true });
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(interval);
    };
  }, [enabled, timeoutMs]);

  return { locked, unlock, lockNow };
}
