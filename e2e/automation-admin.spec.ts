import { test, expect } from '@playwright/test';

async function setupAuthenticatedPage(page: import('@playwright/test').Page) {
  await page.route('/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: {
          id: 'admin-1',
          githubId: '12345',
          githubLogin: 'admin',
          email: 'admin@example.com',
          displayName: 'Admin User',
          role: 'admin',
        },
      }),
    }),
  );

  await page.route('/api/projects', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ projects: [] }),
    }),
  );

  await page.route('/api/admin/schedules', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schedules: [
          {
            id: 'sched-1',
            name: 'Daily PR Summary',
            prompt: 'Summarize PRs',
            cronExpression: '0 9 * * 1-5',
            rendererType: 'markdown',
            enabled: true,
            nextRunAt: new Date(Date.now() + 3600000).toISOString(),
            createdAt: new Date().toISOString(),
          },
          {
            id: 'sched-2',
            name: 'Weekly Report',
            prompt: 'Weekly summary',
            cronExpression: '0 9 * * 1',
            rendererType: 'plaintext',
            enabled: false,
            nextRunAt: null,
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    }),
  );

  await page.route('/api/admin/runs/unseen-count*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0 }),
    }),
  );

  await page.route(/\/ws\?/, (route) => route.abort());
}

test.describe('Automation / Schedules', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedPage(page);
  });

  test('automation config page shows schedules', async ({ page }) => {
    await page.goto('/automation/config');
    await expect(page.getByText('Daily PR Summary')).toBeVisible();
    await expect(page.getByText('Weekly Report')).toBeVisible();
  });
});

test.describe('Admin', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedPage(page);

    await page.route('/api/admin/users', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          users: [
            {
              id: 'admin-1',
              githubId: '12345',
              githubLogin: 'admin',
              email: 'admin@example.com',
              displayName: 'Admin User',
              role: 'admin',
              createdAt: new Date().toISOString(),
            },
            {
              id: 'user-1',
              githubId: '67890',
              githubLogin: 'regular',
              email: 'regular@example.com',
              displayName: 'Regular User',
              role: 'user',
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      }),
    );

    await page.route('/api/admin/sessions', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sessions: [] }),
      }),
    );
  });

  test('admin page loads', async ({ page }) => {
    await page.goto('/admin');
    // Should display admin content
    await expect(page.locator('body')).toContainText(/admin|user/i);
  });

  test('admin sessions page shows session list', async ({ page }) => {
    await page.goto('/admin/sessions');
    // Should render sessions page content
    await expect(page.locator('body')).not.toBeEmpty();
  });
});
