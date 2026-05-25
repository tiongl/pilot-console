import { test, expect } from '@playwright/test';

/**
 * Mock auth + common API responses for authenticated pages.
 */
async function setupAuthenticatedPage(page: import('@playwright/test').Page) {
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

  await page.route('/api/admin/schedules', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ schedules: [] }),
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

test.describe('Project Creation', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedPage(page);
    await page.route('/api/projects', (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ projects: [] }),
        });
      }
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'new-proj-1',
            name: 'New Project',
            repoPath: '/home/user/new-project',
            description: 'Test description',
          }),
        });
      }
      return route.continue();
    });
  });

  test('shows new project form', async ({ page }) => {
    await page.goto('/projects/new');
    // Look for form elements
    await expect(page.getByText(/project/i).first()).toBeVisible();
  });
});

test.describe('Project View', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedPage(page);

    await page.route('/api/projects', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          projects: [
            { id: 'proj-1', name: 'Test Project', repoPath: '/tmp/test', description: 'Test' },
          ],
        }),
      }),
    );

    await page.route('/api/projects/proj-1', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'proj-1',
          name: 'Test Project',
          repoPath: '/tmp/test',
          description: 'Test',
        }),
      }),
    );

    await page.route('/api/projects/proj-1/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      }),
    );
  });

  test('project page loads', async ({ page }) => {
    await page.goto('/projects/proj-1');
    // Should redirect to /projects/proj-1/chat
    await page.waitForURL(/\/projects\/proj-1/);
  });
});
