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

      // Legible in both: the sheet's own background is the app background and
      // its rows sit on it, so a theme flip may not leave text on its own
      // colour.
      const contrast = await sheet(page).evaluate((el) => {
        const style = getComputedStyle(el);
        return { color: style.color, background: style.backgroundColor };
      });
      expect(contrast.color).not.toBe(contrast.background);

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
