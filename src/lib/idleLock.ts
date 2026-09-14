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
//
//   3. The deadline survives a reload. React state does not, so a refresh,
//      a closed and reopened tab, or a crashed and restored one all used to
//      hand back an unlocked tablet and a fresh five minutes. Anyone at the
//      desk could tap reload to walk straight past the lock, which is not a
//      lock. The stamp lives in localStorage and the lock is derived from it
//      on mount, so the only ways out are the password and signing out.
export const IDLE_LOCK_MS = 5 * 60 * 1000;

// The last interaction, as a wall-clock stamp. Written at most once a tick
// rather than on every keystroke, because a few seconds of drift against a
// five-minute deadline changes nothing and a write per `wheel` event is a
// cost for nothing.
const STORAGE_KEY = 'lng.idle-lock.last-active';

// 0 is the locked sentinel: an epoch stamp is always older than any timeout,
// so "locked" and "idle past the deadline" are one state and one check.
//
// ponytail: one stamp for the whole origin, so two tabs share a deadline and
// an active tab keeps overwriting a locked sibling's sentinel. Lounge is a
// one-tab kiosk, so this is invisible; if tabs ever matter, key the stamp per
// tab and sync locks over the `storage` event instead.
const LOCKED_STAMP = 0;

// Null means no stamp has ever been written on this device, which is a real
// state (first ever load, cleared site data) and not a missing value to paper
// over. Storage itself throwing is a different matter and is logged.
function readStamp(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const stamp = Number(raw);
    if (!Number.isFinite(stamp)) {
      console.error('[idle-lock] discarding unparseable stored stamp', raw);
      return null;
    }
    return stamp;
  } catch (err) {
    console.error('[idle-lock] localStorage unreadable; the lock will not survive a reload', err);
    return null;
  }
}

function writeStamp(stamp: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(stamp));
  } catch (err) {
    console.error('[idle-lock] localStorage unwritable; the lock will not survive a reload', err);
  }
}

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

// Is the tablet safe to reload out from under whoever is standing at it?
//
// Used by the service-worker updater in src/main.tsx. A deploy reloads open
// kiosks so they stop running a stale bundle, and a reload throws away a
// half-typed walk-in, an open sheet and the scroll position. Waiting for the
// lock is what makes that affordable: behind the lock nobody is mid-anything,
// and the lock itself now survives a reload, so the reload is invisible.
//
// One comparison covers both cases worth reloading in, because the locked
// sentinel is an epoch stamp: the screen is locked, or it has been quiet for
// longer than the lock's own timeout (a signed-out tablet parked on /sign-in
// never locks, and must still get updates).
export function isLockedOrIdle(): boolean {
  const stamp = readStamp();
  // No stamp means storage is blocked or nobody has touched this device yet,
  // so there is nothing to say somebody is mid-task. A kiosk stuck on an old
  // bundle forever is the worse of the two failures.
  if (stamp === null) return true;
  return Date.now() - stamp >= IDLE_LOCK_MS;
}

export function useIdleLock(args: {
  // False on the surfaces where a lock makes no sense (signed out, the
  // sign-in and 2FA screens, the public connect pages). Flipping this to
  // false clears any existing lock: there is nothing behind it to protect.
  enabled: boolean;
  timeoutMs?: number;
}): IdleLockResult {
  const { enabled, timeoutMs = IDLE_LOCK_MS } = args;
  // Read once, on mount: the stored stamp is what a reload has to answer to.
  const [storedStamp] = useState(readStamp);
  const [locked, setLocked] = useState(
    () => storedStamp !== null && Date.now() - storedStamp >= timeoutMs,
  );
  // No stamp at all means nobody has used this device yet, so the countdown
  // starts now rather than resuming something that never happened.
  const lastActiveRef = useRef(storedStamp ?? Date.now());
  // Read inside the listeners so they can be registered once and still see
  // the current value. A locked screen must not treat the typing in its own
  // password field as activity that would extend the session behind it.
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  const unlock = useCallback(() => {
    lastActiveRef.current = Date.now();
    writeStamp(lastActiveRef.current);
    setLocked(false);
  }, []);

  const lockNow = useCallback(() => {
    if (!enabled) return;
    writeStamp(LOCKED_STAMP);
    setLocked(true);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      // Nothing behind the lock to protect, and the next person to sign in
      // must not inherit the last person's expired deadline.
      lastActiveRef.current = Date.now();
      writeStamp(lastActiveRef.current);
      setLocked(false);
      return;
    }

    const markActive = () => {
      if (lockedRef.current) return;
      lastActiveRef.current = Date.now();
    };

    const check = () => {
      if (lockedRef.current) return;
      if (Date.now() - lastActiveRef.current >= timeoutMs) {
        writeStamp(LOCKED_STAMP);
        setLocked(true);
        return;
      }
      // Mirror here rather than in markActive: one write a tick instead of
      // one per keystroke, and at most TICK_MS of drift on a 5 minute clock.
      writeStamp(lastActiveRef.current);
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
