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

    // `toHaveCount` retries; `count()` does not, and sampling this mid-animation
    // is what once made this read 16 for a tab that has 8.
    //
    // Ten since DOR-1046: eight display and notification preferences this
    // browser remembers, plus the two welcome-back switches, which the SERVER
    // keeps — and the second (Next-step offers) renders only while the first
    // is on, which it is by default.
    await expect(settingsPage.switches).toHaveCount(10);

    // Named, not just counted — a count alone passes on a tab that swapped every
    // preference for a different one. The name is the switch's `aria-label`; the
    // control itself carries no text.
    const panel = settingsPage.activePanel;
    await expect(panel.getByRole('switch', { name: 'Show timestamps' })).toBeVisible();
    await expect(panel.getByRole('switch', { name: 'Task celebrations' })).toBeVisible();
    await expect(panel.getByRole('switch', { name: 'Notification sound' })).toBeVisible();
    await expect(panel.getByRole('switch', { name: 'Welcome-back notes' })).toBeVisible();
    await expect(panel.getByRole('switch', { name: 'Next-step offers' })).toBeVisible();
  });

  /**
   * The one switch on this tab that is not a browser preference.
   *
   * Everything else here is stored locally, so a reload proving it survived
   * would prove only that `localStorage` works. This one is written to the
   * server's config and read back from it, which is what "follows you to every
   * device" means — so the reload is the whole assertion, and it has to be a
   * full reload rather than a dialog close.
   *
   * Self-restoring on purpose: it flips away from whatever the value is and
   * flips it back, so the run leaves the config exactly as it found it and the
   * test never assumes which way it started.
   *
   * Reopening after the reload is deliberately NOT `settingsPage.open()`: this
   * dialog is deep-linked (`?settings=preferences`), so a reload brings it back
   * by itself and the command-palette button it would press is behind the open
   * dialog. Waiting for the tab it came back on is the honest read.
   */
  test('Preferences: the welcome-back switch round-trips through the server', async ({
    page,
    basePage,
    settingsPage,
  }) => {
    const named = 'Welcome-back notes';

    /** The switch, after a reload has brought the deep-linked dialog back. */
    const afterReload = async () => {
      await page.reload();
      await basePage.waitForAppReady();
      await expect(settingsPage.dialog).toBeVisible();
      // The deep link brings the DIALOG back, not the tab it was on, so the tab
      // is pressed again rather than assumed.
      await settingsPage.switchTab('Preferences');
      return settingsPage.activePanel.getByRole('switch', { name: named });
    };

    await settingsPage.open();
    await settingsPage.switchTab('Preferences');

    const toggle = settingsPage.activePanel.getByRole('switch', { name: named });
    await expect(toggle).toBeVisible();
    const started = (await toggle.getAttribute('aria-checked')) === 'true';

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', String(!started));

    // Read it back off a fresh page: the write went to the server or it went
    // nowhere. Every other switch on this tab would survive this on
    // `localStorage` alone, which is exactly why this one is worth driving.
    const reopened = await afterReload();
    await expect(reopened).toHaveAttribute('aria-checked', String(!started));

    // Put it back, and prove THAT stuck too rather than trusting the undo.
    await reopened.click();
    await expect(reopened).toHaveAttribute('aria-checked', String(started));
    await expect(await afterReload()).toHaveAttribute('aria-checked', String(started));
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

    // The address carries the port, which stopped being a row of its own in
    // DOR-539. Asserting its shape keeps this a test of what is displayed rather
    // than of which port the run happened to pick.
    await expect(settingsPage.addressInfo).toHaveText(/^http:\/\/localhost:\d+$/);
    await expect(settingsPage.nodeInfo).toBeVisible();

    const panel = settingsPage.activePanel;
    await expect(panel.getByRole('button', { name: /^uptime/i })).toBeVisible();
    await expect(panel.getByRole('button', { name: /^working directory/i })).toBeVisible();
  });
});
