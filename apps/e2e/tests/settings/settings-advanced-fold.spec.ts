import { test, expect } from '../../fixtures';
import { describeViolation, runAxe } from '../../axe';

/**
 * The Advanced fold at the foot of Settings (DOR-2629), in a real browser.
 *
 * What unit tests cannot see: that the disclosure sits outside every
 * `role="tablist"` in the rendered DOM (a tablist may own only tabs), that the
 * phone's drill-in list keeps its rows list-shaped, and that opening the fold
 * at the bottom of a long phone list brings the first revealed row on screen.
 * axe answers the first two; a bounding box answers the third.
 */

/** The sidebar alone: the panels render whatever their tab holds, which is not this spec's claim. */
const SIDEBAR = '[data-testid="settings-dialog"] [data-slot="navigation-layout-sidebar"]';

/**
 * The structural rules a sidebar like this can break, over the sidebar only.
 */
const STRUCTURE_RULES = [
  'aria-required-children',
  'aria-required-parent',
  'aria-valid-attr-value',
  'aria-prohibited-attr',
  'aria-allowed-role',
  'list',
  'listitem',
  'nested-interactive',
  'button-name',
  'duplicate-id-aria',
];

/** Fail on violations AND undecided results: "axe could not tell" is not a pass. */
async function expectNoStructureViolations(page: import('@playwright/test').Page, state: string) {
  const results = await runAxe(page, SIDEBAR, STRUCTURE_RULES);
  expect(
    [...results.violations, ...results.incomplete].map(describeViolation),
    `Settings sidebar, ${state}`
  ).toEqual([]);
}

test.describe('Settings — Advanced fold, desktop @smoke', () => {
  test.beforeEach(async ({ basePage }) => {
    await basePage.goto();
    await basePage.waitForAppReady();
  });

  test('keeps the disclosure outside every tablist, folded and open', async ({
    page,
    settingsPage,
  }) => {
    await settingsPage.open();
    const toggle = settingsPage.advancedToggle;
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle.locator('xpath=ancestor::*[@role="tablist"]')).toHaveCount(0);
    await expectNoStructureViolations(page, 'folded');

    await settingsPage.expandAdvanced();
    const advanced = settingsPage.dialog.getByRole('tablist', { name: 'Advanced' });
    await expect(advanced.getByRole('tab')).toHaveText([
      'Server',
      'Tools',
      'Room limits',
      'Experiments',
      'Danger zone',
    ]);
    await expect(toggle).toHaveAttribute('aria-controls', (await advanced.getAttribute('id'))!);
    await expectNoStructureViolations(page, 'open');
  });

  test('keeps the selected tab when folded while it is showing', async ({ page, settingsPage }) => {
    await page.goto('/?settings=danger');
    await expect(settingsPage.dialog).toBeVisible();
    await expect(settingsPage.advancedToggle).toHaveAttribute('aria-expanded', 'true');

    await settingsPage.advancedToggle.click();
    await expect(settingsPage.advancedToggle).toHaveAttribute('aria-expanded', 'false');
    // Still selected and still there, so the panel's label points at a tab.
    await expect(settingsPage.tab('Danger zone')).toHaveAttribute('aria-selected', 'true');
    await expect(settingsPage.dialog.getByRole('tabpanel', { name: 'Danger zone' })).toBeVisible();
    await expectNoStructureViolations(page, 'folded with an Advanced tab selected');
  });

  test('walks the arrow keys from the everyday tabs into Advanced, never from the toggle', async ({
    page,
    settingsPage,
  }) => {
    await settingsPage.open();
    await settingsPage.expandAdvanced();
    // The last tab of the everyday list — an extension's Add-ons tab, when one
    // is installed, sits after Privacy & Data.
    const lastEveryday = settingsPage.tabList.getByRole('tab').last();
    await lastEveryday.click();
    await lastEveryday.focus();
    await page.keyboard.press('ArrowDown');
    await expect(settingsPage.tab('Server')).toHaveAttribute('aria-selected', 'true');

    await settingsPage.advancedToggle.focus();
    await page.keyboard.press('ArrowDown');
    await expect(settingsPage.tab('Server')).toHaveAttribute('aria-selected', 'true');
  });
});

test.describe('Settings — Advanced fold, phone @smoke', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test.beforeEach(async ({ basePage }) => {
    await basePage.goto('/?settings=open');
    await basePage.waitForAppReady();
  });

  test('is a list row, and opening it brings the first revealed row on screen', async ({
    page,
  }) => {
    const dialog = page.getByTestId('settings-dialog');
    const toggle = dialog.getByRole('button', { name: 'Advanced', exact: true });
    await expect(toggle).toBeVisible();
    await expect(toggle.locator('xpath=parent::*')).toHaveAttribute('role', 'listitem');
    await expectNoStructureViolations(page, 'phone, folded');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(dialog.getByRole('button', { name: 'Server' })).toBeInViewport();
    await expectNoStructureViolations(page, 'phone, open');

    // Drill in and back: the fold is still open where the person left it.
    await dialog.getByRole('button', { name: 'Danger zone' }).click();
    await expect(dialog.getByRole('button', { name: 'Reset settings' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Danger zone' }).click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });
});
