import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { runAxe } from '../../axe';

/**
 * The accessibility gate over every Dev Playground showcase the Claude account
 * UI added (spec `claude-account-ui` §12, Accessibility row): the account chip
 * and an open popover, the cached usage and context items, the continue
 * picker, the Settings account sections, the header badge, the sidebar's
 * account marks, the account palette, and every out-of-usage banner state
 * and transcript marker, in light and dark. Nothing is
 * skipped: a finding here is a defect to fix, never an entry in an allowlist.
 *
 * No server, no seeding: the playground renders every state from fixtures,
 * which is what lets this be a `@smoke` spec (the pattern of
 * `dashboard-sidebar/sidebar-model-showcase.spec.ts`).
 */

/** The first navigation to `/dev` compiles the playground; see the sidebar showcase spec. */
const PLAYGROUND_COLD_START_MS = 90_000;

/** Each playground page and the showcase sections on it, by section id. */
const PAGES: { path: string; sections: string[] }[] = [
  {
    path: '/dev/conversation',
    sections: [
      'accountitem',
      'accountpopover',
      'usagestatusitem',
      'contextitem',
      'continueonaccountdialog',
      'accountlimitbanner',
      'accountlimitmarker',
    ],
  },
  { path: '/dev/settings', sections: ['claude-code-accounts', 'runtime-usage'] },
  { path: '/dev/one-bar', sections: ['accountbadge'] },
  { path: '/dev/sidebar-model', sections: ['accountmark'] },
  { path: '/dev/tokens', sections: ['account-palette'] },
];

/** Every out-of-usage banner state the showcase draws (spec §6.7), and its markers. */
const BANNER_COUNT = 13;
const MARKER_COUNT = 5;

/**
 * Switch the playground's theme and wait until the document wears it.
 *
 * @param page - The page under test.
 * @param theme - Which theme to put the document in.
 */
async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`^${theme} theme$`, 'i') }).click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
    .toBe(theme === 'dark');
}

/**
 * Bring a region into view and prove it fits the viewport, then run axe over
 * it. axe's contrast check silently skips text outside the viewport, so a
 * region taller than the viewport would pass without being looked at.
 *
 * @param page - The page under test.
 * @param selector - The region to scan.
 * @param what - What the region is, for the failure message.
 */
async function scan(page: Page, selector: string, what: string): Promise<string[]> {
  const region = page.locator(selector).first();
  await expect(region, `${what} is on the page`).toBeVisible();
  await region.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  const fits = await region.evaluate(
    (el) => el.getBoundingClientRect().height <= window.innerHeight
  );
  expect(fits, `${what} must fit the viewport for axe to see all of it; raise the height`).toBe(
    true
  );
  const results = await runAxe(page, selector);
  const found: string[] = [];
  for (const violation of results.violations) {
    for (const node of violation.nodes) {
      const target = node.target.join(' ');
      found.push(
        `${what}: ${violation.id} (${violation.impact}): ${target}: ${node.failureSummary?.replace(/\s+/g, ' ')}`
      );
    }
  }
  return found;
}

