import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { SERVER_ROUND_TRIP_MS } from '../../fixtures/rooms-api';
import { PHONE } from '../rooms/room-sheet-helpers';

// One cockpit at a time, with the ceiling this repo's other room specs use:
// these seed rooms against a shared server on a machine that is routinely
// running several worktrees of agents. Nothing here starts an agent turn.
test.describe.configure({ mode: 'default', timeout: 90_000 });

/**
 * The phone cockpit is four destinations along the bottom (P4).
 *
 * **This file used to be about the drawer.** On a phone the sidebar was a sheet
 * drawn over the whole screen, so every row in it led somewhere the sheet was
 * covering, and one router subscription closed it on every commit (DOR-610).
 * P4.1 retired the drawer: `<Sidebar>` is not mounted below 768px, so there is
 * no sheet and no hamburger, and the destinations are always on screen. The
 * cases below are the same three behaviours re-asked of the thing that replaced
 * it, rather than deleted to go green.
 *
 * **Scope note.** P4.1 changed the mechanics these three tests drive, and this
 * rewrite covers exactly that. The coverage the tabs newly deserve — the Home
 * badge equalling the needs-you count, scroll surviving a round trip,
 * long-press menus, Catch up, and approve-from-anywhere — belongs to P4.2 and
 * P4.3, which own the full spec.
 *
 * Only a laid-out page can prove any of it: jsdom reports every element as 0×0
 * and has no viewport, so a unit test can assert a panel is put away but not
 * that the destination is what a person is now looking at.
 */
test.describe('Mobile tabs — 390×844 @smoke', () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

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
});
