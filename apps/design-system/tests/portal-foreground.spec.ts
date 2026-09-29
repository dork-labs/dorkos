import { test, expect, type Locator } from '@playwright/test';

async function expectThemeColors(surface: Locator, theme: 'light' | 'dark') {
  await expect(surface).toBeVisible();
  await expect(surface).toHaveCSS(
    'color',
    theme === 'dark' ? 'rgb(222, 222, 222)' : 'rgb(23, 23, 23)'
  );
  await expect(surface).toHaveCSS(
    'background-color',
    theme === 'dark' ? 'rgb(10, 10, 10)' : 'rgb(250, 250, 250)'
  );
}

for (const theme of ['light', 'dark'] as const) {
  for (const width of [390, 1280]) {
    test(`${theme} surfaces own their foreground inside an opposing document at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto('/');
      await page
        .getByRole('button', { name: theme === 'dark' ? 'Light theme' : 'Dark theme', exact: true })
        .click();
      // Class-only hosts supply theme tokens. A parent text utility would mask this regression.
      const island = page.locator(`[data-theme-island="${theme}"]`);
      await island.evaluate((el) => el.classList.remove('text-dui-foreground'));
      const host = page.locator(`[data-portal-host="${theme}"]`);
      const popoverTrigger = page.getByRole('button', {
        name: `Open ${theme} popover`,
        exact: true,
      });
      // Hover changes the outline variant's surface; check its resting palette first.
      await expect(popoverTrigger).toHaveCSS(
        'color',
        theme === 'dark' ? 'rgb(222, 222, 222)' : 'rgb(23, 23, 23)'
      );
      await popoverTrigger.click();
      const dialogTrigger = page.getByRole('button', {
        name: `Open ${theme} nested dialog`,
        exact: true,
      });
      await dialogTrigger.click();
      await expectThemeColors(
        host.getByRole('dialog', { name: `${theme} dialog`, exact: true }),
        theme
      );
      await page.keyboard.press('Escape');
      await expect(dialogTrigger).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(popoverTrigger).toBeFocused();
      const confirmationTrigger = page.getByRole('button', {
        name: `Open ${theme} alert dialog`,
        exact: true,
      });
      await confirmationTrigger.click();
      const confirmation = host.getByRole('alertdialog', { name: `${theme} confirmation` });
      await expectThemeColors(confirmation, theme);
      const cancel = confirmation.getByRole('button', { name: `Cancel ${theme} confirmation` });
      await expect(cancel).toBeFocused();
      await cancel.click();
      await expect(confirmationTrigger).toBeFocused();
      const sheetTrigger = page.getByRole('button', { name: `Open ${theme} sheet`, exact: true });
      await sheetTrigger.click();
      await expectThemeColors(
        host.getByRole('dialog', { name: `${theme} sheet`, exact: true }),
        theme
      );
      await page.keyboard.press('Escape');
      await expect(sheetTrigger).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      );
    });
  }
}
