import { test, expect } from '../../fixtures';

/** The stable development surface for the failed project-import state. */
const SHOWCASE_PATH = '/dev/features#candidatecard-import-failed';

test.describe('Dev Playground — failed project imports stay actionable @smoke', () => {
  test('shows the project and its retry without horizontal overflow', async ({
    page,
  }, testInfo) => {
    await page.goto(SHOWCASE_PATH);

    const section = page.locator('#candidatecard-import-failed');
    await expect(section).toBeVisible({ timeout: 15_000 });
    await expect(section.getByText('Scout', { exact: true })).toBeVisible();
    await expect(section.getByRole('alert')).toHaveText('Couldn’t add this project. Try again.');
    await expect(section.getByRole('button', { name: 'Try again' })).toBeVisible();
    await testInfo.attach('failed-import-light-desktop', {
      body: await section.screenshot(),
      contentType: 'image/png',
    });

    await section.getByRole('button', { name: 'Mobile (375px)' }).click();
    const preview = section.locator('div[style*="max-width: 375px"]');
    await expect(preview).toBeVisible();
    const overflow = await preview.evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    await page.getByRole('button', { name: /^dark theme$/i }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
      .toBe(true);
    await testInfo.attach('failed-import-dark-mobile', {
      body: await section.screenshot(),
      contentType: 'image/png',
    });
  });
});
