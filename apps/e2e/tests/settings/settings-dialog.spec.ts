import { test, expect } from '../../fixtures';

test.describe('Settings — Dialog @smoke', () => {
  test.beforeEach(async ({ basePage }) => {
    await basePage.goto();
    await basePage.waitForAppReady();
  });

  test('opens, and closes by Escape and by the close button', async ({ settingsPage }) => {
    await settingsPage.open();
    await expect(settingsPage.heading).toBeVisible();
    await settingsPage.close();
    await expect(settingsPage.dialog).toBeHidden();

    await settingsPage.open();
    await expect(settingsPage.dialog).toBeVisible();
    await settingsPage.closeViaButton();
    await expect(settingsPage.dialog).toBeHidden();
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
});
