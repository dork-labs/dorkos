import { test, expect } from '../../fixtures';

test.describe('Smoke — App Loading @smoke', () => {
  test('renders the app shell', async ({ basePage }) => {
    await basePage.goto();
    await basePage.waitForAppReady();

    // App shell should be visible
    await expect(basePage.page.locator('[data-testid="app-shell"]')).toBeVisible();
  });

  for (const route of ['/', '/marketplace']) {
    test(`the sidebar helper expands a collapsed desktop sidebar and leaves it open on ${route}`, async ({
      page,
      basePage,
    }) => {
      await page.setViewportSize({ width: 1280, height: 720 });
      await basePage.goto(route);
      await basePage.waitForAppReady();

      const sidebar = page.locator('[data-slot="sidebar"]');
      await expect(sidebar).toHaveAttribute('data-state', 'expanded');
      await page.locator('[data-slot="sidebar-trigger"]').click();
      await expect(sidebar).toHaveAttribute('data-state', 'collapsed');

      await basePage.ensureSidebarOpen();
      await expect(sidebar).toHaveAttribute('data-state', 'expanded');
      await expect(sidebar.locator('[data-slot="sidebar-inner"]')).toBeInViewport({
        ratio: 1,
      });

      await basePage.ensureSidebarOpen();
      await expect(sidebar).toHaveAttribute('data-state', 'expanded');
    });
  }

  test('shows chat panel and status line after creating a session', async ({ chatPage }) => {
    await expect(chatPage.panel).toBeVisible();
    await expect(chatPage.page.locator('[data-testid="status-line"]')).toBeVisible();
  });
});
