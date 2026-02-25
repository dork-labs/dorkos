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

    await expect(basePage.page.locator('[data-testid="session-sidebar"]')).toBeVisible();
    await expect(basePage.page.getByRole('button', { name: /new chat/i })).toBeVisible();
  });

  test('shows chat panel and status line after creating a session', async ({ chatPage }) => {
    await expect(chatPage.panel).toBeVisible();
    await expect(chatPage.page.locator('[data-testid="status-line"]')).toBeVisible();
  });
});
