// @vitest-environment jsdom
//
// The lock is a security control on a machine sitting in a public room, so
// the two things worth pinning are that it arrives when nobody is using the
// tablet, and that it never arrives while somebody is.

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDLE_LOCK_MS, useIdleLock } from './idleLock.ts';

beforeEach(() => {
  vi.useFakeTimers();
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
});
