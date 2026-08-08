import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { SERVER_ROUND_TRIP_MS } from '../../fixtures/rooms-api';
import { PHONE } from '../rooms/room-sheet-helpers';

// One cockpit at a time, with the ceiling this repo's other room specs use:
// these seed rooms against a shared server on a machine that is routinely
// running several worktrees of agents. Nothing here starts an agent turn.
test.describe.configure({ mode: 'default', timeout: 90_000 });

/**
 * The sidebar gets out of the way once you pick a destination (DOR-610).
 *
 * Only a laid-out page can prove this. jsdom reports every element as 0×0 and
 * has no viewport, so a unit test can assert the sheet unmounted but not that
 * the destination is the thing a person is now looking at — which is the entire
 * complaint: the sidebar stayed on top of wherever you went.
 *
 * The seam under test is a single router subscription
 * (`SidebarMobileNavigationClose`, mounted beside the provider in AppShell),
 * so one row here stands in for every link in the sidebar. These specs are
 * also the only coverage of the real AppShell mount: the unit tests mount the
 * component standalone. What earns a second
 * assertion is the nested picker: on a phone "New message" is a full-height
 * sheet drawn INSIDE the sidebar's sheet, and the failure mode a route-change
 * seam has to be checked against is dismissing it half-way through picking.
 */
test.describe('Mobile sidebar — 390×844 @smoke', () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  /** Open the sidebar sheet and wait for it to be usable. */
  async function openSidebar(page: Page): Promise<Locator> {
    await page.getByRole('button', { name: 'Toggle Sidebar' }).click();
    const sheet = page.locator('[data-mobile="true"]');
    await expect(sheet).toBeVisible();
    return sheet;
  }

  /** The room id in the address bar, which is what "the room on screen" means. */
  function openRoomId(page: Page): string {
    const id = new URL(page.url()).searchParams.get('id');
    if (id === null) throw new Error(`No room is open: ${page.url()}`);
    return id;
  }

  test('tapping a channel closes the sidebar and lands on the room', async ({
    page,
    basePage,
    roomsApi,
    roomsPage,
  }) => {
    const slug = `e2e-mobile-nav-${roomsApi.runId}`;
    await roomsApi.createChannel(slug);
    await basePage.goto();
    await basePage.waitForAppReady();

    const sheet = await openSidebar(page);
    const row = roomsPage.rowIn(roomsPage.channels, `#${slug}`);
    await expect(row).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await row.click();

    // Gone, and the room is what is on screen instead.
    await expect(sheet).toBeHidden({ timeout: SERVER_ROUND_TRIP_MS });
    await expect(page).toHaveURL(/\/channels\?.*id=/, { timeout: SERVER_ROUND_TRIP_MS });
    await expect(roomsPage.roomHeading).toHaveAccessibleName(`#${slug}`, {
      timeout: SERVER_ROUND_TRIP_MS,
    });
  });

  test('a top-level nav link closes it too', async ({ page, basePage }) => {
    await basePage.goto();
    await basePage.waitForAppReady();

    const sheet = await openSidebar(page);
    // By test id, not by name: a promo card in the same sheet is named "Use
    // DorkOS on the go Access", which the accessible-name match also picks up.
    // The id still reads "agents" though the nav now says Team — it is a tour
    // anchor, and renaming it would strand every tour already in progress
    // (DOR-973, `tour-anchors.ts`).
    await sheet.getByTestId('nav-agents').click();

    await expect(sheet).toBeHidden({ timeout: SERVER_ROUND_TRIP_MS });
    // `/team`, not `/agents`: DOR-973 made the Team page the destination and
    // left `/agents` as a redirecting alias for addresses this repo does not
    // own. The nav link points at the real route, so this asserts where a tap
    // actually lands — matching `tests/team/team-page.spec.ts`.
    await expect(page).toHaveURL(/\/team/, { timeout: SERVER_ROUND_TRIP_MS });
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

    const sheet = await openSidebar(page);
    await roomsPage.openDirectMessagePicker();

    // The picker is its own sheet, drawn over the sidebar's. Opening it is not
    // a destination, and neither is choosing who to talk to.
    const chip = roomsPage.agentChip(ana.name);
    await roomsPage.chooseAgent(ana.name);
    await expect(chip).toBeVisible();
    await expect(sheet).toBeVisible();

    // Starting the conversation is.
    await roomsPage.startConversationButton.click();
    await expect(page).toHaveURL(/\/channels\?.*id=/, { timeout: SERVER_ROUND_TRIP_MS });
    roomsApi.track(openRoomId(page));
    await expect(sheet).toBeHidden({ timeout: SERVER_ROUND_TRIP_MS });
    await expect(roomsPage.roomHeading).toHaveAccessibleName(ana.name, {
      timeout: SERVER_ROUND_TRIP_MS,
    });
  });
});
