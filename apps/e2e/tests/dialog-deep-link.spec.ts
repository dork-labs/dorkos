import { test, expect } from '../fixtures';

test.describe('Settings — URL Deep Links @smoke', () => {
  test('navigating to ?settings=tools opens Settings to Tools tab', async ({ page }) => {
    await page.goto('/?settings=tools');
    await page.waitForSelector('[data-testid="settings-dialog"]');
    await expect(page.getByRole('tab', { name: 'Tools' })).toHaveAttribute('aria-selected', 'true');
  });

  test('navigating to ?settings=tools&settingsSection=external-mcp scrolls into view', async ({
    page,
  }) => {
    await page.goto('/?settings=tools&settingsSection=external-mcp');
    await page.waitForSelector('[data-testid="settings-dialog"]');
    // External MCP card renders only after the /api/config query resolves —
    // wait for it to attach, then assert it gets scrolled into the viewport
    // by useDeepLinkScroll.
    const element = page.locator('[data-section="external-mcp"]');
    await element.waitFor({ state: 'attached' });
    await expect(element).toBeInViewport();
  });

  test('browser back closes the dialog', async ({ page }) => {
    await page.goto('/');
    await page.goto('/?settings=tools');
    await page.waitForSelector('[data-testid="settings-dialog"]');
    await page.goBack();
    await expect(page.locator('[data-testid="settings-dialog"]')).toBeHidden();
  });

  test('palette open updates URL after migration (settings=open)', async ({ page }) => {
    await page.goto('/');
    // Wait for app shell so the global keyboard handler is mounted.
    await page.waitForSelector('[data-testid="app-shell"]');
    // Use the in-DOM trigger button rather than a synthetic keypress so the
    // test is robust across platforms (Meta vs Control).
    await page.getByRole('button', { name: 'Open command palette' }).click();
    await page
      .getByRole('option', { name: /^Settings$/ })
      .first()
      .click();
    await page.waitForSelector('[data-testid="settings-dialog"]');
    // Palette callsite was migrated in task 2.7 — clicking the Settings entry
    // should now drive the URL via useSettingsDeepLink().open(), producing
    // `?settings=open` (no tab argument).
    await expect(page).toHaveURL(/[?&]settings=open/);
  });
});
