import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { SOLE_SIDEBAR_TAG } from '../../fixtures/sole-access';

/**
 * The sidebar leaving and coming back with ⌘B.
 *
 * **Only a browser can answer this.** The defect was that after a collapse the next
 * nine Tabs landed at x -272 to -40, on controls nobody could see. jsdom has no
 * layout and no real tab order, so a unit test can check `inert` is set but not that
 * Tab really stays on screen, or that the panel slides from where it is.
 */

const panel = (page: Page) => page.locator('[data-slot="sidebar-container"]');
const trigger = (page: Page) => page.locator('[data-sidebar="trigger"]');
const sectionToggle = (page: Page) =>
  page.locator('nav[aria-label="Sidebar"] [data-sidebar-section-toggle]').first();

/** Where the focused element sits, measured from the left of the window. */
function focusedX(page: Page): Promise<number> {
  return page.evaluate(() => document.activeElement?.getBoundingClientRect().x ?? 0);
}

/** The panel's left edge right now, in pixels. */
function panelX(page: Page): Promise<number> {
  return page.evaluate(
    () => document.querySelector('[data-slot="sidebar-container"]')?.getBoundingClientRect().x ?? 0
  );
}

test.describe('sidebar collapse', { tag: SOLE_SIDEBAR_TAG }, () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(sectionToggle(page)).toBeVisible();
  });

  test('Tab never lands on a hidden control, and focus comes back', async ({ page }) => {
    await sectionToggle(page).focus();
    await page.keyboard.press('ControlOrMeta+b');

    await expect(trigger(page)).toBeFocused();
    await expect(panel(page)).toHaveAttribute('inert', '');
    await expect.poll(() => panelX(page)).toBeLessThan(-200);

    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      expect(await focusedX(page), `Tab ${i + 1} left the screen`).toBeGreaterThanOrEqual(0);
    }

    await trigger(page).focus();
    await page.keyboard.press('ControlOrMeta+b');

    await expect(panel(page)).not.toHaveAttribute('inert', '');
    await expect(sectionToggle(page)).toBeFocused();
  });

  test('focus outside the panel stays put through two presses', async ({ page }) => {
    const outside = page.locator('[data-slot="sidebar-inset"] textarea').first();
    await expect(outside).toBeVisible();
    await outside.focus();

    await page.keyboard.press('ControlOrMeta+b');
    await expect(outside).toBeFocused();

    await page.keyboard.press('ControlOrMeta+b');
    await expect(outside).toBeFocused();
  });

  test('a press mid-flight turns the panel around from where it is', async ({ page }) => {
    // The second press waits for a frame that shows the panel partway, not for a
    // fixed time: under CI load one long frame can carry the fold to the end, and
    // a timed press would then test nothing. A fold that is never caught partway
    // is reopened and tried again, up to three times.
    const run = await page.evaluate(async () => {
      const press = () =>
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true }));
      const el = document.querySelector('[data-slot="sidebar-container"]')!;
      const x = () => el.getBoundingClientRect().x;
      const frame = () => new Promise(requestAnimationFrame);
      const width = el.getBoundingClientRect().width;
      for (let attempt = 0; attempt < 3; attempt++) {
        press();
        let turnedAt: number | null = null;
        for (let i = 0; i < 60 && turnedAt === null; i++) {
          await frame();
          const now = x();
          // Caught too late, the spring's own speed could carry it to the end.
          if (now <= -width * 0.6) break;
          if (now < -8) {
            turnedAt = now;
            press();
          }
        }
        if (turnedAt === null) {
          for (let i = 0; i < 60 && x() > -width; i++) await frame();
          press();
          for (let i = 0; i < 60 && x() < 0; i++) await frame();
          continue;
        }
        const samples: number[] = [];
        for (let i = 0; i < 40; i++) {
          await frame();
          samples.push(x());
        }
        return { width, turnedAt, samples };
      }
      return null;
    });

    // The reversed spring keeps its speed, so it can travel past the turn point (even
    // past the panel's width under a slow frame) before coming back. What matters is
    // that it turns without resting closed.
    expect(run, 'the fold was never caught partway in three tries').not.toBeNull();
    const { width, turnedAt, samples } = run!;
    const lowest = Math.min(...samples);
    const last = samples[samples.length - 1];
    expect(samples.indexOf(lowest)).toBeLessThan(samples.length - 1);
    // Back at least halfway from its deepest point.
    expect(last).toBeGreaterThan(lowest / 2);
    expect(last).toBeGreaterThan(turnedAt);
    const restedClosed = samples.some(
      (_, i) =>
        i >= 2 &&
        samples.slice(i - 2, i + 1).every((s) => s <= -width + 1) &&
        Math.max(...samples.slice(i - 2, i + 1)) - Math.min(...samples.slice(i - 2, i + 1)) <= 1
    );
    expect(restedClosed, 'the panel sat closed before coming back').toBe(false);
    await expect.poll(() => panelX(page)).toBe(0);
  });

  test('at rest the panel leaves no transform behind', async ({ page }) => {
    // A transform or `will-change: transform` on the panel would make it the
    // containing block for anything `fixed` inside it, like the drag overlay.
    const style = await panel(page).evaluate((el) => {
      const computed = getComputedStyle(el);
      return { transform: computed.transform, willChange: computed.willChange };
    });

    expect(style.transform).toBe('none');
    expect(style.willChange).not.toContain('transform');
  });
});
