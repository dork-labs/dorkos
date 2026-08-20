import type { Locator, Page, TestInfo } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { SERVER_ROUND_TRIP_MS } from '../../fixtures/rooms-api';
import { PHONE, TOUCH_TARGET_PX, touchHeight, settled } from '../rooms/room-sheet-helpers';

// One cockpit at a time, with the ceiling this repo's other room specs use.
test.describe.configure({ mode: 'default', timeout: 90_000 });

/**
 * Hover does not exist on a phone (P4.2).
 *
 * **Only a laid-out page with a real touch screen can answer any of this.**
 * jsdom reports every element as 0×0, has no viewport and no pointer type — so
 * the unit suite can prove the class that says "44px" is on the element, and
 * only this file can prove the element is 44px. And the gesture itself is
 * genuinely a touch gesture: `useLongPress` runs off Pointer Events, whose
 * `pointerType` and cancellation behaviour a synthesized mouse drag does not
 * reproduce.
 *
 * **The touches here are dispatched through CDP**, not through
 * `page.mouse`. Playwright's `touchscreen` can tap and nothing else, and a
 * mouse press is a different input: it never yields the gesture to the
 * compositor, which is precisely what the scroll case is about.
 */
test.describe('Touch — 390×844 @smoke', () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  /** How long a press must last to be a long press, with room to spare. */
  const HOLD_MS = 800;

  /**
   * Take a shot and leave it on disk beside the run.
   *
   * `path` rather than `body`: an inlined attachment lives only inside the HTML
   * report, and the point of these is that a person opens them next to the
   * mockup.
   *
   * @param page - The page to photograph.
   * @param testInfo - The running test, which owns the output directory.
   * @param name - The file's name, without an extension.
   */
  async function shoot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
    const file = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path: file });
    await testInfo.attach(`${name}.png`, { path: file, contentType: 'image/png' });
  }

  /** The long-press sheet, by the page object that owns it. */
  const sheet = (page: Page) => page.getByTestId('sidebar-menu-sheet');

  /** Go to one of the four destinations and wait for its panel to be usable. */
  async function goTo(page: Page, id: 'home' | 'library' | 'you') {
    await page.getByTestId(`mobile-tab-${id}`).click();
    await expect(page.getByTestId(`mobile-tab-panel-${id}`)).toBeVisible();
  }

  /**
   * The theme, set the way the app itself stores it, before the first paint.
   *
   * Both themes are asserted because the sheet is a new surface and the one
   * thing this codebase's tint rules make easy to get wrong is a seam that
   * separates in opposite directions between them (spec R1).
   */
  async function useTheme(page: Page, theme: 'light' | 'dark') {
    await page.addInitScript((value) => {
      window.localStorage.setItem('dorkos-theme', value);
    }, theme);
  }

  test('long-press on a row opens the same menu the "⋮" opens', async ({
    page,
    basePage,
    roomsApi,
    roomsPage,
    dashboardSidebar,
  }) => {
    const slug = `e2e-touch-menu-${roomsApi.runId}`;
    await roomsApi.createChannel(slug);
    await basePage.goto();
    await basePage.waitForAppReady();
    await goTo(page, 'library');

    const row = roomsPage.rowIn(roomsPage.channels, `#${slug}`);
    await expect(row).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    // Nothing is up before the gesture.
    await expect(sheet(page)).toHaveCount(0);
    await dashboardSidebar.longPress(row, { holdMs: HOLD_MS });
    await expect(sheet(page)).toBeVisible();
    await settled(sheet(page));

    // Every choosable row, by name — and the same list the kebab shows.
    const fromSheet = await sheet(page)
      .locator('[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"]')
      .allInnerTexts();
    expect(fromSheet.length).toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toBeHidden();

    const kebab = row.locator('xpath=ancestor::*[@data-slot="sidebar-menu-item"]').first();
    await kebab.locator('[data-sidebar-actions]').click();
    const menu = page.getByRole('menu').first();
    await expect(menu).toBeVisible();
    const fromKebab = await menu.locator('[role="menuitem"]:not([aria-haspopup])').allInnerTexts();

    // The sheet's TOP level plus its flattened submenus is a superset of what
    // the kebab shows without opening one; every top-level kebab item is in it.
    for (const label of fromKebab) {
      expect(fromSheet.map((t) => t.trim())).toContain(label.trim());
    }
  });

  test('a scroll that begins on a row never opens a menu', async ({
    page,
    basePage,
    roomsApi,
    roomsPage,
    dashboardSidebar,
  }) => {
    // Seeded wide enough that Library genuinely scrolls — a "scroll" on a list
    // that fits is a press that happens to move.
    for (let i = 0; i < 12; i += 1) {
      await roomsApi.createChannel(`e2e-touch-scroll-${i}-${roomsApi.runId}`);
    }
    await basePage.goto();
    await basePage.waitForAppReady();
    await goTo(page, 'library');

    const row = roomsPage.rowIn(roomsPage.channels, `#e2e-touch-scroll-0-${roomsApi.runId}`);
    await expect(row).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    await dashboardSidebar.longPress(row, { holdMs: HOLD_MS, driftPx: 120 });
    await expect(sheet(page)).toHaveCount(0);

    // The pair, in the same browser on the same row: standing still opens it.
    // Without this the assertion above would pass against a build with no
    // long press at all.
    await dashboardSidebar.longPress(row, { holdMs: HOLD_MS });
    await expect(sheet(page)).toBeVisible();
  });

  /**
   * Wait for the bottom slot's card to stop growing before anything is measured.
   *
   * **The card animates its own height in.** `BottomSlot` mounts its winner
   * inside an `AnimatePresence`, so for the first ~160ms the card and every
   * control inside it are somewhere between 0px and their real size. A sweep
   * that started during that window measured a real 44px button at whatever
   * fraction of it had been drawn, and reported a touch-target failure that
   * nothing was wrong with — intermittently, and on a required check.
   *
   * Polls for a height that is both non-zero and unchanged between two reads,
   * because either alone is a race: a mid-animation frame is non-zero, and two
   * equal reads of `0px` are equally stable. A slot with no card to show stays
   * empty (`empty:p-0`) and is skipped rather than waited on.
   *
   * @param panel - The mobile panel being measured.
   */
  async function settleBottomSlot(panel: Locator): Promise<void> {
    const card = panel.locator('[data-slot="sidebar-bottom-slot"] > *').first();
    if ((await card.count()) === 0) return;
    let previous = -1;
    await expect
      .poll(
        async () => {
          const height = await card.evaluate((node) => node.getBoundingClientRect().height);
          const settled = height > 0 && height === previous;
          previous = height;
          return settled;
        },
        { message: 'the bottom slot never settled to a stable height' }
      )
      .toBe(true);
  }

  test('every row and every control a thumb can reach is at least 40px', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const slug = `e2e-touch-size-${roomsApi.runId}`;
    await roomsApi.createChannel(slug);
    await basePage.goto();
    await basePage.waitForAppReady();

    /**
     * Measure everything a panel offers, enumerated from the DOM.
     *
     * A list of selectors written by hand can only ever check the controls
     * somebody remembered; this asks the panel what is in it. `touchHeight`
     * probes with `elementFromPoint` rather than reading the border box, so a
     * control that widens its own reach with a pseudo-element measures as a
     * thumb finds it.
     */
    async function measurePanel(id: 'home' | 'library' | 'you'): Promise<[string, number][]> {
      await goTo(page, id);
      const panel = page.getByTestId(`mobile-tab-panel-${id}`);
      await settleBottomSlot(panel);
      // **`aria-hidden` is the one honest exclusion, and it is not a
      // convenience.** The New menu mounts the direct-message picker with
      // `hideTrigger`, whose anchor is a 1px `sr-only` button carrying
      // `aria-hidden` and `tabIndex={-1}` — offered to nobody, sighted or
      // otherwise, and there only so a popover has something to point at.
      // Everything else stays in, including the "⋮", which the roving-focus
      // hook stamps `tabindex="-1"` at runtime and which a thumb very much is
      // invited to press.
      const controls = panel.locator(
        'button:visible:not([aria-hidden="true"]), [role="menuitem"]:visible'
      );
      const count = await controls.count();
      expect(count).toBeGreaterThan(0);
      const measured: [string, number][] = [];
      for (let i = 0; i < count; i += 1) {
        const control = controls.nth(i);
        // Named well enough to act on. A failure that says `""` sends the
        // reader hunting through three panels for a control with no words on
        // it, so the fallback is the element's own opening tag.
        const name =
          (await control.getAttribute('aria-label')) ||
          (await control.innerText()).trim().slice(0, 40) ||
          (await control.evaluate((el) => el.outerHTML.slice(0, 200)));
        measured.push([`${id}: ${name}`, await touchHeight(control)]);
      }
      return measured;
    }

    const measured = [
      ...(await measurePanel('home')),
      ...(await measurePanel('library')),
      ...(await measurePanel('you')),
    ];
    // The bottom bar too — it is on screen at every moment and it is the one
    // control an operator presses most.
    const tabs = page.locator('[data-mobile-tab]');
    for (let i = 0; i < (await tabs.count()); i += 1) {
      measured.push([`bar: tab ${i}`, await touchHeight(tabs.nth(i))]);
    }

    const short = measured.filter(([, height]) => height < 40);
    expect(short, `controls under 40px: ${JSON.stringify(short)}`).toEqual([]);
    // …and the ones the redesign actually grew reach the 44 they claim.
    const rows = measured.filter(([name]) => name.startsWith('library:'));
    expect(rows.length).toBeGreaterThan(0);
    for (const [name, height] of rows) {
      expect(height, name).toBeGreaterThanOrEqual(TOUCH_TARGET_PX - 1);
    }
  });

  test('You reads as a nav with names on it, not a row of unlabelled glyphs', async ({
    page,
    basePage,
  }) => {
    await basePage.goto();
    await basePage.waitForAppReady();
    await goTo(page, 'you');

    // The bar says where you are, and it has to still say it after a
    // long-press sheet has been up and dismissed.
    await expect(page.getByTestId('mobile-tab-you')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('[data-mobile-tab][aria-current]')).toHaveCount(1);

    const panel = page.getByTestId('mobile-tab-panel-you');
    const destinations = panel.locator('[data-sidebar-destination]');
    await expect(destinations).toHaveCount(4);
    for (const label of ['Home', 'Team', 'Marketplace', 'Connections']) {
      // The words are ON the control, not in a tooltip a finger cannot summon.
      await expect(destinations.filter({ hasText: label })).toHaveCount(1);
    }
    // The account is named rather than hidden behind a "⋯".
    await expect(panel.getByTestId('sidebar-footer-menu-trigger')).toContainText(
      'Account and settings'
    );
    await expect(panel.getByRole('button', { name: 'Ask DorkBot' })).toBeVisible();
  });

  test('the bar shows which destination you are on in more than one channel', async ({
    page,
    basePage,
  }) => {
    // **Found by measuring, not by looking.** The current destination and the
    // other three came back as one colour 12% of alpha apart —
    // `oklab(0.2044 … / 0.7224)` against `… / 0.6` — which is no distinction at
    // all, and colour was the only channel carrying it (spec R2, "colour is
    // never the sole indicator").
    await basePage.goto();
    await basePage.waitForAppReady();
    await goTo(page, 'you');

    const read = (id: string) =>
      page.getByTestId(`mobile-tab-${id}`).evaluate((el) => {
        const style = getComputedStyle(el);
        return { color: style.color, weight: Number(style.fontWeight) };
      });
    const here = await read('you');
    const elsewhere = await read('library');

    expect(here.color).not.toBe(elsewhere.color);
    expect(here.weight).toBeGreaterThan(elsewhere.weight);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`the phone cockpit and its long-press sheet in the ${theme} theme`, async ({
      page,
      basePage,
      roomsApi,
      roomsPage,
      dashboardSidebar,
    }, testInfo) => {
      const slug = `e2e-touch-${theme}-${roomsApi.runId}`;
      await roomsApi.createChannel(slug);
      await useTheme(page, theme);
      await basePage.goto();
      await basePage.waitForAppReady();

      await goTo(page, 'home');
      await shoot(page, testInfo, `home-${theme}`);

      await goTo(page, 'library');
      const row = roomsPage.rowIn(roomsPage.channels, `#${slug}`);
      await expect(row).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      await dashboardSidebar.longPress(row, { holdMs: HOLD_MS });
      await expect(sheet(page)).toBeVisible();
      await settled(sheet(page));
      await shoot(page, testInfo, `long-press-sheet-${theme}`);

      // **Legible in both, measured rather than compared.** The first version
      // of this asked whether the sheet's text colour differed from its
      // background — which holds at 1.05:1 and so could not fail. It reads
      // pixels now, for the reason the showcase's badge guard does: Tailwind v4
      // emits `oklch()`, and parsing those numbers as RGB scores unreadable
      // pairs in the high teens.
      const rowContrast = await sheet(page).evaluate((root) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d')!;
        const pixel = (value: string): [number, number, number, number] => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = value;
          ctx.fillRect(0, 0, 1, 1);
          const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
          return [r!, g!, b!, a! / 255];
        };
        const channel = (v: number) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        const luminance = ([r, g, b]: number[]) =>
          0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
        // The sheet's own surface is what every row sits on; the rows are
        // transparent over it, which is why the background is read once here
        // rather than per row.
        //
        // **Its opacity is reported, not assumed.** A ratio computed against a
        // translucent backdrop is against the wrong colour and reads HIGHER
        // than the truth, so a surface that ever went see-through would quietly
        // clear this bar rather than fail it.
        const surfacePixel = pixel(getComputedStyle(root).backgroundColor);
        const surface = luminance(surfacePixel);
        return {
          surfaceOpaque: surfacePixel[3] === 1,
          rows: [...root.querySelectorAll('[role="menuitem"],[role="menuitemradio"]')].map(
            (node) => {
              const text = luminance(pixel(getComputedStyle(node).color));
              const ratio = (Math.max(text, surface) + 0.05) / (Math.min(text, surface) + 0.05);
              return {
                label: (node.textContent ?? '').trim().slice(0, 30),
                ratio: Math.round(ratio * 100) / 100,
              };
            }
          ),
        };
      });
      // Observable half: there ARE rows, so the bar below cannot be cleared by
      // a sheet that drew none.
      expect(rowContrast.rows.length).toBeGreaterThan(0);
      // …and the colour they were measured against is really the one behind
      // them, which is what makes the ratios below complete answers.
      expect(rowContrast.surfaceOpaque, 'the sheet surface is translucent').toBe(true);
      expect(
        rowContrast.rows.filter((row) => row.ratio < 4.5),
        `a long-press sheet row is below 4.5:1 in the ${theme} theme`
      ).toEqual([]);

      await page.keyboard.press('Escape');
      await expect(sheet(page)).toBeHidden();
      await goTo(page, 'you');
      // The bar has to still say where you are after a sheet has been up and
      // dismissed — the shot is only worth reading if the state in it is real.
      await expect(page.getByTestId('mobile-tab-you')).toHaveAttribute('aria-current', 'page');
      await shoot(page, testInfo, `you-${theme}`);
    });
  }
});
