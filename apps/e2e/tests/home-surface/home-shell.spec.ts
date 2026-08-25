import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { HOME_TABS, SIDEBAR_NAV_LABELS } from '../../pages/HomeSurfacePage';
import { rectOf } from '../rooms/room-sheet-helpers';

/**
 * The home surface shell (spec `team-room-home`, Phase 1).
 *
 * Four sidebar destinations used to be seven. Home, Activity, Scheduled and
 * Workspaces are one place now — one tab bar over four routes that kept their
 * addresses — and the sidebar answers the shorter question of which part of
 * DorkOS you are in.
 *
 * **Why any of this is a browser test.** Three of the four claims cannot be made
 * in jsdom at all. "The tab bar scrolls sideways and the page does not" is a
 * statement about layout, and jsdom reports every element as 0×0 with no
 * viewport. "A deep link keeps its filter" spans the router, the search schema
 * and two components that never meet in one unit test. And a nav-item count is
 * only worth asserting against the real shell — the unit suite mounts
 * `SidebarFooterStrip` standalone, so it would still pass with a fifth
 * destination added anywhere else in the sidebar.
 *
 * No agent turn, no model, no seeded state: this is chrome, so it is `@smoke`.
 */
test.describe('Home surface — the shell @smoke', () => {
  test.beforeEach(async ({ basePage }) => {
    await basePage.goto();
    await basePage.waitForAppReady();
  });

  test('the tab bar is Home, Activity, Scheduled, Workspaces — and Home is lit on /', async ({
    homeSurface,
  }) => {
    await expect(homeSurface.tabBar).toBeVisible();
    await expect(homeSurface.tabs).toHaveText(HOME_TABS.map((tab) => tab.label));

    // Exactly one tab reads active, and on `/` it is Home.
    await expect(homeSurface.activeTab).toHaveCount(1);
    await expect(homeSurface.activeTab).toHaveText('Home');
  });

  test('each tab goes to the address it has always had', async ({ page, homeSurface }) => {
    for (const { label, path } of HOME_TABS) {
      await homeSurface.tab(label).click();
      // The exact path, anchored: a prefix match would let `/tasks` satisfy a
      // check for `/`, which is the one mistake this table exists to catch.
      await expect(page).toHaveURL(new RegExp(`${path.replace(/\//g, '\\/')}(\\?|$)`));
      await expect(homeSurface.activeTab).toHaveText(label);
    }
  });

  test('a filtered Activity deep link keeps its filter, and survives leaving and coming back', async ({
    page,
    basePage,
    homeSurface,
  }) => {
    // `agent` is a real category (`ActivityFilterBar`'s CATEGORIES), so the chip
    // it lights is something a person can see, not just a string in the URL.
    await page.goto('/activity?categories=agent');
    await basePage.waitForAppReady();

    // Scoped to the bar itself: "All" and "Agent" are common enough words that
    // an unscoped role query eventually finds a second control somewhere in the
    // shell and fails the strict-mode check for a reason unrelated to filters.
    const filterBar = page.locator('[data-slot="activity-filter-bar"]');
    const allChip = filterBar.getByRole('button', { name: 'All', exact: true });
    const agentChip = filterBar.getByRole('button', { name: 'Agent', exact: true });

    // The tab bar agrees with the address bar, and the filter arrived applied:
    // the layout route declares no `validateSearch`, so `/activity` keeps its own.
    await expect(homeSurface.activeTab).toHaveText('Activity');
    await expect(agentChip).toHaveAttribute('aria-pressed', 'true');
    await expect(allChip).toHaveAttribute('aria-pressed', 'false');

    // Move to another tab and back with the browser's own history, which is what
    // a person does. The whole address comes back, filter included.
    await homeSurface.tab('Schedules').click();
    await expect(page).toHaveURL(/\/tasks(\?|$)/);
    await expect(homeSurface.activeTab).toHaveText('Schedules');

    await page.goBack();
    await expect(page).toHaveURL(/\/activity\?.*categories=agent/);
    await expect(homeSurface.activeTab).toHaveText('Activity');
    await expect(agentChip).toHaveAttribute('aria-pressed', 'true');
  });

  test('the sidebar has four places — nothing else', async ({ basePage, homeSurface }) => {
    await basePage.ensureSidebarOpen();

    // The count and the words, in order. A fifth destination anywhere in this
    // strip fails the first assertion before anyone has to notice the label —
    // the locator is structural (`data-sidebar-destination`), so a newcomer is
    // counted whatever it is called.
    await expect(homeSurface.sidebarNavButtons).toHaveCount(SIDEBAR_NAV_LABELS.length);
    for (const [index, label] of SIDEBAR_NAV_LABELS.entries()) {
      // The ACCESSIBLE name, not the text. These are icon buttons: the word is
      // in `aria-label`, `textContent` is empty, and a text assertion here read
      // green on the old lettered nav and red the moment the strip landed.
      await expect(homeSurface.sidebarNavButtons.nth(index)).toHaveAccessibleName(label);
    }

    // The three that moved into the tab bar are gone from the sidebar entirely —
    // not merely renamed or reordered.
    for (const gone of [
      'Activity',
      'Schedules',
      'Scheduled',
      'Tasks',
      'Workspaces',
      'Dashboard',
    ]) {
      await expect(homeSurface.sidebarNav.getByRole('button', { name: gone })).toHaveCount(0);
    }
  });

  test('the dashboard is gone, not hidden — Home is the #team room', async ({
    page,
    homeSurface,
  }) => {
    // The sections that used to be here were retired rather than collapsed. A
    // count of zero is the claim: an element that is merely `hidden` still
    // matches, which is what makes this worth asserting on the real page.
    await expect(page.getByRole('heading', { name: /your agents/i })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /system status/i })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /recent activity/i })).toHaveCount(0);
    // The dashboard composer's question went with it: this box posts to a room
    // now, it does not birth a session.
    await expect(page.getByRole('heading', { name: 'What are we building today?' })).toHaveCount(0);

    // What stands there instead: the room, named by the box you type in.
    await expect(homeSurface.composer).toBeVisible();
    await expect(homeSurface.composerField).toHaveAttribute('placeholder', /#team/);
  });
});

