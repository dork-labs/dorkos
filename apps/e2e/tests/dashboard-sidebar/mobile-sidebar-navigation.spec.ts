import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { SOLE_SIDEBAR_TAG } from '../../fixtures/sole-access';
import { SERVER_ROUND_TRIP_MS, type RoomsApi, type SeededRoom } from '../../fixtures/rooms-api';
import { PHONE } from '../rooms/room-sheet-helpers';

// One cockpit at a time, with the ceiling this repo's other room specs use:
// these seed rooms against a shared server on a machine that is routinely
// running several worktrees of agents. Nothing here starts an agent turn.
test.describe.configure({ mode: 'default', timeout: 120_000 });

/**
 * The phone cockpit is three destinations along the bottom (P4): Home, which
 * is the whole sidebar list with what is waiting on you answered at its top,
 * DorkBot, and You.
 *
 * **This file used to be about the drawer.** On a phone the sidebar was a sheet
 * drawn over the whole screen, so every row in it led somewhere the sheet was
 * covering, and one router subscription closed it on every commit (DOR-610).
 * P4.1 retired the drawer: `<Sidebar>` is not mounted below 768px, so there is
 * no sheet and no hamburger, and the destinations are always on screen. The
 * first cases below are the drawer suite's own behaviours re-asked of the thing
 * that replaced it — including the same-href guard: re-opening the
 * conversation you already have open is the commonest tap there is, TanStack
 * reports it as an unchanged href, and a layout that yielded on href identity
 * left a layer nothing could dismiss (review B1).
 *
 * The rest is what the tabs newly deserve and what P4 promised of them: Home
 * keeps its place across a round trip (AC-1), its badge is what is waiting on
 * you and no other destination ever carries one (AC-2), a press and hold
 * reaches the same actions a pointer gets (AC-3), and an approval is answered
 * where it stands without going anywhere (AC-5).
 *
 * **Only a laid-out page can prove any of it.** jsdom reports every element as
 * 0×0, has no viewport and no scrolling, so a unit test can assert a panel is
 * put away but not that the destination is what a person is now looking at, and
 * it cannot tell "the panel stayed mounted" from "the panel came back where the
 * operator left it". The long-press gesture is a touch gesture besides, and
 * `mobile-touch.spec.ts` owns the sizing and both-theme halves of that surface.
 */
