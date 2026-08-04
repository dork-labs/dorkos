import { test, expect, type APIRequestContext } from '@playwright/test';
import { BasePage } from '../../pages/BasePage.js';
import { RoomsPage } from '../../pages/RoomsPage.js';

/**
 * Browser proof of the chats-as-channels cockpit surfaces (spec §13's E2E
 * bullet): bridge an external chat into a channel, see the channel with its
 * origin marks and visibility badge, post into it from the cockpit, and watch
 * the post land in the shared log.
 *
 * **The platform is faked at the adapter boundary.** There is no grammY `Bot`
 * and no live Telegram — the whole inbound → room → outbound loop is proven
 * server-side by `chat-bridge/__tests__/integration.test.ts`. Here the bridge is
 * seeded through `POST /api/test/seed-bridge` (the same fake, one layer up), and
 * this spec drives only the half a browser can observe: the rendered channel and
 * a cockpit post. Because a visibility badge exists only on a bridged *channel*
 * (a DM has none, §8/A8.2) and origin marks need a real external-author entry,
 * neither is producible by the DM-only "Bridge to a channel" action without a
 * live bot — so the seed stands in for the group-bridge path (DOR-907) the
 * cockpit action does not yet cover.
 *
 * Runs in the `chromium-bridge` project (the test-mode server's Vite client),
 * because `/api/test/*` is only mounted under `DORKOS_TEST_RUNTIME`.
 */

// eslint-disable-next-line no-restricted-syntax -- E2E test config; no env.ts available
const MOCK_PORT = process.env.DORKOS_MOCK_PORT || '4243';
const API_URL = `http://localhost:${MOCK_PORT}`;

/** Seed a fresh test agent and bridge one channel to it; returns its room slug. */
async function seedBridgedChannel(
  request: APIRequestContext
): Promise<{ roomId: string; slug: string }> {
  const seededAgent = await request.post(`${API_URL}/api/test/seed-agent`);
  expect(seededAgent.ok()).toBe(true);
  const { agentDir } = (await seededAgent.json()) as { agentDir: string };

  const seededBridge = await request.post(`${API_URL}/api/test/seed-bridge`, {
    data: { agentPath: agentDir },
  });
  expect(seededBridge.ok(), `seed-bridge failed: ${await seededBridge.text()}`).toBe(true);
  const body = (await seededBridge.json()) as { roomId: string; slug: string };
  expect(body.roomId).toBeTruthy();
  expect(body.slug).toBeTruthy();
  return body;
}

test.describe('Bridged channel — the cockpit surfaces @smoke', () => {
  test('shows the visibility badge and an external origin mark, and accepts a cockpit post', async ({
    page,
    request,
  }) => {
    const { roomId, slug } = await seedBridgedChannel(request);
    const spokenName = `#${slug}`;
    const rooms = new RoomsPage(page);

    // Open the bridged channel straight by id, the way the sidebar row would.
    await page.goto(`/channels?id=${roomId}`);
    await new BasePage(page).waitForAppReady();
    await expect(rooms.roomHeader).toBeVisible();

    // §8: the header carries the platform-sourced visibility badge. Its very
    // presence marks this as a bridged channel — an unbridged room has none.
    await expect(rooms.visibilityBadge).toBeVisible();
    await expect(rooms.visibilityBadge).toHaveText(/sees mentions only/i);

    // The seeded message from outside the machine is in the log, and §4.3's
    // origin mark ("· Telegram") sits with it — the difference between a person
    // on this machine and a stranger writing in from a chat.
    await expect(rooms.entry('Hi from Telegram — can the team see this?')).toBeVisible();
    await expect(rooms.originMarks.first()).toBeVisible();
    await expect(rooms.originMarks.first()).toContainText(/telegram/i);

    // Post into the channel from the cockpit — the operator speaking into their
    // own bridged chat (spec §3.4). The post lands in the shared log, which is
    // the delivery state a browser can see (the send to a live platform is
    // proven server-side; there is no bot here).
    await rooms.post(spokenName, 'Ack from the cockpit.');
    await expect(rooms.entry('Ack from the cockpit.')).toBeVisible();
  });
});
