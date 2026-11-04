import { test as base, expect } from '../../fixtures';
import { BOOT_CACHE_DISABLED_KEY } from '../../boot-cache-flag';

/** Bigger than the wait a reload would show, so an answer it waits for fails the test. */
const LOOKUP_HELD_MS = 3_000;

/** Long enough for the boot cache's one-second write throttle to have fired. */
const BOOT_CACHE_SAVE_MS = 1_500;

const DESCRIPTION = 'Runs the release checks and writes up what changed for the team.';

/** A wordy agent's DM, opened the way a person opens it: its row in the sidebar. */
const test = base.extend<{ dmName: string }>({
  dmName: async ({ page, request, roomsApi, basePage, dashboardSidebar }, use) => {
    const name = `Tern ${roomsApi.runId}`;
    const agent = await roomsApi.registerAgent(name, '🐦', '#2563eb');
    const described = await request.patch(`/api/mesh/agents/${agent.id}`, {
      data: { description: DESCRIPTION },
    });
    expect(described.ok()).toBe(true);
    await roomsApi.createDirectMessage(name, [agent]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await basePage.waitForAppReady();
    await basePage.ensureSidebarOpen();
    await dashboardSidebar.agentRow(name).click();
    await expect(page.getByTestId('dm-header-identity')).toContainText(name);
    await use(name);
  },
});

test.describe('the bar over a DM (DOR-3074)', () => {
  test('leaves the description out on a phone, rather than cut to two letters', async ({
    page,
    dmName,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });

    const identity = page.getByTestId('dm-header-identity');
    await expect(identity).toContainText(dmName);
    await expect(identity.getByText(DESCRIPTION)).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath('dm-bar-390.png') });
  });

  test('keeps the description where there is room for it', async ({ page, dmName }, testInfo) => {
    const identity = page.getByTestId('dm-header-identity');
    await expect(identity).toContainText(dmName);
    await expect(identity.getByText(DESCRIPTION)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('dm-bar-1440.png') });
  });

  test.describe('on a reload', () => {
    test.beforeEach(async ({ context }) => {
      await context.addInitScript((key) => {
        window.localStorage.removeItem(key);
      }, BOOT_CACHE_DISABLED_KEY);
    });

    test('already knows it is a DM, with the lookup held', async ({ page, dmName }) => {
      // The cache writes on a throttle and when the page goes away.
      await page.waitForTimeout(BOOT_CACHE_SAVE_MS);
      await page.route('**/api/direct-chats/by-session/**', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, LOOKUP_HELD_MS));
        await route.continue();
      });
      await page.reload();

      await expect(page.getByTestId('dm-header-identity')).toContainText(dmName, {
        timeout: LOOKUP_HELD_MS - 500,
      });
    });
  });
});
