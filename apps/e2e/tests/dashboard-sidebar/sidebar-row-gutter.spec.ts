import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../../fixtures';

/**
 * The Dev Playground section this spec drives.
 *
 * `SidebarRow` is a `shared/ui` primitive with no data behind it, so the
 * playground draws it directly: four frames at fixed widths, one of which can be
 * put under the transform dnd-kit applies during a drag. That makes this a
 * `@smoke` spec — it seeds nothing and cleans nothing up.
 */
const SHOWCASE_PATH = '/dev/components#sidebarrow';

/**
 * How long the first navigation to `/dev` may take, cold.
 *
 * A ceiling, not a delay — against a warm dev server the frames resolve in
 * milliseconds. What it pays for is Vite faulting in the whole playground module
 * graph on the run's first navigation. Same reasoning, same number, as
 * `sidebar-model-showcase.spec.ts`.
 */
const PLAYGROUND_COLD_START_MS = 90_000;

/**
 * The right gutter `SidebarRow` reserves, in pixels (`pr-7`).
 *
 * **Asserted as COMPUTED padding, and that is the entire point of this spec.**
 * The row's class list carried both `pr-7` and `px-2` for months; `cn()` is
 * tailwind-merge, so the later `px-2` won and the emitted classes had no `pr-7`
 * in them at all. A `toHaveClass` assertion passes either way — both strings are
 * in the source — so only the measurement can tell the two apart. Measured
 * broken: 8px (DOR-1115).
 */
const GUTTER_PX = 28;

/** Every frame the showcase draws, in the order it draws them. */
const FRAMES = ['cockpit', 'narrow', 'keyboard', 'override', 'bare', 'dragged'] as const;

/** One of the showcase's fixed-width frames. */
function frame(page: Page, name: string): Locator {
  return page.locator(`[data-slot="sidebar-row-frame"][data-frame="${name}"]`);
}

/**
 * Open the showcase and wait until every frame it draws is on screen.
 *
 * @param page - The page under test.
 */
async function openShowcase(page: Page): Promise<void> {
  await page.goto(SHOWCASE_PATH);
  await expect(page.locator('[data-slot="sidebar-row-frame"]')).toHaveCount(FRAMES.length, {
    timeout: PLAYGROUND_COLD_START_MS,
  });
}

/**
 * The accessible name of whatever currently has focus, or the row's own
 * `data-slot` when the row itself does.
 *
 * @param page - The page under test.
 */
function focused(page: Page): Promise<string> {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (element === null) return '(nothing)';
    return element.getAttribute('aria-label') ?? element.getAttribute('data-slot') ?? '(unnamed)';
  });
}

/**
 * Switch the playground's theme and wait until the document actually wears it.
 *
 * The click and the class land on different commits, so asserting the class is
 * what makes a screenshot belong to the theme it claims.
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
 * A locator's box, refusing the `null` Playwright returns for anything not
 * rendered — an assertion that silently skipped on `null` would be no assertion.
 *
 * @param locator - What to measure.
 */
async function box(locator: Locator): Promise<{ x: number; y: number; width: number }> {
  const measured = await locator.boundingBox();
  expect(measured, 'expected the element to be laid out').not.toBeNull();
  return measured!;
}

