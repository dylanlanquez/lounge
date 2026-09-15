import { test, expect } from '@playwright/test';

// Voice calls slice smoke.
//
// The full flow (flag a staff member as a voice call agent, switch the
// top bar to Voice calls, see the day narrow to calls with the next-call
// hero, book a voice call from the pinned sheet, ring the patient from
// the detail sheet) needs an authenticated staff session and the
// 20260915000001 migration on the target DB, so it is exercised
// manually per docs/slices/voice-calls.md.
//
// This automated smoke verifies the schedule route the mode lives on is
// wired and gated: an unauthenticated visit is redirected to sign-in by
// RequireStaff, never a 404 or a blank crash, and the sign-in page does
// not leak the staff top bar (where the mode switch sits).

test('schedule route is gated behind staff sign-in', async ({ page }) => {
  await page.goto('/schedule');
  await expect(page).toHaveURL(/\/sign-in/);
  await expect(page.getByRole('group', { name: 'Lounge mode' })).toHaveCount(0);
});
