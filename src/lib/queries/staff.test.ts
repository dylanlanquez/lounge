// The idle lock is a security control on a tablet sitting in a public room,
// and idle_lock_enabled is the one switch that turns it off. How an absent
// or unreadable value is read decides whether a missing column unlocks every
// tablet in the building, so it is worth pinning down.

import { describe, expect, it } from 'vitest';
import { idleLockEnabledFrom } from './staff.ts';

describe('idleLockEnabledFrom', () => {
  it('exempts a staff member only on an explicit false', () => {
    expect(idleLockEnabledFrom(false)).toBe(false);
  });

  it('locks a staff member who is switched on', () => {
    expect(idleLockEnabledFrom(true)).toBe(true);
  });

  it('locks when the value is missing', () => {
    // The window between this code deploying and the migration being
    // applied: PostgREST returns rows with no idle_lock_enabled at all.
    // Reading that as an exemption would unlock every tablet at once.
    expect(idleLockEnabledFrom(undefined)).toBe(true);
    expect(idleLockEnabledFrom(null)).toBe(true);
  });

  it('is not the `=== true` test used by the allowlist flags', () => {
    // Guard against someone making this "consistent" with
    // marketing_walkthrough_enabled and friends. Those default closed
    // because they grant things. This one defaults closed by staying TRUE.
    const asAllowlistWouldRead = (raw: boolean | null | undefined) => raw === true;
    expect(asAllowlistWouldRead(undefined)).toBe(false);
    expect(idleLockEnabledFrom(undefined)).toBe(true);
  });
});
