import { test, expect } from '@playwright/test';

// Cash count reconciliation slice smoke.
//
// The full flow (count by note and coin, read the difference, find the
// difference, tick off payments, export, sign) needs an authenticated
// staff session against live data, so it is exercised manually per
// docs/slices/cash-count-reconciliation.md.
//
// This automated smoke verifies the route is wired and correctly gated:
// an unauthenticated visit to /cash-counts is redirected to sign-in by
// RequireStaff, never a 404 or a blank crash.

test('cash-counts route is gated behind staff sign-in', async ({ page }) => {
  await page.goto('/cash-counts');
  await expect(page).toHaveURL(/\/sign-in/);
});
