import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { SERVER_ROUND_TRIP_MS, type RoomsApi, type SeededRoom } from '../../fixtures/rooms-api';
import { PHONE } from '../rooms/room-sheet-helpers';

// One cockpit at a time, with the ceiling this repo's other room specs use:
// these seed rooms against a shared server on a machine that is routinely
// running several worktrees of agents. Nothing here starts an agent turn.
test.describe.configure({ mode: 'default', timeout: 120_000 });

/**
 * The phone cockpit is four destinations along the bottom (P4).
 *
 * **This file used to be about the drawer.** On a phone the sidebar was a sheet
 * drawn over the whole screen, so every row in it led somewhere the sheet was
 * covering, and one router subscription closed it on every commit (DOR-610).
 * P4.1 retired the drawer: `<Sidebar>` is not mounted below 768px, so there is
 * no sheet and no hamburger, and the destinations are always on screen. The
 * first five cases below are the drawer suite's own behaviours re-asked of the
 * thing that replaced it, rather than deleted to go green — including the
 * same-href guard, which is the one this file exists to keep: re-opening the
 * conversation you already have open is the commonest tap there is, TanStack
 * reports it as an unchanged href, and a layout that yielded on href identity
 * left a layer nothing could dismiss (review B1).
 *
 * The rest is what the tabs newly deserve and what P4 promised of them: Home
 * keeps its place across a round trip (AC-1), its badge is Heads up's count and
 * Library never carries one (AC-2), a press and hold reaches the same actions a
 * pointer gets (AC-3), Catch up clears Today in one press (AC-4), and an
 * approval is answered where it stands without going anywhere (AC-5).
 *
 * **Only a laid-out page can prove any of it.** jsdom reports every element as
 * 0×0, has no viewport and no scrolling, so a unit test can assert a panel is
 * put away but not that the destination is what a person is now looking at, and
 * it cannot tell "the panel stayed mounted" from "the panel came back where the
 * operator left it". The long-press gesture is a touch gesture besides — it
 * runs off Pointer Events, whose `pointerType` a synthesized mouse drag does not
 * reproduce — and `mobile-touch.spec.ts` owns the sizing and both-theme halves
 * of that surface. What this file adds is the same sheet reached from **Home**,
 * whose rows come from a different panel and a different zone.
 */
