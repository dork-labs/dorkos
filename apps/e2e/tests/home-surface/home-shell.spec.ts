import { test, expect } from '../../fixtures';
import { HOME_TABS, SIDEBAR_NAV_LABELS } from '../../pages/HomeSurfacePage';

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
    await homeSurface.tab('Scheduled').click();
    await expect(page).toHaveURL(/\/tasks(\?|$)/);
    await expect(homeSurface.activeTab).toHaveText('Scheduled');

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
    for (const gone of ['Activity', 'Scheduled', 'Tasks', 'Workspaces', 'Dashboard']) {
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

    // Every tab is reachable and big enough to hit with a thumb. 44px is the
    // `min-h-11` the bar sets for exactly this, and each tab has to be inside
    // the viewport once scrolled to — a tab you cannot reach is not a tab.
    //
    // One pixel of slack on the edges, because a laid-out box is fractional:
    // the last tab measures 375.3125 at the end of the bar's scroll, which is a
    // third of a pixel and not a tab anybody has trouble hitting. Wider than
    // that is a real overhang.
    for (const { label } of HOME_TABS) {
      const tab = homeSurface.tab(label);
      await tab.scrollIntoViewIfNeeded();
      const box = await tab.boundingBox();
      expect(box, `${label} has no box`).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.x).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(376);
    }
  });
});
