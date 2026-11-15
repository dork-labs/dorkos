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

    // Pressing it opens the Direct chat. The row IS the button (`data-slot`
    // sits on the `<button>` itself), so it is pressed directly — a role query
    // scoped inside it looks only at its descendants and finds nothing.
    await expect(row).toHaveAccessibleName(new RegExp(`Switch to ${agent.name}`));
    await row.click();
    await expect(page).toHaveURL(/\/session\?.*session=/, { timeout: SERVER_ROUND_TRIP_MS });
  });
});
