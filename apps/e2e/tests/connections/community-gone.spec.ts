import { test, expect } from '@playwright/test';
import { mockCommunities, ROOM } from './community-mocks.js';

/**
 * A Community that has only answered "not found" for two weeks (DOR-2334): the app says it
 * seems to be gone and offers to remove the local copy, which it never does on its own. Mocked at
 * the local server's API, like the other Community specs; this is about what a person sees at
 * desktop and phone widths.
 */
const GONE = {
  ref: 'gamma',
  label: 'Gamma',
  access: 'unverified' as const,
  seemsGoneSince: '2026-09-01T12:00:00.000Z',
};

for (const viewport of [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'phone', width: 390, height: 844 },
]) {
  test(`says a Community seems to be gone and offers to remove the copy (DOR-2334, ${viewport.name})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await mockCommunities(page, [GONE]);
    await page.goto(`/channels?community=${GONE.ref}&id=${ROOM}`);

    await expect(page.getByText('This community seems to be gone')).toBeVisible();
    await expect(
      page.getByText(/Since September 1, 2026, Gamma has said this community doesn’t exist/)
    ).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`seems-gone-${viewport.name}.png`) });

    await page.getByRole('button', { name: 'Remove local copy' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Remove your copy of Gamma?');
    await page.screenshot({
      path: test.info().outputPath(`seems-gone-confirm-${viewport.name}.png`),
    });
    await dialog.getByRole('button', { name: 'Keep it' }).click();
    await expect(dialog).toBeHidden();
  });
}
