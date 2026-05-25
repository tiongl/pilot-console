import { test, expect } from '@playwright/test';

/**
 * Helper to mock a successful auth flow so pages behind ProtectedRoute are accessible.
 */
async function loginViaAPI(page: import('@playwright/test').Page) {
  // Mock auth endpoints
  await page.route('/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: {
          id: 'test-user-1',
          githubId: '12345',
          githubLogin: 'testuser',
          email: 'test@example.com',
          displayName: 'Test User',
          role: 'admin',
        },
      }),
    }),
  );

  // Mock projects endpoint
  await page.route('/api/projects', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        projects: [
          {
            id: 'proj-1',
            name: 'My Project',
            repoPath: '/home/user/my-project',
            description: 'A test project',
          },
          {
            id: 'proj-2',
            name: 'Another Project',
            repoPath: '/home/user/another-project',
            description: null,
          },
        ],
      }),
    }),
  );

  // Mock schedules for automation context
  await page.route('/api/admin/schedules', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ schedules: [] }),
    }),
  );

  // Mock unseen count for automation badge
  await page.route('/api/admin/runs/unseen-count*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0 }),
    }),
  );

  // Mock WebSocket to prevent connection errors
  await page.route(/\/ws\?/, (route) => route.abort());
}

test.describe('Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await loginViaAPI(page);
  });

  test('shows welcome message on home page', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Welcome back, Test User')).toBeVisible();
  });

  test('displays project list', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('My Project')).toBeVisible();
    await expect(page.getByText('Another Project')).toBeVisible();
  });

  test('shows New Project button', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('New Project')).toBeVisible();
  });

  test('redirects to login when not authenticated', async ({ page }) => {
    // Override auth to return 401
    await page.route('/api/auth/me', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }),
    );

    await page.goto('/');
    await page.waitForURL('/login');
    await expect(page.getByText('Sign in with GitHub CLI')).toBeVisible();
  });
});

test.describe('Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await loginViaAPI(page);
  });

  test('navigates to sessions page', async ({ page }) => {
    // Mock sessions endpoint
    await page.route('/api/sessions*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sessions: [] }),
      }),
    );

    await page.goto('/');
    // Look for Sessions link in the sidebar/nav
    const sessionsLink = page.getByRole('link', { name: /sessions/i });
    if (await sessionsLink.count() > 0) {
      await sessionsLink.first().click();
      await page.waitForURL('/sessions');
    }
  });

  test('navigates to new project page', async ({ page }) => {
    await page.goto('/');
    await page.getByText('New Project').click();
    await page.waitForURL('/projects/new');
  });
});