test.describe('SidebarRow — the reserved right gutter @smoke', () => {
  test('really reserves the gutter it declares', async ({ page }) => {
    await openShowcase(page);

    for (const name of FRAMES) {
      const row = frame(page, name).locator('[data-slot="sidebar-row-demo"]');
      const padding = await row.evaluate((node) => getComputedStyle(node).paddingRight);
      expect(padding, `the ${name} row lost its right gutter`).toBe(`${GUTTER_PX}px`);
    }
  });

  test('keeps the gutter even when a caller passes padding of its own', async ({ page }) => {
    await openShowcase(page);

    // The `override` frame passes `className="px-6"`. Measured with tailwind-merge:
    // `twMerge('px-2 pr-7 px-6')` → `'px-6'` — a caller's shorthand landing after
    // the gutter swallows it whole and reopens DOR-1115 from the outside. The row
    // applies the gutter LAST, after `className`, which is what this pins.
    const row = frame(page, 'override').locator('[data-slot="sidebar-row-demo"]');
    const padding = await row.evaluate((node) => ({
      right: getComputedStyle(node).paddingRight,
      left: getComputedStyle(node).paddingLeft,
    }));
    expect(padding.right, 'a caller’s px-* took the gutter back').toBe(`${GUTTER_PX}px`);
    // …and the caller still got what it asked for everywhere the row does not
    // reserve, so this is a targeted refusal rather than className being ignored.
    expect(padding.left).toBe('24px');
  });

  test('keeps the ⋮ inside the gutter rather than over the row’s words', async ({ page }) => {
    await openShowcase(page);

    // Measured against each other, and from the row's REAL padding rather than
    // from the constant above: the gutter exists to hold the "⋮", so the
    // question is whether the row's content box ends before the kebab starts.
    // Reading `GUTTER_PX` here instead would have asked what the row was
    // supposed to do, which is the one thing that was never in doubt.
    const row = frame(page, 'bare').locator('[data-slot="sidebar-row-demo"]');
    await row.hover();
    const kebab = frame(page, 'bare').getByRole('button', { name: 'Demo row actions' });

    const rowBox = await box(row);
    const kebabBox = await box(kebab);
    const padding = await row.evaluate((node) => parseFloat(getComputedStyle(node).paddingRight));
    const contentRight = rowBox.x + rowBox.width - padding;
    expect(contentRight, 'the row’s words reach under its own ⋮').toBeLessThanOrEqual(kebabBox.x);
  });

  test('truncates a long title with an ellipsis instead of running it under the chip', async ({
    page,
  }) => {
    await openShowcase(page);

    for (const [name, width] of [
      ['cockpit', 256],
      ['narrow', 200],
    ] as const) {
      const holder = frame(page, name);
      await expect(holder).toHaveCSS('width', `${width}px`);

      const title = holder.locator('[data-slot="sidebar-row-demo"] .truncate').last();
      // Overflowing is what makes this a truncation test rather than a test of a
      // title that happened to fit.
      const overflow = await title.evaluate((node) => ({
        clipped: node.scrollWidth > node.clientWidth,
        ellipsis: getComputedStyle(node).textOverflow,
      }));
      expect(overflow.clipped, `the ${name} title is not long enough to prove anything`).toBe(true);
      expect(overflow.ellipsis).toBe('ellipsis');

      // And it stops short of the control, rather than being painted over by it.
      const chip = holder.getByRole('button', { name: '3 live sessions' });
      const titleBox = await box(title);
      const chipBox = await box(chip);
      expect(
        titleBox.x + titleBox.width,
        `the ${name} title runs under the trailing control`
      ).toBeLessThanOrEqual(chipBox.x + 1);
    }
  });

  test('parks the trailing control exactly on the width the row really reserved', async ({
    page,
  }) => {
    await openShowcase(page);

    // `right-7` and `pr-7` are one number spelled twice, and nothing in the type
    // system holds them together. This does: the control's right edge and the
    // row's content-box right edge are the same line.
    //
    // Measured from the row's REAL padding, not from `GUTTER_PX`. Against the
    // constant this compared the control to what the row was *supposed* to
    // reserve, so it stayed green through the original class-order bug — it
    // pinned `right-7` and nothing else. Reading the padding makes it the
    // coupling test its name claims: with the row at 8px the control sits 20px
    // adrift, which is exactly how it came to be painted over the title.
    for (const name of ['cockpit', 'narrow'] as const) {
      const holder = frame(page, name);
      const row = holder.locator('[data-slot="sidebar-row-demo"]');
      const rowBox = await box(row);
      const padding = await row.evaluate((node) => parseFloat(getComputedStyle(node).paddingRight));
      const chipBox = await box(holder.getByRole('button', { name: '3 live sessions' }));
      expect(
        chipBox.x + chipBox.width,
        `the ${name} control is not on the line the row reserved`
      ).toBeCloseTo(rowBox.x + rowBox.width - padding, 0);
    }
  });

  test('walks the row’s lane with the arrow keys, ending on the ⋮', async ({ page }) => {
    await openShowcase(page);

    // The path the consuming branch depends on, in a real browser. The jsdom
    // test proves the hook's arithmetic; this proves the marks, the DOM shape
    // and the roving container agree in the app the operator actually uses —
    // `SidebarRow` stamps the attribute, `SidebarMenuSurface` makes the control
    // a sibling, and the section hands it the keyboard.
    const holder = frame(page, 'keyboard');
    await holder.locator('[data-slot="sidebar-row-demo"]').focus();
    expect(await focused(page)).toBe('sidebar-row-demo');

    // Out along the right gutter: the control first, the "⋮" after it. Before
    // the lane existed, ArrowRight meant "the ⋮" and skipped the control
    // entirely — it was reachable by pointer only.
    await page.keyboard.press('ArrowRight');
    expect(await focused(page), 'ArrowRight skipped the trailing control').toBe('3 live sessions');
    await page.keyboard.press('ArrowRight');
    expect(await focused(page)).toBe('Demo row actions');

    // …and back in the same order, on through the row to the glyph control.
    await page.keyboard.press('ArrowLeft');
    expect(await focused(page)).toBe('3 live sessions');
    await page.keyboard.press('ArrowLeft');
    expect(await focused(page)).toBe('sidebar-row-demo');
    await page.keyboard.press('ArrowLeft');
    expect(await focused(page)).toBe('Open the demo profile');
  });

  test('leaves the section one Tab stop however far out the lane focus has walked', async ({
    page,
  }) => {
    await openShowcase(page);

    const holder = frame(page, 'keyboard');
    await holder.locator('[data-slot="sidebar-row-demo"]').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');

    // Focus is on the "⋮", two steps out. The Tab stop is still the row, so
    // leaving and coming back returns the reader to the list rather than to a
    // menu trigger they were only visiting.
    const stops = await holder.evaluate((node) =>
      [...node.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[tabindex]')]
        .filter((element) => element.tabIndex === 0)
        .map((element) => element.getAttribute('data-slot') ?? element.getAttribute('aria-label'))
    );
    expect(stops).toEqual(['sidebar-row-demo']);
  });

  test('carries the trailing control with the row under a drag transform', async ({ page }) => {
    await openShowcase(page);

    /**
     * Where the row and its control sit INSIDE their frame.
     *
     * Frame-relative and read in one evaluate, deliberately: viewport
     * coordinates move when Playwright scrolls the toggle into view, and a
     * first version of this measured a 28px difference that was the page
     * scrolling between two `boundingBox()` calls rather than anything about
     * the row. The frame is never transformed, so offsets inside it are the
     * only thing a drag can change.
     */
    const offsets = () =>
      frame(page, 'dragged').evaluate((holder) => {
        const origin = holder.getBoundingClientRect().top;
        const row = holder.querySelector('[data-slot="sidebar-row-demo"]');
        const chip = holder.querySelector('[data-sidebar-trailing-action]');
        if (row === null || chip === null) throw new Error('the dragged frame lost a part');
        return {
          row: row.getBoundingClientRect().top - origin,
          chip: chip.getBoundingClientRect().top - origin,
        };
      });

    const before = await offsets();

    await page.getByRole('button', { name: 'Simulate drag' }).click();
    await expect(page.getByRole('button', { name: 'Drop the row' })).toBeVisible();
    // The transform is a style change rather than a layout event, so wait for
    // the row to have really moved before reading the control.
    await expect.poll(async () => (await offsets()).row).not.toBe(before.row);

    const after = await offsets();

    // The showcase applies `translate3d(0, 40px, 0)` — the shape dnd-kit applies
    // during a real drag. The row takes all 40 of it…
    expect(after.row - before.row).toBeCloseTo(40, 0);
    // …and so does the control. The defect: mounted on the `expansion` slot it
    // was a SIBLING of the dragged element, so the row moved and it stayed —
    // floating at full opacity over whichever row took the slot. Asserted as an
    // equal delta rather than as "it moved", so a control that drifts by its own
    // amount is still a failure.
    expect(
      after.chip - before.chip,
      'the trailing control did not travel with the row'
    ).toBeCloseTo(after.row - before.row, 1);
  });

  test('looks right in both themes, at the cockpit width and narrowed', async ({ page }, info) => {
    await openShowcase(page);

    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      for (const name of ['cockpit', 'narrow', 'override'] as const) {
        await info.attach(`sidebar-row-${name}-${theme}`, {
          body: await frame(page, name).screenshot(),
          contentType: 'image/png',
        });
      }
    }
  });
});
