import { describe, expect, it } from 'vitest';
import { shouldShowBottomNav } from './BottomNav.tsx';

describe('shouldShowBottomNav', () => {
  it('hides when the user is not signed in', () => {
    expect(shouldShowBottomNav('/schedule', false)).toBe(false);
    expect(shouldShowBottomNav('/admin', false)).toBe(false);
  });

  it('hides on the sign-in page even if a stale auth flag is set', () => {
    expect(shouldShowBottomNav('/sign-in', true)).toBe(false);
  });

  it('shows on every authenticated route', () => {
    expect(shouldShowBottomNav('/schedule', true)).toBe(true);
    expect(shouldShowBottomNav('/walk-in/new', true)).toBe(true);
    expect(shouldShowBottomNav('/visit/abc-123', true)).toBe(true);
    expect(shouldShowBottomNav('/patient/abc-123', true)).toBe(true);
    expect(shouldShowBottomNav('/admin', true)).toBe(true);
  });
});
