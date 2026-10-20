import type { Route } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { SOLE_SIDEBAR_TAG } from '../../fixtures/sole-access';
import { SERVER_ROUND_TRIP_MS } from '../../fixtures/rooms-api';

// One cockpit at a time, with the ceiling this repo's other sidebar specs use.
// Nothing here starts an agent turn: opening a Direct chat makes a room, not a
// turn.
test.describe.configure({ mode: 'default', timeout: 120_000 });

/**
 * The sidebar lists places, never sessions or threads (DOR-3092).
 *
 * Top to bottom: the workspace and New, "Find a conversation…", the doors to
 * Threads and the Directory, your sections, Channels, Direct messages, and the
 * way to message anybody. An agent is a row once — as its direct message — and
 * every other agent is in the Directory. What only a browser can answer: that
 * the doors go where they say, and that opening an agent's Direct chat is what
 * puts the agent in Direct messages.
 */
test.describe('Dashboard Sidebar — the list @smoke', { tag: SOLE_SIDEBAR_TAG }, () => {
  test('reads top items, Channels, Direct messages, and nothing about sessions', async ({
    page,
    basePage,
    dashboardSidebar,
  }) => {
    await basePage.goto();
    await basePage.waitForAppReady();
    await basePage.ensureSidebarOpen();

    await expect(page.getByTestId('sidebar-search-pill')).toContainText('Find a conversation…');
    await expect(dashboardSidebar.topItem('Threads')).toBeVisible();
    await expect(dashboardSidebar.topItem('Directory')).toBeVisible();
    await expect(dashboardSidebar.section('channels')).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await expect(dashboardSidebar.section('dms')).toBeVisible();

    // Gone, every one of them.
    const content = page.locator('[data-slot="sidebar-content"]');
    for (const heading of ['Heads up', 'Today', 'Library', 'Agents', 'Pins', 'Getting started']) {
      await expect(content.getByRole('heading', { name: heading, exact: true })).toHaveCount(0);
    }
    await expect(page.locator('[data-sidebar-zone]')).toHaveCount(0);
  });

  test('the doors go where they say, and light while you are there', async ({
    page,
    basePage,
    dashboardSidebar,
  }) => {
    await basePage.goto();
    await basePage.waitForAppReady();
    await basePage.ensureSidebarOpen();

    await dashboardSidebar.topItem('Directory').click();
    await expect(page).toHaveURL(/\/team/);
    await expect(dashboardSidebar.topItem('Directory')).toHaveAttribute('aria-current', 'page');

    await dashboardSidebar.topItem('Threads').click();
    await expect(page).toHaveURL(/\/threads$/);
    await expect(dashboardSidebar.topItem('Threads')).toHaveAttribute('aria-current', 'page');
    await expect(dashboardSidebar.topItem('Directory')).not.toHaveAttribute('aria-current');

    const messageAnyone = dashboardSidebar
      .section('dms')
      .getByRole('button', { name: /^Message an agent/ });
    await messageAnyone.click();
    await expect(page).toHaveURL(/\/team/);
  });

  test('an agent joins Direct messages once you have a Direct chat with it', async ({
    page,
    request,
    basePage,
    roomsApi,
    dashboardSidebar,
  }) => {
    const agent = await roomsApi.registerAgent(`E2E Shape ${roomsApi.runId}`, '🪴', '#16a34a');
    await basePage.goto();
    await basePage.waitForAppReady();
    await basePage.ensureSidebarOpen();

    const dms = dashboardSidebar.section('dms');
    const row = dms.locator('[data-slot="agent-list-item"]').filter({ hasText: agent.name });
    // A new agent is in the Directory, not on the panel.
    await expect(dashboardSidebar.section('channels')).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await expect(row).toHaveCount(0);

    const res = await request.post('/api/direct-chats', { data: { agentPath: agent.projectPath } });
    expect(res.ok(), `opening the Direct chat answered ${res.status()}`).toBe(true);
    const { roomId } = (await res.json()) as { roomId: string };
    roomsApi.track(roomId);

    // The agent's own row, and no second one for the room behind it.
    await expect(row).toHaveCount(1, { timeout: SERVER_ROUND_TRIP_MS });
    await expect(
      dms.locator(`[data-slot="room-title"]`).filter({ hasText: agent.name })
    ).toHaveCount(0);

    // Pressing it opens the Direct chat.
    await row.getByRole('button', { name: new RegExp(`Switch to ${agent.name}`) }).click();
    await expect(page).toHaveURL(/\/session\?.*session=/, { timeout: SERVER_ROUND_TRIP_MS });
  });

  test('with no direct message yet, the section offers to message an agent', async ({
    page,
    basePage,
    dashboardSidebar,
  }) => {
    // The shared server may hold another spec's direct messages, so the room
    // list this page reads is narrowed to its channels.
    await page.route(
      (url) => url.pathname === '/api/rooms',
      async (route: Route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const response = await route.fetch();
        const body = (await response.json()) as { rooms: { kind: string }[]; warnings: unknown[] };
        await route.fulfill({
          response,
          json: { ...body, rooms: body.rooms.filter((room) => room.kind !== 'dm') },
        });
      }
    );
    await page.route(
      (url) => url.pathname === '/api/config',
      async (route: Route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const response = await route.fetch();
        const body = (await response.json()) as { ui: { sidebar: { pinned: unknown[] } } };
        body.ui.sidebar.pinned = [];
        await route.fulfill({ response, json: body });
      }
    );
    await basePage.goto();
    await basePage.waitForAppReady();
    await basePage.ensureSidebarOpen();

    const offer = dashboardSidebar
      .section('dms')
      .getByRole('button', { name: 'Message an agent', exact: true });
    await expect(offer).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await offer.click();
    await expect(page).toHaveURL(/\/team\?.*kind=agents/);
  });
});
