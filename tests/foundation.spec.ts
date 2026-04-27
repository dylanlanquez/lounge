import { test, expect } from '@playwright/test';

// Brief §8.8 — Phase 1 smoke test:
// "A non-technical person opens lounge.venneir.com on the Galaxy Tab.
//  They see the Lounge logo, the favicon, a placeholder home screen.
//  The page loads in under 1.5 seconds on 4G."
//
// Local equivalent: load the dev server, see logo + tagline, page is interactive.

test('home renders the logo and tagline', async ({ page }) => {
  await page.goto('/');
  const logo = page.getByAltText('Lounge');
  await expect(logo).toBeVisible();
  await expect(page.getByText('Walk-ins and appointments by Venneir.')).toBeVisible();
});

test('favicon is served', async ({ request }) => {
  const response = await request.get('/lounge-fav.png');
  expect(response.status()).toBe(200);
  const buffer = await response.body();
  expect(buffer.byteLength).toBeGreaterThan(0);
});

test('unknown path renders the not-found page', async ({ page }) => {
  await page.goto('/this-page-does-not-exist');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go home' })).toBeVisible();
});
