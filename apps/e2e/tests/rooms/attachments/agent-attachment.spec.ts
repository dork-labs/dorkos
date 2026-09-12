import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '../../../fixtures';
import { SERVER_ROUND_TRIP_MS } from '../../../fixtures/rooms-api';

/**
 * An agent showing a room a file it made (spec `canvas-agent-seat` §4).
 *
 * The service half is covered in `agent-attachments.test.ts`, over a real
 * filesystem and the real capability registry — including the refusal that
 * matters most, a second agent's working copy. What only a browser can add is
 * that a person SEES it: the message the agent posted carries the file, and the
 * file downloads as the bytes the agent wrote rather than as a broken link.
 *
 * ## Why the file is made INSIDE the turn
 *
 * Because that is the feature. An agent may attach a file from its own working
 * directory and from nowhere else, so a driver writing the file from outside
 * would be staging a case the product refuses. The `rooms-post-attachment`
 * scenario therefore writes the file in the directory its own turn runs in, and
 * calls the real `rooms.post` capability with the real author of that turn.
 *
 * ## Why the TEST-MODE leg
 *
 * The same argument every spec in this project makes: it un-silences an agent,
 * and on the cockpit leg that means a real, billable claude-code turn on
 * whatever `claude` sign-in the machine has.
 */

/** The scenario that writes a file in its own directory and posts it. */
const POSTS_ATTACHMENT = 'rooms-post-attachment';

/** What that scenario says in the room. */
const POSTED_TEXT = 'Here is what I saw.';

/** The name it gives the file it made. */
const POSTED_FILE = 'shot.png';

/**
 * Put the runtime back to a known state, and refuse to run anywhere but the
 * test-mode leg.
 *
 * @param request - The test's API context, proxied to whichever leg it is on.
 */
async function requireTestModeLeg(request: APIRequestContext): Promise<void> {
  const res = await request.post('/api/test/reset');
  if (res.status() === 404) {
    throw new Error(
      'This spec is running against a leg with no TestModeRuntime. It un-silences a room ' +
        'agent, so on the cockpit leg its turn would be a real, billable claude-code turn. ' +
        'Run it in the `chromium-rooms-agents` project.'
    );
  }
  if (!res.ok()) throw new Error(`Could not reset the test-mode runtime: ${await res.text()}`);
}

/**
 * Install a scenario and prove it took — the store is server-global.
 *
 * @param request - The test's API context.
 * @param name - The scenario to install.
 */
async function useScenario(request: APIRequestContext, name: string): Promise<void> {
  const res = await request.post('/api/test/scenario', { data: { name } });
  if (!res.ok()) throw new Error(`Could not set the scenario to ${name}: ${await res.text()}`);
  const { scenario } = (await res.json()) as { scenario?: string };
  if (scenario !== name) {
    throw new Error(`Asked for '${name}' and the server acknowledged '${scenario}'.`);
  }
}

/**
 * Open one room by id and wait until it is really on screen.
 *
 * @param page - The test's page.
 * @param basePage - The shell page object, for app readiness.
 * @param roomsPage - The rooms page object, for the masthead.
 * @param roomId - The room to open.
 */
async function openRoom(
  page: Page,
  basePage: { waitForAppReady: () => Promise<void> },
  roomsPage: { roomHeader: { isVisible: () => Promise<boolean> } },
  roomId: string
): Promise<void> {
  await page.goto(`/channels?id=${roomId}`);
  await basePage.waitForAppReady();
  await expect
    .poll(() => roomsPage.roomHeader.isVisible(), { timeout: SERVER_ROUND_TRIP_MS })
    .toBe(true);
}

test.describe.configure({ mode: 'serial', timeout: 120_000 });

test.describe('An agent shows the room a file it made', () => {
  test.beforeEach(async ({ request }) => {
    await requireTestModeLeg(request);
  });

  test.afterEach(async ({ request }) => {
    await request.post('/api/test/finish-turn');
    await useScenario(request, 'simple-text').catch(() => {});
  });

  test('posts the file with its message, and the file downloads', async ({
    page,
    basePage,
    request,
    roomsApi,
    roomsPage,
  }) => {
    await useScenario(request, POSTS_ATTACHMENT);
    const tag = roomsApi.runId;
    const name = `Shower${tag}`;
    const agent = await roomsApi.registerAgent(name, '📸', '#0ea5e9');
    const room = await roomsApi.createChannel(`attach-${tag}`, `Attach ${tag}`, [agent]);
    const seat = room.members.find((member) => member.author.displayName === name);
    if (!seat) throw new Error(`${name} is not on the roster of ${room.id}`);
    await roomsApi.setResponseMode(room.id, seat.author.id, 'always');

    await openRoom(page, basePage, roomsPage, room.id);
    await roomsApi.postEntries(room.id, [`show me the page ${tag}`]);

    const settled = await roomsApi.waitForEntry(
      room.id,
      (entry) => entry.authorId === seat.author.id && entry.body.text.includes(POSTED_TEXT),
      `a post with an attachment from ${name}`
    );
    await request.post('/api/test/finish-turn');

    const posted = settled.find(
      (entry) => entry.authorId === seat.author.id && entry.body.text.includes(POSTED_TEXT)
    )!;
    // The file is ON the entry, in the same transaction that wrote it — not a
    // second message, and not a link in the text.
    expect(posted.attachments, 'the post carried no file').toHaveLength(1);
    const file = posted.attachments![0];
    expect(file.name).toBe(POSTED_FILE);
    // Sniffed from the bytes the agent wrote, which is what decides whether it
    // is ever drawn as a picture.
    expect(file.preview).toBe('image');

    // A person sees it on the message.
    await expect(page.getByTestId('room-timeline')).toContainText(POSTED_TEXT, {
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await expect(page.getByTestId('room-entry-attachments').last()).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });

    // And the bytes really come back — a chip pointing at nothing would render
    // identically.
    const fetched = await request.get(file.url);
    expect(fetched.ok(), `the attachment did not download: ${fetched.status()}`).toBe(true);
    const bytes = Buffer.from(await fetched.body());
    expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  });
});
