import { test, expect } from '@playwright/test';

// Before & after / Marketing photo upload smoke.
//
// The real flow (open a visit, tap "Add before", pick a file, see the
// tile fill, then find the same photo on the patient profile) needs an
// authenticated staff session, a patient with an in-progress visit, and
// write access to the case-files bucket. It is exercised manually per
// docs/slices/patient-photo-uploads.md.
//
// What is automated here is the gating: both surfaces that render the
// galleries are behind RequireStaff, so an unauthenticated visit lands
// on sign-in rather than a blank crash or a 404. Worth pinning because
// the galleries are the only place in Lounge that writes to Meridian's
// patient_files table, and an ungated route would put that write one
// URL away from anyone.

test('visit page is gated behind staff sign-in', async ({ page }) => {
  await page.goto('/visit/00000000-0000-0000-0000-000000000000');
  await expect(page).toHaveURL(/\/sign-in/);
});

test('patient profile is gated behind staff sign-in', async ({ page }) => {
  await page.goto('/patient/00000000-0000-0000-0000-000000000000');
  await expect(page).toHaveURL(/\/sign-in/);
});
