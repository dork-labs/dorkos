import { test, expect } from '../fixtures';
import { openFromCommandPalette } from '../pages/command-palette';

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
    // The shared opener presses the in-DOM trigger rather than a synthetic
    // keypress, so the test is robust across platforms (Meta vs Control), and
    // types the name — Settings is not a row until someone does.
    await openFromCommandPalette(page, 'Settings');
    await page.waitForSelector('[data-testid="settings-dialog"]');
    // Palette callsite was migrated in task 2.7 — clicking the Settings entry
    // should now drive the URL via useSettingsDeepLink().open(), producing
    // `?settings=open` (no tab argument).
    await expect(page).toHaveURL(/[?&]settings=open/);
  });

  test('navigating to ?panel=profile opens the profile on a fresh tab', async ({
    page,
    rightPanel,
    roomsApi,
  }) => {
    // A browser-level check on purpose: the deep link has unit coverage, but
    // only a real fresh tab proves it survives with no in-app opener having
    // populated any store first.
    const agent = await roomsApi.registerAgent(`E2E Profile ${roomsApi.runId}`, '🛠️', '#22c55e');
    await page.goto(
      `/session?panel=profile&profilePage=sessions&dir=${encodeURIComponent(agent.projectPath)}`
    );
    await page.waitForSelector('[data-testid="app-shell"]');

    await expect(rightPanel.header).toBeVisible();
    await expect(rightPanel.profileTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-slot="profile"][data-home="docked"]')).toBeVisible();
  });

  test('an old ?panel=agent-hub link still lands on the profile', async ({
    page,
    rightPanel,
    roomsApi,
  }) => {
    // The Agent Hub's own links are out there in bookmarks and in other
    // people's notes. They must open the surface that replaced it, and leave
    // the reader on a URL this build speaks — not on the dead one.
    const agent = await roomsApi.registerAgent(`E2E Legacy ${roomsApi.runId}`, '🛠️', '#22c55e');
    await page.goto(
      `/session?panel=agent-hub&hubTab=sessions&dir=${encodeURIComponent(agent.projectPath)}`
    );
    await page.waitForSelector('[data-testid="app-shell"]');

    await expect(rightPanel.header).toBeVisible();
    await expect(rightPanel.profileTab).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/[?&]panel=profile/);
    await expect(page).not.toHaveURL(/hubTab=/);
  });
});
