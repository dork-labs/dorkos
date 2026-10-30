import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';

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

test.describe('sidebar collapse', () => {
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
    // Both presses run inside one page task, so a slow machine cannot let the fold
    // finish between them, and every frame after is sampled.
    const frames = await page.evaluate(async () => {
      const press = () =>
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true }));
      const el = document.querySelector('[data-slot="sidebar-container"]')!;
      const samples: number[] = [];
      press();
      await new Promise((done) => setTimeout(done, 60));
      press();
      for (let i = 0; i < 40; i++) {
        await new Promise(requestAnimationFrame);
        samples.push(el.getBoundingClientRect().x);
      }
      return samples;
    });

    // It never reached the far end, and it had started from partway rather than
    // from the start or the end.
    expect(Math.min(...frames)).toBeGreaterThan(-288);
    expect(frames[0]).toBeLessThan(0);
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