test.describe('Claude account UI showcases @smoke', () => {
  // Tall enough for the tallest section (Settings' accounts, ~5000px): axe
  // does not look at text outside the viewport, and `scan` fails rather than
  // pass a region it could not see.
  test.use({ viewport: { width: 1440, height: 5600 } });
  test.describe.configure({ timeout: 240_000 });

  for (const theme of ['light', 'dark'] as const) {
    test(`every account showcase has no axe violations in the ${theme} theme`, async ({ page }) => {
      const violations: string[] = [];
      for (const { path, sections } of PAGES) {
        await page.goto(path);
        await expect(page.locator(`#${sections[0]}`)).toBeVisible({
          timeout: PLAYGROUND_COLD_START_MS,
        });
        await setTheme(page, theme);

        if (path === '/dev/conversation') {
          // Every banner state and marker drew, so none of them is skipped.
          await expect(
            page.locator('#accountlimitbanner [data-slot="account-limit-banner"]')
          ).toHaveCount(BANNER_COUNT);
          await expect(
            page.locator('#accountlimitmarker [data-slot="account-limit-marker"]')
          ).toHaveCount(MARKER_COUNT);
        }

        for (const section of sections) {
          violations.push(...(await scan(page, `#${section}`, `${path}#${section}`)));
        }

        if (path === '/dev/conversation') {
          // An open popover: the out chip with its continue action.
          await page
            .locator('#accountpopover')
            .getByRole('button', { name: /Acct 3/ })
            .last()
            .click();
          violations.push(...(await scan(page, '[role="dialog"]', 'the open AccountPopover')));
          await page.keyboard.press('Escape');
          await expect(page.getByRole('dialog')).toHaveCount(0);

          // Every kind of usage tooltip, whole: the inverted surface, so its
          // labels, notes and "as of" line all need 4.5:1 there (04 §13).
          const section = page.locator('#usagestatusitem');
          const tooltips: [string, ReturnType<typeof section.locator>][] = [
            ['near the limit', section.getByLabel('Subscription usage').nth(1)],
            ['out', section.getByLabel('Subscription usage').nth(2)],
            ['stale', section.locator('[data-stale="true"]').first()],
            ['pay-as-you-go', section.getByLabel('Session cost').last()],
          ];
          for (const [what, trigger] of tooltips) {
            await trigger.hover();
            const tip = page.locator('[data-slot="tooltip-content"]');
            await expect(tip).toBeVisible();
            violations.push(
              ...(await scan(page, '[data-slot="tooltip-content"]', `the ${what} usage tooltip`))
            );
            await page.keyboard.press('Escape');
            await page.mouse.move(0, 0);
            await expect(tip).toHaveCount(0);
          }

          // The other status-bar tooltips on the same inverted surface: the
          // context item's (with its "as of" line) and the subagents item's.
          const others: [string, ReturnType<typeof page.locator>][] = [
            ['context', page.locator('#contextitem').getByLabel('Context window usage').first()],
            [
              'subagents',
              page.locator('[data-testid="status-item-subagents"] [aria-label]').first(),
            ],
          ];
          for (const [what, trigger] of others) {
            await trigger.scrollIntoViewIfNeeded();
            await trigger.hover();
            const tip = page.locator('[data-slot="tooltip-content"]');
            await expect(tip).toBeVisible();
            violations.push(
              ...(await scan(page, '[data-slot="tooltip-content"]', `the ${what} tooltip`))
            );
            await page.keyboard.press('Escape');
            await page.mouse.move(0, 0);
            await expect(tip).toHaveCount(0);
          }

          // The open usage reveal while out: its amber overage note and its red
          // "Rate limit reached" are text on the popover, so they need 4.5:1.
          await page
            .locator('#usagestatusitem')
            .getByRole('button', { name: 'Open the out-of-usage reveal' })
            .click();
          await expect(page.getByRole('dialog').getByText('Rate limit reached')).toBeVisible();
          violations.push(...(await scan(page, '[role="dialog"]', 'the open UsageRevealPopover')));
          await page.keyboard.press('Escape');
          await expect(page.getByRole('dialog')).toHaveCount(0);

          // The open picker.
          await page
            .locator('#continueonaccountdialog')
            .getByRole('button', { name: 'Open the picker' })
            .first()
            .click();
          await expect(
            page.getByRole('dialog', { name: 'Continue on another account' })
          ).toBeVisible();
          await expect(page.getByRole('radio').first()).toBeVisible();
          violations.push(
            ...(await scan(page, '[role="dialog"]', 'the open ContinueOnAccountDialog'))
          );
          await page.keyboard.press('Escape');
        }
      }

      // A session row's context gauge, on the same inverted tooltip. Only the
      // tooltip is scanned here, not the row.
      await page.goto('/dev/sidebar-model');
      const rows = page.locator('#accountmark');
      await expect(rows).toBeVisible({ timeout: PLAYGROUND_COLD_START_MS });
      await setTheme(page, theme);
      const gauge = rows.locator('[aria-label^="Context "][aria-label$="% full"]').first();
      await gauge.scrollIntoViewIfNeeded();
      await gauge.hover();
      const gaugeTip = page.locator('[data-slot="tooltip-content"]');
      await expect(gaugeTip.getByText(/^as of /)).toBeVisible();
      violations.push(
        ...(await scan(page, '[data-slot="tooltip-content"]', 'the session row context tooltip'))
      );

      expect(violations, `axe found a11y defects in the ${theme} theme`).toEqual([]);
    });
  }
});