/**
 * The phone case, at the narrowest width the cockpit supports.
 *
 * 375px is the iPhone SE / mini class, and it is where a bar of four labels
 * either fits, scrolls, or pushes the whole page sideways. The third is the
 * failure this describes: a page that scrolls horizontally is one where every
 * other surface drifts under the reader's thumb.
 */
test.describe('Home surface — 375px @smoke', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('the tab bar takes the overflow, and the page never scrolls sideways', async ({
    page,
    basePage,
    homeSurface,
  }) => {
    await basePage.goto();
    await basePage.waitForAppReady();
    await expect(homeSurface.tabBar).toBeVisible();

    // The bar is the scroll container, whether or not four labels happen to
    // overflow it today. This is the property that keeps holding when a fifth
    // tab arrives, which a width comparison against today's four cannot state.
    await expect(homeSurface.tabBar).toHaveCSS('overflow-x', 'auto');

    // Nothing above it overflows the viewport — the actual complaint.
    const pageOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(pageOverflow.scrollWidth).toBeLessThanOrEqual(pageOverflow.clientWidth);

    // Every tab is reachable once scrolled to — a tab you cannot reach is not a
    // tab — and each one is the full height of the bar it lives in.
    //
    // **35, spelled out.** The tabs ride inside the one header bar now (phase
    // H1). That header is 36px and its last pixel is the bottom hairline, so a
    // tab filling the row measures 35 — the number Chromium reports, not the
    // number the CSS reads like. It is a literal rather than a measurement off
    // the bar, because a height compared against the bar's own height passes at
    // any height at all, including the 24px targets this assertion exists to
    // catch (each tab as tall as its text inside a 36px row, DOR-1401). 35px is
    // below the 44px touch guidance: a deliberate trade — one 36px row beats two
    // rows totalling 80px on an 844px screen — recorded at the phone checkpoint.
    const TAB_HEIGHT = 35;
    for (const { label } of HOME_TABS) {
      const tab = homeSurface.tab(label);
      await tab.scrollIntoViewIfNeeded();
      const box = await tab.boundingBox();
      expect(box, `${label} has no box`).not.toBeNull();
      expect(box!.height).toBe(TAB_HEIGHT);
      expect(box!.x).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(376);
    }
  });
});