test.describe('Mobile tabs — 390×844 @smoke', { tag: SOLE_SIDEBAR_TAG }, () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  /** How long a press must last to be a long press, with room to spare. */
  const HOLD_MS = 800;

  /** Go to one of the destinations and wait for its panel to be usable. */
  async function goTo(page: Page, id: 'home' | 'you') {
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
  function panelScroller(page: Page, id: 'home' | 'you'): Locator {
    return page
      .getByTestId(`mobile-tab-panel-${id}`)
      .locator('[data-slot="page-container"]')
      .locator('xpath=..');
  }

  /** Where a scroller currently sits, in CSS pixels from the top. */
  const scrollTop = (scroller: Locator) => scroller.evaluate((el) => el.scrollTop);

  /**
   * A channel with something unread in it.
   *
   * Nobody is in the room, so posting triggers no turn and costs nothing — and
   * because the post goes through the API rather than through this browser, it
   * does not move the read cursor, so the room arrives unread.
   *
   * @param roomsApi - This test's seeder, which also puts the room away again.
   * @param slug - The channel's slug, unique to this run.
   */
  async function seedChannel(roomsApi: RoomsApi, slug: string): Promise<SeededRoom> {
    const room = await roomsApi.createChannel(slug);
    await roomsApi.postEntries(room.id, ['Where we left off.']);
    return room;
  }

  test('there is no drawer to open — no sheet, no hamburger', async ({ page, basePage }) => {
    await basePage.goto();
    await basePage.waitForAppReady();

    // The panel itself is not mounted, which is what makes "no sheet" structural
    // rather than styled: the Radix Sheet lives inside `<Sidebar>`.
    await expect(page.locator('[data-slot="sidebar"]')).toHaveCount(0);
    await expect(page.locator('[data-mobile="true"]')).toHaveCount(0);
    await basePage.ensureSidebarOpen();
    await expect(page.locator('[data-slot="sidebar-trigger"]')).toHaveCount(0);
    // …and the three destinations are on screen instead, permanently.
    await expect(page.locator('[data-mobile-tab]')).toHaveCount(3);
    await expect(page.getByTestId('mobile-tab-bar')).toBeVisible();
    // …and a cold load lands on the routed page, not on a layer over it: `/`
    // is the #team room, and a phone that opened covered could not reach it.
    await expect(page.getByTestId('mobile-tab-panels')).toBeHidden();
    await expect(page.locator('[data-mobile-tab][aria-current]')).toHaveCount(0);
  });

  test('tapping a channel in Home lands on the room, and the tabs stay', async ({
    page,
    basePage,
    roomsApi,
    roomsPage,
  }) => {
    const slug = `e2e-mobile-nav-${roomsApi.runId}`;
    await roomsApi.createChannel(slug);
    await basePage.goto();
    await basePage.waitForAppReady();

    await goTo(page, 'home');
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
    await expect(page.getByTestId('mobile-tab-panel-home')).toBeHidden();
    // Nothing was dismissed: the destinations are still there to go back with.
    await expect(page.getByTestId('mobile-tab-bar')).toBeVisible();
    await goTo(page, 'home');
    await expect(row).toBeVisible();
  });

  test('re-opening the room you are already in still gets out of the way', async ({
    page,
    basePage,
    roomsApi,
    roomsPage,
  }) => {
    // **The defect review B1 measured, in a browser.** Re-opening the room you
    // are in is the commonest tap there is — and TanStack reports it as an
    // unchanged href. A layout that yielded on
    // href identity left a layer with no way out: no press recovered it.
    const slug = `e2e-mobile-same-${roomsApi.runId}`;
    await roomsApi.createChannel(slug);
    await basePage.goto();
    await basePage.waitForAppReady();

    await goTo(page, 'home');
    const row = roomsPage.rowIn(roomsPage.channels, `#${slug}`);
    await expect(row).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await row.click();
    await expect(page).toHaveURL(/\/channels\?.*id=/, { timeout: SERVER_ROUND_TRIP_MS });
    const settled = page.url();

    // Open the very same room again from the very same row.
    await goTo(page, 'home');
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
    // TWO agents, because a group message is what this sheet makes now: one
    // agent opens that agent's session instead (`sidebar-simplification` D2),
    // which is the case below. The sheet behaviour under test is the same for
    // both, and this half keeps the name literally true — a conversation is
    // what starts at the end of it.
    const ana = await roomsApi.registerAgent(`E2E Ana ${roomsApi.runId}`, '🦊', '#e07b39');
    const kai = await roomsApi.registerAgent(`E2E Kai ${roomsApi.runId}`, '🦉', '#5b8def');
    await basePage.goto();
    await basePage.waitForAppReady();

    // New stays in the header, and on a phone the header is the top of Home —
    // there is no FAB (§9). Driven through the New menu itself.
    await goTo(page, 'home');
    await roomsPage.newMenu.choose('new-message');
    await roomsPage.agentSearch.waitFor({ state: 'visible' });

    // The picker is its own sheet. Opening it is not a destination, and neither
    // is choosing who to talk to — a half-assembled conversation survives.
    const chip = roomsPage.agentChip(ana.name);
    await roomsPage.chooseAgent(ana.name);
    await expect(chip).toBeVisible();
    // The pair `main` asserted about the sheet: nothing is dismissed mid-pick.
    // Asserted after the FIRST pick and again after the second, because the
    // interesting moment is the one where the button changes its words — a
    // sheet that survived one pick and closed on the next would pass a check
    // made only at the end.
    await expect(page.getByTestId('mobile-tab-panels')).toBeVisible();
    await expect(roomsPage.agentSearch).toBeVisible();
    await roomsPage.chooseAgent(kai.name);
    await expect(roomsPage.agentChip(kai.name)).toBeVisible();
    await expect(page.getByTestId('mobile-tab-panels')).toBeVisible();
    await expect(roomsPage.agentSearch).toBeVisible();

    // Starting the conversation is a destination, and lands on it.
    await expect(roomsPage.startConversationButton).toHaveText('Start group message');
    await roomsPage.startConversationButton.click();
    await expect(page).toHaveURL(/\/channels\?.*id=/, { timeout: SERVER_ROUND_TRIP_MS });
    roomsApi.track(openRoomId(page));
    // …and the other half of the pair: starting the conversation IS a
    // destination, so the layer gets out of its way.
    await expect(page.getByTestId('mobile-tab-panels')).toBeHidden();
    await expect(roomsPage.roomHeading).toHaveAccessibleName(`${ana.name} and ${kai.name}`, {
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await expect(page.getByTestId('mobile-tab-bar')).toBeVisible();
  });

  test('one agent in the New message sheet opens its Direct chat, and the agent joins Direct messages', async ({
    page,
    basePage,
    roomsApi,
    roomsPage,
  }) => {
    // The other door, on a phone (`sidebar-simplification` D2). It is the one
    // worth asserting here rather than assuming from the desktop case: the
    // session path closes the sheet and THEN resolves which conversation to
    // open, asynchronously, so "the layer gets out of the way" and "it arrived
    // somewhere" are two facts on this route where the room path has one.
    const ana = await roomsApi.registerAgent(`E2E Ana ${roomsApi.runId}`, '🦊', '#e07b39');
    await basePage.goto();
    await basePage.waitForAppReady();

    await goTo(page, 'home');
    await roomsPage.newMenu.choose('new-message');
    await roomsPage.agentSearch.waitFor({ state: 'visible' });

    await roomsPage.chooseAgent(ana.name);
    await expect(roomsPage.agentChip(ana.name)).toBeVisible();
    // The button says where it goes before it goes there.
    await expect(roomsPage.startConversationButton).toHaveText(`Open chat with ${ana.name}`);
    await expect(page.getByTestId('mobile-tab-panels')).toBeVisible();

    await roomsPage.startConversationButton.click();

    // The agent's Direct chat — the same place its row opens.
    await expect(page).toHaveURL(/\/session\?.*session=/, { timeout: SERVER_ROUND_TRIP_MS });
    const sessionUrl = new URL(page.url());
    expect(sessionUrl.searchParams.has('dir')).toBe(false);
    expect(sessionUrl.searchParams.has('agentPath')).toBe(false);
    const launchRef = sessionUrl.searchParams.get('launchRef');
    expect(launchRef).toBeTruthy();
    const location = await page.request.get(`/api/session-locations/${launchRef}`);
    expect(location.ok()).toBe(true);
    expect(await location.json()).toMatchObject({ cwd: ana.projectPath });
    expect(new URL(page.url()).searchParams.get('session')).toBeTruthy();
    await expect(page.getByTestId('mobile-tab-panels')).toBeHidden();
    await expect(page.getByTestId('mobile-tab-bar')).toBeVisible();
    // **An agent is its direct message.** Now that there is a Direct chat with
    // Ana, Ana is a row in Direct messages — the agent's own row, never a
    // second one for the room behind it.
    await goTo(page, 'home');
    const dms = roomsPage.directMessages;
    await expect(
      dms.locator('[data-slot="agent-list-item"]').filter({ hasText: ana.name })
    ).toHaveCount(1, { timeout: SERVER_ROUND_TRIP_MS });
    await expect(roomsPage.rowIn(dms, ana.name)).toHaveCount(0);
  });

  test('Home comes back where you left it after a look at You (AC-1)', async ({
    page,
    basePage,
    roomsApi,
    teamRoomApi,
  }) => {
    // **Seeded until Home genuinely overflows.** A panel that fits has no scroll
    // offset to lose, so "the offset survived" would be true of a build that
    // remounted the panel on every switch — the exact regression AC-1 is about,
    // and the precondition below fails loudly rather than letting the case pass
    // on a panel with nowhere to go. Channels lists every channel, and two
    // approval cards at the top of Home carry it over.
    for (let i = 0; i < 14; i += 1) {
      await seedChannel(roomsApi, `e2e-mobile-scroll-${i}-${roomsApi.runId}`);
    }
    await teamRoomApi.seedApproval();
    await teamRoomApi.seedApproval();
    await basePage.goto();
    await basePage.waitForAppReady();
    await goTo(page, 'home');

    const home = panelScroller(page, 'home');
    await expect(page.getByTestId('mobile-now-attention')).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await expect(
      page.locator('[data-sidebar-section="channels"] [data-sidebar-row]').first()
    ).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await expect
      .poll(() => home.evaluate((el) => el.scrollHeight - el.clientHeight), {
        message: 'Home never grew taller than the phone — seed more channels',
        timeout: SERVER_ROUND_TRIP_MS,
      })
      .toBeGreaterThan(150);

    await home.evaluate((el) => {
      el.scrollTop = 140;
    });
    const parked = await scrollTop(home);
    expect(parked, 'the panel refused the scroll').toBeGreaterThan(100);

    await goTo(page, 'you');
    await expect(page.getByTestId('mobile-tab-panel-home')).toBeHidden();
    await goTo(page, 'home');

    expect(await scrollTop(home), 'Home was remounted, so it started at the top').toBe(parked);
  });

  test('the Home badge is what is waiting on you, and no other tab carries one (AC-2)', async ({
    page,
    basePage,
    teamRoomApi,
  }) => {
    // A capability approval is the cheapest thing on this server that genuinely
    // needs a person. Two, so the badge has to print a number rather than
    // merely exist.
    await teamRoomApi.seedApproval();
    await teamRoomApi.seedApproval();
    await basePage.goto();
    await basePage.waitForAppReady();
    await goTo(page, 'home');

    const badge = page.getByTestId('mobile-tab-badge-home');
    await expect(badge).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    // **Checked against the server, not against the number this test seeded.**
    // The badge counts every approval and question waiting, so comparing it to
    // the queue is what makes this an assertion about the count, and a parked
    // question anywhere on this leg makes the two disagree loudly instead of
    // quietly passing.
    const waiting = (await teamRoomApi.pendingApprovalIds()).length;
    expect(waiting, 'nothing is waiting, so the badge has nothing to be').toBeGreaterThanOrEqual(2);
    await expect(badge).toHaveText(String(waiting));

    // The same number, said out loud once, from outside the panels — the region
    // the badge is `aria-hidden` in deference to.
    await expect(page.getByTestId('mobile-needs-you-live-region')).toHaveText(
      new RegExp(`^${waiting} agents? need you$`),
      { timeout: SERVER_ROUND_TRIP_MS }
    );

    // No other destination is badged while Home is at its loudest — which is
    // the only moment the claim means anything.
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

  test('a press and hold in Home offers what the “⋮” offers (AC-3)', async ({
    page,
    basePage,
    roomsApi,
    dashboardSidebar,
  }) => {
    // `mobile-touch.spec.ts` proves the gesture, its drift guard, its sizing and
    // both themes. This asks that a row in Home reaches the same actions a
    // pointer reaches.
    const slug = `e2e-mobile-home-menu-${roomsApi.runId}`;
    await seedChannel(roomsApi, slug);
    await basePage.goto();
    await basePage.waitForAppReady();
    await goTo(page, 'home');

    const row = page
      .locator('[data-sidebar-section="channels"] [data-sidebar-row]')
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
