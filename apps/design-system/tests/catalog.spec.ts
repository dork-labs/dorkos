import { expect, test } from '@playwright/test';

test.describe('shared UI catalog @smoke', () => {
  test('mounts real controls, keeps form semantics and has no page errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Shared foundations' })).toBeVisible();
    const cancel = page.getByRole('button', { name: 'Cancel example' });
    await expect(cancel).toHaveAttribute('data-slot', 'button');
    await cancel.click();
    await expect(page.getByText('Example submitted')).toHaveCount(0);
    await page.getByRole('button', { name: 'Submit example' }).click();
    await expect(page.getByText('Example submitted')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Slotted link example' })).toHaveAttribute(
      'data-slot',
      'button'
    );
    await expect(page.getByRole('button', { name: 'Disabled example' })).toBeDisabled();
    await page.getByText('Email address', { exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Email address' })).toBeFocused();
    await expect(page.getByRole('region', { name: 'Notices' }).getByRole('alert')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('applies system and explicit themes to rendered colors', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    const root = page.locator('[data-catalog-theme]');
    const color = () => root.evaluate((element) => getComputedStyle(element).backgroundColor);
    const systemDark = await color();

    await page.getByRole('button', { name: 'Light theme' }).click();
    const explicitLight = await color();
    expect(explicitLight).not.toBe(systemDark);
    await page.getByRole('button', { name: 'Dark theme' }).click();
    expect(await color()).toBe(systemDark);
    await page.getByRole('button', { name: 'System theme' }).click();
    await expect(root).toHaveAttribute('data-catalog-theme', 'system');
    expect(await color()).toBe(systemDark);
  });

  test('holds long labels and responsive controls at 390px and enlarged text', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.addStyleTag({ content: ':root { font-size: 200%; }' });
    await expect(page.getByText(/A longer field label that needs/)).toBeVisible();
    const measurements = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      overflowing: Array.from(document.querySelectorAll('body *'))
        .filter(
          (element) =>
            element.getBoundingClientRect().right > document.documentElement.clientWidth + 1
        )
        .slice(0, 12)
        .map(
          (element) =>
            `${element.tagName.toLowerCase()}:${element.textContent?.trim().slice(0, 32)}`
        ),
      inputHeight: document
        .querySelector<HTMLInputElement>('#catalog-long')
        ?.getBoundingClientRect().height,
    }));
    expect(measurements.document, measurements.overflowing.join(', ')).toBeLessThanOrEqual(
      measurements.viewport
    );
    expect(measurements.inputHeight).toBeGreaterThanOrEqual(44);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addStyleTag({ content: ':root { font-size: 100%; }' });
    await expect(page.locator('#catalog-long')).toHaveCSS('height', '36px');
  });

  test('respects reduced motion on a pressed Button', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const button = page.getByRole('button', { name: 'Default', exact: true });
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    expect(await button.evaluate((element) => getComputedStyle(element).scale)).toBe('none');
    await page.mouse.up();
  });
});