/**
 * The bar holds more than a phone shows, and has to say so (DOR-1180).
 *
 * 390×844 is the iPhone 14/15 class, and it is the width the complaint came
 * from: the strip opened on `Home | Activity | Scheduled | Workspac` — 430px of
 * labels in a 390px box — and a word cut mid-letter with nothing to explain it
 * is the first thing a phone user ever saw of DorkOS. The scrolling itself was
 * never the bug (the block above pins that the page does not scroll with it, and
 * sideways is what keeps working when a fifth tab arrives); the bug was that
 * nothing on screen said the bar had more, and macOS draws no scrollbar until
 * you have already scrolled.
 *
 * **Only a real browser can answer any of this.** The cue is a function of
 * `scrollWidth` against `clientWidth` in the shipped font at a real width, and
 * jsdom reports every element as 0×0 — the unit suite can prove what the
 * component does with a measurement, and only this can prove the measurement.
 *
 * Both themes: the fade is drawn from `--background`, which is the one thing a
 * theme changes about it, and a cue that reads as a smudge in one ramp is not a
 * cue.
 */
test.describe('Home surface — the tab bar at 390px @smoke', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  /**
   * The strip once it has stopped changing width, with the numbers it settled
   * on.
   *
   * **Web fonts move this, and that cost a red run.** The app loads its type
   * asynchronously, so the strip is one width in the fallback face and another
   * once the real one lands. A test that scrolled to the end before that
   * happened found the end cue back a moment later, because the content had
   * grown under a scroll position that was correct when it was set — the same
   * "a late web font resizes the content while the box stays put" case the
   * scroll hook observes a `ResizeObserver` for. So: wait for the fonts, then
   * require two identical readings before believing either.
   *
   * @param page - The page being measured.
   * @param bar - The tab bar, which is its own scroll container.
   */
  async function settledStrip(
    page: Page,
    bar: Locator
  ): Promise<{ client: number; scroll: number }> {
    await page.evaluate(() => document.fonts.ready);
    const read = () => bar.evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
    let previous = await read();
    await expect
      .poll(async () => {
        const next = await read();
        const stable = next.scroll === previous.scroll && next.client === previous.client;
        previous = next;
        return stable;
      })
      .toBe(true);
    return previous;
  }

  for (const theme of ['light', 'dark'] as const) {
    test(`says there is more to the right, and swaps sides at the end (${theme})`, async ({
      page,
      basePage,
      homeSurface,
    }) => {
      await page.addInitScript((value) => {
        window.localStorage.setItem('dorkos-theme', value);
      }, theme);
      await basePage.goto();
      await basePage.waitForAppReady();

      // The premise. If four labels ever start fitting 390px, everything below
      // is vacuous and this is what says so out loud instead of passing quietly.
      const strip = await settledStrip(page, homeSurface.tabBar);
      expect(
        strip.scroll,
        'four labels now fit 390px — this suite needs rewriting'
      ).toBeGreaterThan(strip.client);

      // Parked at the start: the cue points the one way there is to go.
      await expect(homeSurface.tabsFadeEnd).toBeVisible();
      await expect(homeSurface.tabsFadeStart).toHaveCount(0);

      // At the end of the scroll it swaps sides rather than hanging over an edge
      // with nothing behind it (ADR 260725-004456).
      await homeSurface.tabBar.evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
      });
      await expect(homeSurface.tabsFadeStart).toBeVisible();
      await expect(homeSurface.tabsFadeEnd).toHaveCount(0);
    });
  }

  test('a deep link to the last tab opens with that tab on screen', async ({
    page,
    basePage,
    homeSurface,
  }) => {
    // Workspaces is the tab that starts past the right edge, so a bookmark to it
    // used to open a bar whose active marker was off screen — the address bar
    // said where you were and the bar said nothing.
    await page.goto('/workspaces');
    await basePage.waitForAppReady();
    await expect(homeSurface.activeTab).toHaveText('Workspaces');
    await settledStrip(page, homeSurface.tabBar);

    const box = await rectOf(homeSurface.activeTab);
    // Fully inside the viewport, both edges — a marker half off the screen
    // answers the question no better than one entirely off it.
    expect(box.left).toBeGreaterThanOrEqual(-1);
    expect(box.right).toBeLessThanOrEqual(391);
  });

  test('draws no cue on a desktop, where all four already fit', async ({
    page,
    basePage,
    homeSurface,
  }) => {
    // The other half of the rule: the affordance costs nothing where there is
    // nothing to advertise. Same page, one resize — so this cannot pass by
    // testing a different app.
    await basePage.goto();
    await basePage.waitForAppReady();
    await expect(homeSurface.tabsFadeEnd).toBeVisible();

    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(homeSurface.tabsFadeEnd).toHaveCount(0);
    await expect(homeSurface.tabsFadeStart).toHaveCount(0);
  });
});
