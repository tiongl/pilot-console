import { test, expect } from '@playwright/test';

test.describe('Login Page', () => {
  test('shows login page with sign-in button', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByText('Pilot Console')).toBeVisible();
    await expect(page.getByText('Sign in with GitHub CLI')).toBeVisible();
    await expect(page.getByText('Sign in using your local GitHub CLI session')).toBeVisible();
  });

  test('shows GitHub CLI requirement note', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByText('gh auth login')).toBeVisible();
  });

  test('shows error on login failure', async ({ page }) => {
    await page.route('/api/auth/login', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'GitHub CLI not authenticated' }),
      }),
    );

    await page.goto('/login');
    await page.getByText('Sign in with GitHub CLI').click();
    await expect(page.getByText('GitHub CLI not authenticated')).toBeVisible();
  });

  test('shows loading state while signing in', async ({ page }) => {
    await page.route('/api/auth/login', (route) =>
      // Delay response to observe loading state
      new Promise((resolve) => setTimeout(() => resolve(route.fulfill({ status: 200, body: '{}' })), 2000)),
    );

    await page.goto('/login');
    await page.getByText('Sign in with GitHub CLI').click();
    await expect(page.getByText('Signing in…')).toBeVisible();
  });
});
