import { test, expect } from '../../fixtures';
import type { Locator, Page } from '@playwright/test';

/**
 * The composer status line never scrolls and never wraps (spec
 * composer-status-redesign §6.1) — which only leaves one honest failure mode, and
 * for a while it was the dishonest one: the right cluster could not shrink inside
 * an `overflow-hidden` row, so any item wider than the slot budget predicted was
 * clipped away where nobody could reach it. At 375px the bar needed 387px of a
 * 341px row; at 330px it needed 387px of 296px (DOR-452).
 *
 * The invariant this file defends is the measurable one: the row's content never
 * extends past the row, at any width, and the `⋯` that holds everything the line
 * gave up is always there and always big enough to tap.
 */

// eslint-disable-next-line no-restricted-syntax -- E2E test config; no env.ts available
const API_URL = `http://localhost:${process.env.DORKOS_PORT || '4242'}`;

/** The widths in the bug report, plus a desktop width for the non-degraded case. */
const WIDTHS = [900, 520, 375, 330] as const;

/**
 * A row that reports more content than it can show is a row with clipped,
 * unreachable content. One pixel of slack absorbs sub-pixel layout rounding.
 */
async function expectNoClipping(statusLine: Locator) {
  const box = await statusLine.evaluate((el) => ({
    clientWidth: el.clientWidth,
    scrollWidth: el.scrollWidth,
  }));
  expect(
    box.scrollWidth,
    `status line content (${box.scrollWidth}px) must fit the row (${box.clientWidth}px)`
  ).toBeLessThanOrEqual(box.clientWidth + 1);
}

/** The `⋯` — the anchor for everything the width budget dropped. */
function revealTrigger(page: Page): Locator {
  return page.locator('[data-testid="status-line"] button[aria-label^="Session details"]');
}

test.describe('Chat — status line fits its row @integration', () => {
  test.beforeAll(async ({ request }) => {
    // A fresh DORK_HOME has no completed onboarding steps, so the wizard would sit
    // in front of the cockpit. Same dismissal chat-mock.spec.ts uses.
    await request.patch(`${API_URL}/api/config`, {
      data: { onboarding: { dismissedAt: new Date().toISOString() } },
    });
  });

  for (const width of WIDTHS) {
    test.describe(`at ${width}px`, () => {
      // Touch emulation is what puts the `⋯` on its 44px coarse-pointer target, so
      // the width and the hit area are asserted under the same conditions a phone
      // actually reports.
      test.use({ viewport: { width, height: 780 }, hasTouch: true });

      test('never clips its items, and keeps the reveal anchor tappable', async ({ chatPage }) => {
        const statusLine = chatPage.page.locator('[data-testid="status-line"]');
        await expect(statusLine).toBeVisible();

        // The model item always promotes, so it is the signal that the line has
        // real content rather than an empty row that trivially fits.
        await expect(chatPage.page.locator('[data-testid="status-item-model"]')).toBeVisible();
        await expectNoClipping(statusLine);

        // The runtime item resolves from a second query; re-measure once it lands,
        // because two items side by side is exactly what overflowed before.
        await expect(chatPage.page.locator('[data-testid="status-item-runtime"]')).toBeVisible();
        await expectNoClipping(statusLine);

        const reveal = revealTrigger(chatPage.page);
        await expect(reveal).toBeVisible();
        const hitArea = await reveal.boundingBox();
        expect(hitArea).not.toBeNull();
        expect(hitArea!.width).toBeGreaterThanOrEqual(44);
        expect(hitArea!.height).toBeGreaterThanOrEqual(44);
      });
    });
  }

  test.describe('under content it was never budgeted for', () => {
    test.use({ viewport: { width: 375, height: 780 }, hasTouch: true });

    test('truncates with an ellipsis instead of clipping', async ({ chatPage }) => {
      // The budget counts slots, and a count is a prediction. This drives the row
      // past any prediction — six more items carrying absurd values — to prove the
      // failure mode is a visible ellipsis and not silently unreachable content.
      const statusLine = chatPage.page.locator('[data-testid="status-line"]');
      await expect(chatPage.page.locator('[data-testid="status-item-model"]')).toBeVisible();

      const overflowingValues = await statusLine.evaluate((line) => {
        const rightCluster = line.children[1];
        const template = rightCluster.querySelector('[data-testid="status-item-model"]');
        if (!template) throw new Error('no right-cluster item to clone');
        for (let i = 0; i < 6; i++) {
          const clone = template.cloneNode(true) as HTMLElement;
          clone.setAttribute('data-testid', `status-item-stress-${i}`);
          const value = clone.querySelector('span.truncate');
          if (value) value.textContent = `Absurdly Verbose Status Value ${i}`;
          rightCluster.appendChild(clone);
        }
        return [...rightCluster.querySelectorAll('span.truncate')].filter(
          (el) => el.scrollWidth > el.clientWidth
        ).length;
      });

      await expectNoClipping(statusLine);
      expect(
        overflowingValues,
        'values too wide for the row must show an ellipsis'
      ).toBeGreaterThan(0);
      await expect(revealTrigger(chatPage.page)).toBeVisible();
    });
  });
});
