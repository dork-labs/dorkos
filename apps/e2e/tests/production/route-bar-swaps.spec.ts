import { test, expect } from '../../fixtures';

/**
 * Leaving a page swaps the bar at the top, on the app as it ships.
 *
 * On a production build the bar a page loaded with stayed up after a click to a
 * chat, until a reload: the address and the page below had moved, and the bar
 * still offered Home's tabs (or the channel's title). A dev server never showed
 * it, so this runs on the one leg that serves the built client.
 *
 * Each case loads its page directly, because that is what made the difference:
 * reached by a click, the bar swapped.
 */
const STARTS = ['/', '/activity', '/channels'];

for (const start of STARTS) {
  test(`a chat opened from a direct load of ${start} gets its own bar`, async ({
    page,
    roomsApi,
    basePage,
    dashboardSidebar,
  }) => {
    const agentName = `Bar swap ${Date.now()}`;
    const agent = await roomsApi.registerAgent(agentName, '🔭', '#6366f1');
    await roomsApi.createDirectMessage(agentName, [agent]);

    await page.goto(start);
    await basePage.waitForAppReady();
    await basePage.ensureSidebarOpen();
    const row = dashboardSidebar.agentRow(agentName);
    await expect(row).toBeVisible();
    await row.click();

    await expect.poll(() => new URL(page.url()).pathname).toBe('/session');
    // A DM's bar or a session's, whichever this install draws: the point is that
    // it is the chat's bar, not the page's that was left.
    await expect(
      page.locator(
        '[data-testid="dm-header-identity"], [data-testid="session-agent-name"], [data-testid="session-bar-pending"]'
      )
    ).toBeVisible();
    await expect(page.locator('[data-slot="bar-tab-strip"]')).toHaveCount(0);
  });
}
