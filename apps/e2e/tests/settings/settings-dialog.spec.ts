import { test, expect } from '../../fixtures';

test.describe('Settings — Dialog @smoke', () => {
  test('opens and closes the settings dialog', async ({ basePage, settingsPage }) => {
    await basePage.goto();
    await basePage.waitForAppReady();
    await basePage.ensureSidebarOpen();

    await settingsPage.open();
    await expect(settingsPage.dialog).toBeVisible();

    await settingsPage.close();
    await expect(settingsPage.dialog).toBeHidden();
  });

  test('switches between settings tabs', async ({ basePage, settingsPage }) => {
    await basePage.goto();
    await basePage.waitForAppReady();
    await basePage.ensureSidebarOpen();

    await settingsPage.open();
    await settingsPage.switchTab('Server');

    await expect(settingsPage.dialog.getByRole('tabpanel')).toBeVisible();
  });
});
