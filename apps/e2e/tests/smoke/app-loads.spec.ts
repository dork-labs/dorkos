import { test, expect } from '../../fixtures';

test.describe('Smoke — App Loading @smoke', () => {
  test('renders the app shell', async ({ basePage }) => {
    await basePage.goto();
    await basePage.waitForAppReady();

    // App shell should be visible
    await expect(basePage.page.locator('[data-testid="app-shell"]')).toBeVisible();
  });

  test('sidebar has session list and controls', async ({ basePage }) => {
    await basePage.goto();
    await basePage.waitForAppReady();
    await basePage.ensureSidebarOpen();

    // PRE-EXISTING STALENESS (predates the roster/inspector shell, not this PR):
    // no `session-sidebar` testid has ever existed in client source, and the web
    // roster has no `new chat` button. Left as-is — there is no stable roster
    // testid to retarget to, and this Playwright suite is not wired into CI.
    await expect(basePage.page.locator('[data-testid="session-sidebar"]')).toBeVisible();
    await expect(basePage.page.getByRole('button', { name: /new chat/i })).toBeVisible();
  });

  test('shows chat panel and status line after creating a session', async ({ chatPage }) => {
    await expect(chatPage.panel).toBeVisible();
    await expect(chatPage.page.locator('[data-testid="status-line"]')).toBeVisible();
  });
});
