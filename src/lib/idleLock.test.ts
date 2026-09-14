// @vitest-environment jsdom
//
// The lock is a security control on a machine sitting in a public room, so
// the two things worth pinning are that it arrives when nobody is using the
// tablet, and that it never arrives while somebody is.

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDLE_LOCK_MS, isLockedOrIdle, useIdleLock } from './idleLock.ts';

beforeEach(() => {
  vi.useFakeTimers();
  // The stamp is device-wide and outlives a render, which is the point of
  // it. Tests have to start from a device nobody has touched.
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

// The hook compares wall-clock stamps and only uses the interval as a
// prompt to look, so advancing timers moves both together.
const idleFor = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const interact = async () => {
  await act(async () => {
    window.dispatchEvent(new Event('pointerdown'));
  });
};

describe('useIdleLock', () => {
  it('does not lock before the timeout', async () => {
    const { result } = renderHook(() => useIdleLock({ enabled: true }));
    await idleFor(IDLE_LOCK_MS - 10_000);
    expect(result.current.locked).toBe(false);
  });

  it('locks once the timeout passes with no interaction', async () => {
    const { result } = renderHook(() => useIdleLock({ enabled: true }));
    await idleFor(IDLE_LOCK_MS + 5_000);
    expect(result.current.locked).toBe(true);
  });

  it('keeps the tablet open while someone is using it', async () => {
    const { result } = renderHook(() => useIdleLock({ enabled: true }));
    // Four minutes, a tap, four minutes again: eight minutes total, never
    // five minutes quiet.
    await idleFor(IDLE_LOCK_MS - 60_000);
    await interact();
    await idleFor(IDLE_LOCK_MS - 60_000);
    expect(result.current.locked).toBe(false);
  });

  it('ignores interaction once locked, so the lock cannot be tapped away', async () => {
    const { result } = renderHook(() => useIdleLock({ enabled: true }));
    await idleFor(IDLE_LOCK_MS + 1_000);
    expect(result.current.locked).toBe(true);
    await interact();
    await idleFor(1_000);
    expect(result.current.locked).toBe(true);
  });

  it('unlock clears the lock and starts the countdown again', async () => {
    const { result } = renderHook(() => useIdleLock({ enabled: true }));
    await idleFor(IDLE_LOCK_MS + 1_000);
    act(() => result.current.unlock());
    expect(result.current.locked).toBe(false);
    await idleFor(IDLE_LOCK_MS - 10_000);
    expect(result.current.locked).toBe(false);
    await idleFor(20_000);
    expect(result.current.locked).toBe(true);
  });

  it('never locks a surface it is disabled on', async () => {
    const { result } = renderHook(() => useIdleLock({ enabled: false }));
    await idleFor(IDLE_LOCK_MS * 3);
    expect(result.current.locked).toBe(false);
  });

  it('drops an existing lock when it is disabled, e.g. on sign-out', async () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useIdleLock({ enabled }),
      { initialProps: { enabled: true } }
    );
    await idleFor(IDLE_LOCK_MS + 1_000);
    expect(result.current.locked).toBe(true);
    rerender({ enabled: false });
    expect(result.current.locked).toBe(false);
  });

  it('locks on return to the tab when the deadline passed while it was hidden', async () => {
    const { result } = renderHook(() => useIdleLock({ enabled: true, timeoutMs: 60_000 }));
    // A hidden tab has its timers throttled or stopped, so simulate the
    // wall clock moving without the interval firing.
    await act(async () => {
      vi.setSystemTime(Date.now() + 10 * 60_000);
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(result.current.locked).toBe(true);
  });

  it('lockNow locks immediately', async () => {
    const { result } = renderHook(() => useIdleLock({ enabled: true }));
    act(() => result.current.lockNow());
    expect(result.current.locked).toBe(true);
  });

  // ── Surviving a reload ─────────────────────────────────────────────────
  //
  // A remount is every way out of the lock that is not the password: F5, a
  // hard refresh, closing the tab and reopening it, the tablet restoring the
  // session after a crash. All of them have to come back locked, or the lock
  // is decoration.

  it('is still locked after a reload', async () => {
    const first = renderHook(() => useIdleLock({ enabled: true }));
    await idleFor(IDLE_LOCK_MS + 1_000);
    expect(first.result.current.locked).toBe(true);
    first.unmount();

    const second = renderHook(() => useIdleLock({ enabled: true }));
    expect(second.result.current.locked).toBe(true);
  });

  it('is still locked after a reload when it was locked by hand', async () => {
    const first = renderHook(() => useIdleLock({ enabled: true }));
    act(() => first.result.current.lockNow());
    first.unmount();

    const second = renderHook(() => useIdleLock({ enabled: true }));
    expect(second.result.current.locked).toBe(true);
  });

  it('locks on load when the deadline passed while the tab was closed', async () => {
    const first = renderHook(() => useIdleLock({ enabled: true }));
    await idleFor(60_000);
    expect(first.result.current.locked).toBe(false);
    first.unmount();

    // Tablet off overnight, then opened again.
    vi.setSystemTime(Date.now() + 8 * 60 * 60 * 1000);
    const second = renderHook(() => useIdleLock({ enabled: true }));
    expect(second.result.current.locked).toBe(true);
  });

  it('resumes the countdown across a reload rather than restarting it', async () => {
    const first = renderHook(() => useIdleLock({ enabled: true }));
    await idleFor(IDLE_LOCK_MS - 30_000);
    first.unmount();

    // Reloading is not interaction. The 30 seconds that were left are still
    // the 30 seconds that are left, otherwise a reload loop never locks.
    const second = renderHook(() => useIdleLock({ enabled: true }));
    expect(second.result.current.locked).toBe(false);
    await idleFor(40_000);
    expect(second.result.current.locked).toBe(true);
  });

  it('comes back unlocked after a reload once the password was accepted', async () => {
    const first = renderHook(() => useIdleLock({ enabled: true }));
    await idleFor(IDLE_LOCK_MS + 1_000);
    act(() => first.result.current.unlock());
    first.unmount();

    const second = renderHook(() => useIdleLock({ enabled: true }));
    expect(second.result.current.locked).toBe(false);
  });

  // ── Safe to reload ─────────────────────────────────────────────────────
  //
  // The service-worker updater in src/main.tsx asks this before reloading a
  // kiosk out from under whoever is standing at it.

  it('is not safe to reload while somebody is working', async () => {
    const { result } = renderHook(() => useIdleLock({ enabled: true }));
    await interact();
    await idleFor(10_000);
    expect(result.current.locked).toBe(false);
    expect(isLockedOrIdle()).toBe(false);
  });

  it('is safe to reload once the screen is locked', async () => {
    const { result } = renderHook(() => useIdleLock({ enabled: true }));
    act(() => result.current.lockNow());
    expect(isLockedOrIdle()).toBe(true);
  });

  it('is safe to reload on a tablet that has gone quiet', async () => {
    renderHook(() => useIdleLock({ enabled: true }));
    await idleFor(IDLE_LOCK_MS + 1_000);
    expect(isLockedOrIdle()).toBe(true);
  });

  it('is safe to reload a device that has no stamp at all', () => {
    // Storage blocked, or nobody has ever used this tablet. Nothing says
    // somebody is mid-task, and a kiosk stranded on an old bundle is worse.
    expect(isLockedOrIdle()).toBe(true);
  });

  it('does not hand the next person to sign in an expired deadline', async () => {
    const first = renderHook(() => useIdleLock({ enabled: true }));
    await idleFor(IDLE_LOCK_MS + 1_000);
    expect(first.result.current.locked).toBe(true);
    // Signing out from the lock screen drops to a lock-exempt surface.
    first.rerender();
    const signedOut = renderHook(() => useIdleLock({ enabled: false }));
    signedOut.unmount();
    first.unmount();

    const next = renderHook(() => useIdleLock({ enabled: true }));
    expect(next.result.current.locked).toBe(false);
  });
});
