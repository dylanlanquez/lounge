import { test, expect } from '@playwright/test';

// Quick Sale slice smoke.
//
// The full retail flow (attach customer, build the bag from the
// products-only picker, take payment, land in the Ledger as "Retail
// sale") needs an authenticated staff session plus Stripe test mode and
// a registered reader, so it is exercised manually per
// docs/slices/quick-sale.md.
//
// This automated smoke verifies the route is wired and correctly gated:
// an unauthenticated visit to /quick-sale is redirected to sign-in by
// RequireStaff, never a 404 or a blank crash.

test('quick-sale route is gated behind staff sign-in', async ({ page }) => {
  await page.goto('/quick-sale');
  await expect(page).toHaveURL(/\/sign-in/);
});