test.describe('Mobile tabs — 390×844 @smoke', () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  /** How long a press must last to be a long press, with room to spare. */
  const HOLD_MS = 800;

  /** Go to one of the four destinations and wait for its panel to be usable. */
  async function goTo(page: Page, id: 'home' | 'library' | 'you') {
    await page.getByTestId(`mobile-tab-${id}`).click();
    await expect(page.getByTestId(`mobile-tab-panel-${id}`)).toBeVisible();
  }

  /** The room id in the address bar, which is what "the room on screen" means. */
  function openRoomId(page: Page): string {
    const id = new URL(page.url()).searchParams.get('id');
    if (id === null) throw new Error(`No room is open: ${page.url()}`);
    return id;
  }

  /**
   * The element that actually scrolls inside a panel.
   *
   * `PageContainer` wraps its content box in an `overflow-y-auto` div and calls
   * the scroller an implementation detail — it carries no test id and no class
   * a spec should reach for. So it is addressed as the content box's PARENT,
   * which is the one stable description of it: `data-slot="page-container"` is
   * the contract that box publishes, and the scroller is by construction the
   * element wrapping it.
   *
   * @param page - The page.
   * @param id - Which destination's panel to read.
   */
  function panelScroller(page: Page, id: 'home' | 'library' | 'you'): Locator {
    return page
      .getByTestId(`mobile-tab-panel-${id}`)
      .locator('[data-slot="page-container"]')
      .locator('xpath=..');
  }

  /** Where a scroller currently sits, in CSS pixels from the top. */
  const scrollTop = (scroller: Locator) => scroller.evaluate((el) => el.scrollTop);

  /**
   * A channel somebody has actually been in, with something unread in it.
   *
   * The entry is not decoration: a room whose `lastActivityAt` still equals its
   * `createdAt` has no "back" to jump to and the recents rules drop it. Nobody
   * is in the room, so posting triggers no turn and costs nothing — and because
   * the post goes through the API rather than through this browser, it does not
   * move the read cursor, so the room arrives unread.
   *
   * @param roomsApi - This test's seeder, which also puts the room away again.
   * @param slug - The channel's slug, unique to this run.
   */
  async function seedChannel(roomsApi: RoomsApi, slug: string): Promise<SeededRoom> {
    const room = await roomsApi.createChannel(slug);
    await roomsApi.postEntries(room.id, ['Where we left off.']);
    return room;
  }

  /**
   * Tell this browser it has been in these rooms, before the first paint.
   *
   * **Today's membership is "places you went", and where you went is a
   * per-device fact.** `entities/interactions` keeps it in localStorage under
   * `dorkos:interactions-v1` and says so in as many words — no server holds it —
   * so a browser test wanting a full Today either seeds that record or drives
   * eight round trips through the router to earn it. The record is seeded here;
   * everything these tests assert on is downstream of it.
   *
   * Timestamps descend from `now` so the order Today comes in is the order the
   * caller passed, and `counts` is filled alongside `opened` because the store's
   * own invariant is that the two maps carry the same keys.
   *
   * @param page - The page, before its first navigation.
   * @param roomIds - The rooms, most recently visited first.
   */
  async function seedVisits(page: Page, roomIds: readonly string[]): Promise<void> {
    await page.addInitScript(
      (payload: { ids: string[]; now: number }) => {
        const opened: Record<string, string> = {};
        const counts: Record<string, number> = {};
        payload.ids.forEach((id, index) => {
          opened[`room:${id}`] = new Date(payload.now - index * 60_000).toISOString();
          counts[`room:${id}`] = 1;
        });
        window.localStorage.setItem(
          'dorkos:interactions-v1',
          JSON.stringify({ state: { opened, counts }, version: 0 })
        );
      },
      { ids: [...roomIds], now: Date.now() }
    );
  }

  test('there is no drawer to open — no sheet, no hamburger', async ({ page, basePage }) => {
    await basePage.goto();
    await basePage.waitForAppReady();

    // The panel itself is not mounted, which is what makes "no sheet" structural
    // rather than styled: the Radix Sheet lives inside `<Sidebar>`.
    await expect(page.locator('[data-slot="sidebar"]')).toHaveCount(0);
    await expect(page.locator('[data-mobile="true"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Toggle Sidebar' })).toHaveCount(0);
    // …and the four destinations are on screen instead, permanently.
    await expect(page.locator('[data-mobile-tab]')).toHaveCount(4);
    await expect(page.getByTestId('mobile-tab-bar')).toBeVisible();
    // …and a cold load lands on the routed page, not on a layer over it: `/`
    // is the #team room, and a phone that opened covered could not reach it.
    await expect(page.getByTestId('mobile-tab-panels')).toBeHidden();
    await expect(page.locator('[data-mobile-tab][aria-current]')).toHaveCount(0);
  });

  test('tapping a channel in Library lands on the room, and the tabs stay', async ({
    page,
    basePage,
    roomsApi,
    roomsPage,
  }) => {
    const slug = `e2e-mobile-nav-${roomsApi.runId}`;
    await roomsApi.createChannel(slug);
    await basePage.goto();
    await basePage.waitForAppReady();

    await goTo(page, 'library');
    const row = roomsPage.rowIn(roomsPage.channels, `#${slug}`);
    await expect(row).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await row.click();

    // The room is what is on screen — the panel yields to where you went rather
    // than sitting on top of it, which was the whole complaint about the drawer.
    await expect(page).toHaveURL(/\/channels\?.*id=/, { timeout: SERVER_ROUND_TRIP_MS });
    await expect(roomsPage.roomHeading).toHaveAccessibleName(`#${slug}`, {
      timeout: SERVER_ROUND_TRIP_MS,
    });
    // The layer itself is down — the assertion `main`'s drawer suite made about
    // the sheet, re-asked of the thing that replaced it.
    await expect(page.getByTestId('mobile-tab-panels')).toBeHidden();
    await expect(page.getByTestId('mobile-tab-panel-library')).toBeHidden();
    // Nothing was dismissed: the destinations are still there to go back with.
    await expect(page.getByTestId('mobile-tab-bar')).toBeVisible();
    await goTo(page, 'library');
    await expect(row).toBeVisible();
  });

  test('re-opening the room you are already in still gets out of the way', async ({
    page,
    basePage,
    roomsApi,
    roomsPage,
  }) => {
    // **The defect review B1 measured, in a browser.** Today pins the open
    // conversation as its first row, so this is the commonest tap there is —
    // and TanStack reports it as an unchanged href. A layout that yielded on
    // href identity left a layer with no way out: no press recovered it.
    const slug = `e2e-mobile-same-${roomsApi.runId}`;
    await roomsApi.createChannel(slug);
    await basePage.goto();
    await basePage.waitForAppReady();

    await goTo(page, 'library');
    const row = roomsPage.rowIn(roomsPage.channels, `#${slug}`);
    await expect(row).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await row.click();
    await expect(page).toHaveURL(/\/channels\?.*id=/, { timeout: SERVER_ROUND_TRIP_MS });
    const settled = page.url();

    // Open the very same room again from the very same row.
    await goTo(page, 'library');
    await row.click();

    await expect(page.getByTestId('mobile-tab-panels')).toBeHidden();
    expect(page.url()).toBe(settled);
    await expect(roomsPage.roomHeading).toHaveAccessibleName(`#${slug}`);
  });

  test('the top-level destinations are reachable from You', async ({ page, basePage }) => {
    await basePage.goto();
    await basePage.waitForAppReady();

    await goTo(page, 'you');
    // By test id, not by name: the id still reads "agents" though the nav now
    // says Team — it is a tour anchor, and renaming it would strand every tour
    // already in progress (DOR-973, `tour-anchors.ts`). The four places DorkOS
    // goes are one implementation, and on a phone it lives here rather than in
    // a panel footer that no longer exists.
    await page.getByTestId('nav-agents').click();

    // `/team`, not `/agents`: DOR-973 made the Team page the destination and
    // left `/agents` as a redirecting alias for addresses this repo does not
    // own.
    await expect(page).toHaveURL(/\/team/, { timeout: SERVER_ROUND_TRIP_MS });
    await expect(page.getByTestId('mobile-tab-bar')).toBeVisible();
    // The panel yields to the destination — main's original asserted the sheet
    // hidden after a top-level nav click, and the tab world keeps that claim.
    await expect(page.getByTestId('mobile-tab-panels')).toBeHidden();
  });

  test('picking inside the New message sheet dismisses nothing until the conversation starts', async ({
    page,
    basePage,
    roomsApi,
    roomsPage,
  }) => {
    const ana = await roomsApi.registerAgent(`E2E Ana ${roomsApi.runId}`, '🦊', '#e07b39');
    await basePage.goto();
    await basePage.waitForAppReady();

    // New stays in the header, and on a phone the header is the top of Home —
    // there is no FAB (§9). Driven through the New menu itself rather than the
    // Direct messages section's `+`, because that `+` lives in the Library
    // panel and this case is about the one in Home.
    await goTo(page, 'home');
    await roomsPage.newMenu.choose('new-message');
    await roomsPage.agentSearch.waitFor({ state: 'visible' });

    // The picker is its own sheet. Opening it is not a destination, and neither
    // is choosing who to talk to — a half-assembled conversation survives.
    const chip = roomsPage.agentChip(ana.name);
    await roomsPage.chooseAgent(ana.name);
    await expect(chip).toBeVisible();
    // The pair `main` asserted about the sheet: nothing is dismissed mid-pick.
    await expect(page.getByTestId('mobile-tab-panels')).toBeVisible();
    await expect(roomsPage.agentSearch).toBeVisible();

    // Starting the conversation is a destination, and lands on it.
    await roomsPage.startConversationButton.click();
    await expect(page).toHaveURL(/\/channels\?.*id=/, { timeout: SERVER_ROUND_TRIP_MS });
    roomsApi.track(openRoomId(page));
    // …and the other half of the pair: starting the conversation IS a
    // destination, so the layer gets out of its way.
    await expect(page.getByTestId('mobile-tab-panels')).toBeHidden();
    await expect(roomsPage.roomHeading).toHaveAccessibleName(ana.name, {
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await expect(page.getByTestId('mobile-tab-bar')).toBeVisible();
  });

  test('Home comes back where you left it after a look at Library (AC-1)', async ({
    page,
    basePage,
    roomsApi,
    teamRoomApi,
  }) => {
    // **Seeded until Home genuinely overflows, and it takes both halves.** A
    // panel that fits has no scroll offset to lose, so "the offset survived"
    // would be true of a build that remounted the panel on every switch — the
    // exact regression AC-1 is about, and the precondition below fails loudly
    // rather than letting the case pass on a panel with nowhere to go. Today
    // alone tops out at its soft cap of eight rows and measured 620px against
    // an 788px panel; the two approval cards are what carry it over, which is
    // also the state a phone most needs to keep its place in.
    const rooms: SeededRoom[] = [];
    for (let i = 0; i < 9; i += 1) {
      rooms.push(await seedChannel(roomsApi, `e2e-mobile-scroll-${i}-${roomsApi.runId}`));
    }
    await teamRoomApi.seedApproval();
    await teamRoomApi.seedApproval();
    await seedVisits(
      page,
      rooms.map((room) => room.id)
    );
    await basePage.goto();
    await basePage.waitForAppReady();
    await goTo(page, 'home');

    const home = panelScroller(page, 'home');
    // Both halves have to have arrived before there is anything to scroll past.
    await expect(page.getByTestId('mobile-now-attention')).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await expect(
      page.locator('[data-sidebar-zone="today"] [data-sidebar-row]').first()
    ).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await expect
      .poll(() => home.evaluate((el) => el.scrollHeight - el.clientHeight), {
        message: 'Home never grew taller than the phone — seed more conversations into Today',
        timeout: SERVER_ROUND_TRIP_MS,
      })
      .toBeGreaterThan(150);

    await home.evaluate((el) => {
      el.scrollTop = 140;
    });
    // What the operator was looking at, named rather than inferred from a
    // number: a panel that re-rendered its way back to the same offset with
    // different rows under it has not kept their place.
    const parked = await scrollTop(home);
    expect(parked, 'the panel refused the scroll').toBeGreaterThan(100);

    await goTo(page, 'library');
    await expect(page.getByTestId('mobile-tab-panel-home')).toBeHidden();
    await goTo(page, 'home');

    expect(await scrollTop(home), 'Home was remounted, so it started at the top').toBe(parked);
  });

  test('the Home badge is Heads up’s count, and Library never carries one (AC-2)', async ({
    page,
    basePage,
    teamRoomApi,
  }) => {
    // A capability approval is the cheapest thing on this server that genuinely
    // needs a person: it becomes a `permission-prompt` attention signal, which
    // is one of the four kinds Heads up counts. Two, so the badge has to print a
    // number rather than merely exist.
    await teamRoomApi.seedApproval();
    await teamRoomApi.seedApproval();
    await basePage.goto();
    await basePage.waitForAppReady();
    await goTo(page, 'home');

    const badge = page.getByTestId('mobile-tab-badge-home');
    await expect(badge).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    // **Checked against the server, not against the number this test seeded.**
    // The badge is `needsYouCount`, which counts every blockage — so comparing
    // it to the queue is what makes this an assertion about the count rather
    // than about approvals, and a blocked session anywhere on this leg makes the
    // two disagree loudly instead of quietly passing.
    const waiting = (await teamRoomApi.pendingApprovalIds()).length;
    expect(waiting, 'nothing is waiting, so the badge has nothing to be').toBeGreaterThanOrEqual(2);
    await expect(badge).toHaveText(String(waiting));

    // The same number, said out loud once, from outside the panels — the region
    // the badge is `aria-hidden` in deference to.
    await expect(page.getByTestId('mobile-needs-you-live-region')).toHaveText(
      new RegExp(`^${waiting} agents? need you$`),
      { timeout: SERVER_ROUND_TRIP_MS }
    );

    // Library is the calm surface, and it is badgeless while Home is at its
    // loudest — which is the only moment the claim means anything.
    await expect(page.getByTestId('mobile-tab-badge-library')).toHaveCount(0);
    await expect(page.getByTestId('mobile-tab-badge-you')).toHaveCount(0);
    await expect(page.locator('[data-mobile-tab] [data-testid^="mobile-tab-badge-"]')).toHaveCount(
      1
    );
  });

  test('an approval is answered from Home, and nothing moves (AC-5)', async ({
    page,
    basePage,
    teamRoomApi,
  }) => {
    const approvalId = await teamRoomApi.seedApproval();
    await basePage.goto();
    await basePage.waitForAppReady();
    await goTo(page, 'home');

    const slot = page.getByTestId('mobile-now-attention');
    await expect(slot).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    const cards = slot.locator('[data-slot="approval-card"]');
    const before = await cards.count();
    expect(before, 'no card to answer').toBeGreaterThan(0);
    const settled = page.url();

    await cards.first().locator('[data-slot="approval-allow"]').click();

    // Answered IN PLACE: the checkmark replaces the buttons on the card that is
    // still standing, and only then does the card leave. Asserting the
    // checkmark BEFORE the count drop is what distinguishes "resolves in place"
    // from "vanishes on click".
    await expect(slot.locator('[data-slot="approval-resolved"]').first()).toBeVisible();
    await expect(cards).toHaveCount(before - 1, { timeout: SERVER_ROUND_TRIP_MS });

    // The decision reached the server, not just the DOM.
    await expect
      .poll(() => teamRoomApi.pendingApprovalIds(), { timeout: SERVER_ROUND_TRIP_MS })
      .not.toContain(approvalId);

    // **"Without navigation" is the whole point.** Answering from a phone used
    // to mean finding the conversation the prompt came from; the address bar
    // never moving is what says it no longer does — and Home is still the
    // destination on screen, so the operator did not lose their place either.
    expect(page.url()).toBe(settled);
    await expect(page.getByTestId('mobile-tab-home')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('mobile-tab-panel-home')).toBeVisible();
  });

  test('Catch up clears Today’s unread in one press (AC-4)', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const rooms: SeededRoom[] = [];
    for (let i = 0; i < 3; i += 1) {
      rooms.push(await seedChannel(roomsApi, `e2e-mobile-catchup-${i}-${roomsApi.runId}`));
    }
    for (const room of rooms) await roomsApi.waitForUnread(room.id, 1);
    await seedVisits(
      page,
      rooms.map((room) => room.id)
    );
    await basePage.goto();
    await basePage.waitForAppReady();
    await goTo(page, 'home');

    // **The count is exact, because the seed makes it knowable.** Today's
    // membership is the rooms `seedVisits` named — nothing else on this leg has
    // been visited by this browser — and `/` is the #team room, which this test
    // reads and so leaves with nothing unread. A range would pass on any
    // plausible number; this fails on the wrong one.
    const catchUp = page.getByTestId('today-catch-up');
    await expect(catchUp).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await expect(catchUp).toHaveAccessibleName(
      `Catch up — mark ${rooms.length} unread conversations in Today as read`,
      { timeout: SERVER_ROUND_TRIP_MS }
    );

    await catchUp.click();

    // Server truth first: every room this test made really is read now. The
    // control's own disappearance is the second half — with nothing left to
    // clear there is no action, because an action that would do nothing is the
    // loudest kind of nothing (BC-32).
    for (const room of rooms) await roomsApi.waitForUnread(room.id, 0);
    await expect(catchUp).toHaveCount(0, { timeout: SERVER_ROUND_TRIP_MS });
    // Today did not empty itself in the process — the rows are still there to
    // go back to, which is what makes this "marked read" and not "cleared".
    await expect(
      page.locator('[data-sidebar-zone="today"] [data-sidebar-row]').first()
    ).toBeVisible();
  });

  test('a press and hold in Home offers what the “⋮” offers (AC-3)', async ({
    page,
    basePage,
    roomsApi,
    dashboardSidebar,
  }) => {
    // `mobile-touch.spec.ts` proves the gesture, its drift guard, its sizing and
    // both themes — from LIBRARY. This asks the one thing that file cannot: that
    // Home's rows, which come from a different panel and a different zone, reach
    // the same actions a pointer reaches.
    const slug = `e2e-mobile-home-menu-${roomsApi.runId}`;
    const room = await seedChannel(roomsApi, slug);
    await seedVisits(page, [room.id]);
    await basePage.goto();
    await basePage.waitForAppReady();
    await goTo(page, 'home');

    const row = page
      .locator('[data-sidebar-zone="today"] [data-sidebar-row]')
      .filter({ hasText: `#${slug}` })
      .first();
    await expect(row).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    await expect(dashboardSidebar.longPressSheet).toHaveCount(0);
    await dashboardSidebar.longPress(row, { holdMs: HOLD_MS });
    await expect(dashboardSidebar.longPressSheet).toBeVisible();
    const fromSheet = (
      await dashboardSidebar.longPressSheet
        .locator('[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"]')
        .allInnerTexts()
    ).map((text) => text.trim());
    expect(fromSheet.length, 'the sheet opened with nothing in it').toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    await expect(dashboardSidebar.longPressSheet).toBeHidden();

    // The desktop action set, from the same row: the "⋮" a pointer uses.
    const item = row.locator('xpath=ancestor::*[@data-slot="sidebar-menu-item"]').first();
    await item.locator('[data-sidebar-actions]').click();
    const menu = page.getByRole('menu').first();
    await expect(menu).toBeVisible();
    const fromKebab = await menu.locator('[role="menuitem"]:not([aria-haspopup])').allInnerTexts();
    expect(fromKebab.length, 'the kebab menu opened with nothing in it').toBeGreaterThan(0);
    for (const label of fromKebab) {
      expect(fromSheet).toContain(label.trim());
    }
  });
});
