import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../../fixtures';

/**
 * `ListRow` on a 390px phone: the title gets the row's width.
 *
 * Under a 24rem row the meta and the trailing state leave the title line for
 * the subtitle, joined with " · ", and state copy wraps instead of truncating
 * (Card/Row A design review). A container query can't be measured in jsdom, so
 * this reads the rendered page. The Dev Playground draws it with no server
 * behind it, which is what makes this a `@smoke` test.
 */
const SHOWCASE_PATH = '/dev/components#list-rows';

/** A ceiling for the first, cold navigation to `/dev` (see sidebar-model-showcase.spec.ts). */
const PLAYGROUND_COLD_START_MS = 90_000;

/** Whether an element's text is cut off by its own box. */
async function isTruncated(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
}

async function openSection(page: Page): Promise<Locator> {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(SHOWCASE_PATH);
  const section = page.locator('section#list-rows');
  await expect(section).toBeVisible({ timeout: PLAYGROUND_COLD_START_MS });
  return section;
}

test.describe('List rows at 390px @smoke', () => {
  test('a short title is not cut off by its meta or trailing state', async ({ page }) => {
    const section = await openSection(page);
    for (const name of ['Morning digest', 'Calendar sync']) {
      const title = section.locator('[data-slot="list-row-title"]', { hasText: name }).first();
      await expect(title).toBeVisible();
      expect(await isTruncated(title), `"${name}" is truncated at 390px`).toBe(false);
    }
  });

  test('the meta and the trailing state move to the subtitle line', async ({ page }) => {
    const section = await openSection(page);
    const row = section.locator('[data-slot="list-row"]', { hasText: 'Calendar sync' }).first();
    await expect(row.locator('[data-slot="list-row-trailing"]')).toBeHidden();
    await expect(row.locator('[data-slot="list-row-subtitle-trailing"]')).toHaveText('Reconnect');
    const digest = section.locator('[data-slot="list-row"]', { hasText: 'Morning digest' }).first();
    await expect(digest.locator('[data-slot="list-row-meta"]')).toBeHidden();
    await expect(digest.locator('[data-slot="list-row-subtitle-meta"]')).toBeVisible();
  });

  test('the meta and the second line are joined with a separator', async ({ page }) => {
    const section = await openSection(page);
    const subtitle = section
      .locator('[data-slot="list-row"]', { hasText: 'Nightly backup' })
      .first()
      .locator('[data-slot="list-row-subtitle"]');
    await expect(subtitle).toHaveText(/3h\s*·\s*Last ran/);
  });

  test('state copy wraps and is never truncated', async ({ page }) => {
    const section = await openSection(page);
    for (const name of ["Couldn't load schedules.", 'Nothing matches']) {
      const title = section.locator('[data-slot="list-row-title"]', { hasText: name }).first();
      await expect(title).toBeVisible();
      expect(await isTruncated(title), `"${name}" is truncated at 390px`).toBe(false);
    }
  });
});
