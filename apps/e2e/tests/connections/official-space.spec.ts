import { test, expect, type Page } from '@playwright/test';
import { BasePage } from '../../pages/BasePage.js';
import { ALPHA, mockCommunities, type CommunitySpec } from './community-mocks.js';

/**
 * Browser proof that the official DorkOS space works with the spaces switch off (spec
 * `official-community-space` D5, DOR-2769): its row shows and opens, every other space stays
 * hidden, and while it is not connected the switcher offers to join it, with its link filled in.
 *
 * The test-mode server runs with spaces on, so the config answer is rewritten here to the
 * launch state: the experiment off and an official link named.
 */

const OFFICIAL_LINK = 'https://official.example.test/c/11111111-1111-4111-8111-111111111111';
const OFFICIAL: CommunitySpec = { ref: 'official', label: 'DorkOS', official: true };

/** Serve the real config with the spaces experiment off and an official space named. */
async function launchConfig(page: Page) {
  await page.route('**/api/config', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const real = await route.fetch();
    const body = (await real.json()) as {
      experiments?: { key: string; enabled: boolean }[];
      officialSpace?: { url: string } | null;
    };
    body.experiments = (body.experiments ?? []).map((flag) =>
      flag.key === 'spaces.enabled' ? { ...flag, enabled: false } : flag
    );
    body.officialSpace = { url: OFFICIAL_LINK };
    await route.fulfill({ response: real, json: body });
  });
}

test.describe('the official DorkOS space with spaces off', () => {
  test('shows and opens the official space alone', async ({ page }) => {
    await launchConfig(page);
    await mockCommunities(page, [OFFICIAL, ALPHA]);
    await page.goto('/tasks');
    await new BasePage(page).waitForAppReady();

    await page.getByTestId('sidebar-header-block').click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitemradio', { name: /^DorkOS/ })).toBeVisible();
    await expect(menu.getByRole('menuitemradio', { name: /^Alpha/ })).toHaveCount(0);
    await expect(menu.getByRole('menuitem', { name: 'Add a space' })).toHaveCount(0);
    await expect(menu.getByRole('menuitem', { name: /Join the DorkOS community/ })).toHaveCount(0);

    await menu.getByRole('menuitemradio', { name: /^DorkOS/ }).click();
    await expect(page).toHaveURL(/community=official/);
    await expect(page.getByTestId('sidebar-header-block')).toHaveAccessibleName('DorkOS menu');

    // Any other space's address still leads to the channel list.
    await page.goto('/channels?community=alpha&id=general');
    await expect(page).toHaveURL(/\/channels$/);
  });

  test('offers to join it, with its link filled in', async ({ page }) => {
    await launchConfig(page);
    await mockCommunities(page, [ALPHA]);
    await page.goto('/tasks');
    await new BasePage(page).waitForAppReady();

    await page.getByTestId('sidebar-header-block').click();
    await page.getByRole('menuitem', { name: /Join the DorkOS community/ }).click();
    await expect(page.getByLabel('Space address or invitation link')).toHaveValue(OFFICIAL_LINK);
  });
});
