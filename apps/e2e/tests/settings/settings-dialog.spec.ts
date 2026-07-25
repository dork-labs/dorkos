import { test, expect } from '../../fixtures';

test.describe('Settings — Dialog @smoke', () => {
  test.beforeEach(async ({ basePage }) => {
    await basePage.goto();
    await basePage.waitForAppReady();
  });

  test('opens and closes the settings dialog via Escape', async ({ settingsPage }) => {
    await settingsPage.open();
    await expect(settingsPage.heading).toBeVisible();

    await settingsPage.close();
    await expect(settingsPage.dialog).toBeHidden();
  });

  test('opens and closes via close button', async ({ settingsPage }) => {
    await settingsPage.open();
    await expect(settingsPage.dialog).toBeVisible();

    await settingsPage.closeViaButton();
    await expect(settingsPage.dialog).toBeHidden();
  });

  test('has its core tabs', async ({ settingsPage }) => {
    await settingsPage.open();

    const tabs = ['Appearance', 'Preferences', 'Server'];
    for (const tabName of tabs) {
      await expect(settingsPage.tab(tabName)).toBeVisible();
    }
  });

  test('switches between all tabs', async ({ settingsPage }) => {
    await settingsPage.open();

    await settingsPage.switchTab('Preferences');
    await expect(settingsPage.tab('Preferences')).toHaveAttribute('aria-selected', 'true');
    await expect(settingsPage.activePanel).toBeVisible();

    await settingsPage.switchTab('Server');
    await expect(settingsPage.tab('Server')).toHaveAttribute('aria-selected', 'true');

    await settingsPage.switchTab('Appearance');
    await expect(settingsPage.tab('Appearance')).toHaveAttribute('aria-selected', 'true');
  });

  test('Appearance tab shows theme and font controls', async ({ settingsPage }) => {
    await settingsPage.open();

    // Appearance is default tab
    await expect(settingsPage.activePanel.getByText('Theme')).toBeVisible();
    await expect(settingsPage.activePanel.getByText('Font family')).toBeVisible();
    await expect(settingsPage.activePanel.getByText('Font size')).toBeVisible();
  });

  test('Preferences tab shows toggle switches', async ({ settingsPage }) => {
    await settingsPage.open();
    await settingsPage.switchTab('Preferences');

    // Should have 9 preference switches
    const switchCount = await settingsPage.switches.count();
    expect(switchCount).toBe(9);

    // Verify some specific preferences exist
    await expect(settingsPage.activePanel.getByText('Show timestamps')).toBeVisible();
    await expect(settingsPage.activePanel.getByText('Task celebrations')).toBeVisible();
    await expect(settingsPage.activePanel.getByText('Notification sound')).toBeVisible();
  });

  // What the status line shows is no longer a Settings concern: items promote when
  // they are actionable, and pins live in the Session panel beside each live value.
  test('has no Status Bar tab', async ({ settingsPage }) => {
    await settingsPage.open();
    await expect(settingsPage.tab('Status Bar')).toHaveCount(0);
  });

  test('Server tab shows server info', async ({ settingsPage }) => {
    await settingsPage.open();
    await settingsPage.switchTab('Server');

    await expect(settingsPage.portInfo).toBeVisible();
    await expect(settingsPage.nodeInfo).toBeVisible();
    await expect(settingsPage.activePanel.getByText('Uptime')).toBeVisible();
    await expect(settingsPage.activePanel.getByText('Working Directory')).toBeVisible();
  });
});
