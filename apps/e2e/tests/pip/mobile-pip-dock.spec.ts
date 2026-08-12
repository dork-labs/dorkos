/**
 * A docked PIP must not take the phone's cockpit away (DOR-1177).
 *
 * The mini-bar is `fixed` at `z-40`. The four destinations along the bottom of a
 * phone are in-flow chrome with no z-index at all, so a bar on the bottom edge
 * paints straight over them: measured at 390×844 before the fix,
 * `elementFromPoint` over every one of the four glyphs answered with the PIP
 * bar, and Playwright refused each click with "subtree intercepts pointer
 * events". Every destination in the app was unreachable while a PIP was parked.
 *
 * **Why there was no test to catch that, and what changed.** Every real way to
 * open a PIP needs a live model turn — an agent emits a `dorkos-ui` fence or an
 * MCP app and somebody pops it out — so this state could not be reached from a
 * browser test at all, and the defect was found by reading CSS. The client now
 * carries a development-only seam for it: `?pip=demo` opens the `demo` PIP kind,
 * which renders a static body and needs no session (`PipHost.tsx`,
 * `useDevPipDeepLink`). `import.meta.env.DEV` is replaced with `false` at build
 * time, so no shipped bundle answers that URL; the browser suite runs against
 * the Vite dev server, which is where it does.
 *
 * From there the test is the operator's own path: the sheet opens at peek, its
 * chevron minimizes it to the bar, and the four destinations are asked whether
 * they are still there.
 *
 * **Both themes.** The geometry is theme-independent and the assertions here
 * would not notice a theme at all — but the screenshots this leaves behind are
 * how a person checks that a bar sitting on top of another bar reads as two
 * surfaces rather than as one smudge, and that is exactly the thing that
 * separates in opposite directions between the two ramps.
 *
 * No agent, no room, no seeded state: this is chrome, so it is `@smoke`.
 */
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { PHONE, rectOf } from '../rooms/room-sheet-helpers';

/** The docked PIP, by the slot it stamps on itself. */
const miniBar = (page: Page) => page.locator('[data-slot="pip-minibar"]');

/** The four destinations, by the id the bar stamps on each button. */
const DESTINATIONS = ['home', 'library', 'dorkbot', 'you'] as const;

/** The three that show a panel. DorkBot opens a conversation instead. */
const PANEL_DESTINATIONS = ['home', 'library', 'you'] as const;

test.describe('PIP on a phone — 390×844 @smoke', () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  /**
   * The theme, set the way the app itself stores it, before the first paint.
   *
   * @param page - The page to dress.
   * @param theme - Which ramp to use.
   */
  async function useTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
    await page.addInitScript((value) => {
      window.localStorage.setItem('dorkos-theme', value);
    }, theme);
  }

  /**
   * Leave a shot on disk beside the run, and attach it to the report.
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

  /**
   * Open a demo PIP through the dev seam and tuck it into the mini-bar, the way
   * a person does — the sheet's own chevron, not a store write.
   *
   * @param page - The page to drive.
   */
  async function dockAPip(page: Page): Promise<void> {
    await page.goto('/?pip=demo');
    await page.waitForSelector('[data-testid="app-shell"]');
    // The seam opens the sheet at peek, which is the state a pop-out lands in.
    await expect(page.locator('[data-slot="pip-sheet"]')).toBeVisible();
    await page.getByRole('button', { name: 'Minimize' }).click();
    await expect(page.locator('[data-slot="pip-minibar"]')).toBeVisible();
  }

  for (const theme of ['light', 'dark'] as const) {
    test(`every destination is still reachable with a PIP docked (${theme})`, async ({
      page,
    }, testInfo) => {
      await useTheme(page, theme);
      await dockAPip(page);

      const bar = page.getByTestId('mobile-tab-bar');

      // **The bar keeps the bottom edge.** Asserted as a relation between the
      // two boxes rather than against 788px, so it keeps meaning what it says
      // when either height changes or a device adds a home indicator.
      //
      // `rectOf`, not `boundingBox()`: the mini-bar arrives on a spring, and a
      // box read mid-flight is a box the fix never claimed. Measured on a first
      // pass here — the bar was still 12px into its slide and the assertion
      // failed against an arrangement that was correct a frame later.
      const barBox = await rectOf(bar);
      const miniBox = await rectOf(miniBar(page));
      // One pixel of slack: laid-out boxes are fractional.
      expect(miniBox.bottom).toBeLessThanOrEqual(barBox.top + 1);
      expect(barBox.bottom).toBeGreaterThanOrEqual(PHONE.height - 1);

      // **What the browser would hit, which is the only question that matters.**
      // A box that merely sits elsewhere is not proof: the failing arrangement
      // had a bar whose box overlapped the tabs, and this is what saw it.
      for (const id of DESTINATIONS) {
        const tab = page.getByTestId(`mobile-tab-${id}`);
        // A destination that performs an act is disabled until it has something
        // to act on, and a disabled tab takes itself out of hit-testing
        // (`disabled:pointer-events-none`) — so waiting here is what keeps the
        // probe below asking about the button rather than about the nav.
        await expect(tab).toBeEnabled();
        const hit = await tab.evaluate((el) => {
          const box = el.getBoundingClientRect();
          const at = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return at?.closest('[data-mobile-tab]')?.getAttribute('data-testid') ?? null;
        });
        expect(hit, `${id} is covered`).toBe(`mobile-tab-${id}`);
      }

      // And a real press opens what it names, which is the claim the geometry
      // is evidence for. Playwright's actionability check refuses a covered
      // control, so this is a second, independent reading of the same fact.
      for (const id of PANEL_DESTINATIONS) {
        await page.getByTestId(`mobile-tab-${id}`).click();
        await expect(page.getByTestId(`mobile-tab-panel-${id}`)).toBeVisible();
      }

      await shoot(page, testInfo, `pip-docked-panel-up-${theme}`);
    });
  }

  test('the panels and the routed page both stop above the docked bar', async ({ page }) => {
    await dockAPip(page);

    const miniBox = await rectOf(miniBar(page));

    // The routed page lifts by the bar's height — `--pip-dock`, the padding the
    // shell has always applied. Read as a number so a missing variable (which
    // computes to the `0px` fallback) fails rather than passing as a string.
    const routedPagePadding = await page.evaluate(() => {
      const main = document.getElementById('app-tab-panel');
      return main === null ? null : parseFloat(getComputedStyle(main).paddingBottom);
    });
    expect(routedPagePadding).toBe(miniBox.height);

    // The tab panels are a `fixed` layer of their own and read no padding at
    // all, so they carry the dock in the height they stop at instead. Raised
    // first: a panel that is put away has no box worth measuring.
    await page.getByTestId('mobile-tab-home').click();
    await expect(page.getByTestId('mobile-tab-panel-home')).toBeVisible();
    const panels = await rectOf(page.getByTestId('mobile-tab-panels'));
    expect(panels.bottom).toBeLessThanOrEqual(miniBox.top + 1);
  });
});
