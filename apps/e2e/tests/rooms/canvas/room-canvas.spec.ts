import type { APIRequestContext } from '@playwright/test';
import { test, expect } from '../../../fixtures';
import { SERVER_ROUND_TRIP_MS, type SeededRoom } from '../../../fixtures/rooms-api';
import { RoomsPage } from '../../../pages/RoomsPage';
import { BasePage } from '../../../pages/BasePage';

/**
 * A room's shared canvas, in the browser (spec `room-canvas` §9, task 2.2).
 *
 * **This is the leg nothing below it can stand in for.** The unit suites cover
 * the slice's rules and the server's table; what only a browser can show is that
 * the table is genuinely SHARED — that two people looking at one room see the
 * same documents at the same moment, that a reload gets them back from the
 * server rather than from this browser's storage, and that closing one takes it
 * off both screens. That last trio is the whole feature, and the first of them
 * is the one that fails hardest on a private, `localStorage`-backed canvas.
 *
 * **Why the test-mode leg.** One test here un-silences an agent so a real room
 * turn puts a real document on a real table. On the cockpit leg that turn would
 * be a billable claude-code turn on whatever `claude` sign-in the machine has,
 * with no key to withhold that prevents it — the same argument
 * `room-autonomy.spec.ts` makes, and {@link requireTestModeLeg} makes it a check
 * rather than a hope. Everything else here is driven by a PERSON and costs
 * nothing at all.
 */

/** The scenario that puts one markdown document on the room's canvas. */
const OPENS_CANVAS = 'rooms-open-canvas';

/** What {@link OPENS_CANVAS} calls the document it opens. */
const AGENT_DOCUMENT = 'The plan';

/**
 * Put the runtime back to a known state, and refuse to run anywhere but the
 * test-mode leg.
 *
 * `/api/test/*` is mounted only under `DORKOS_TEST_RUNTIME`, so a 404 means this
 * spec is pointed at the cockpit leg — where the agent it is about to un-silence
 * would answer with a real model on the machine's own sign-in.
 *
 * @param request - The test's API context.
 */
async function requireTestModeLeg(request: APIRequestContext): Promise<void> {
  const res = await request.post('/api/test/reset');
  if (res.status() === 404) {
    throw new Error(
      'This spec is running against a leg with no TestModeRuntime. One test here un-silences ' +
        'a room agent, so on the cockpit leg it would start a real, billable claude-code turn. ' +
        'Run it in the `chromium-rooms-agents` project.'
    );
  }
  if (!res.ok()) throw new Error(`Could not reset the test-mode runtime: ${await res.text()}`);
}

/**
 * Install a scenario and prove it took.
 *
 * The read-back is the guard rather than politeness: the scenario store is
 * server-global, so a neighbour that resets it between this call and the turn
 * that needs it leaves the test driving a runtime it did not choose.
 *
 * @param request - The test's API context.
 * @param name - The scenario to install.
 */
async function useScenario(request: APIRequestContext, name: string): Promise<void> {
  const res = await request.post('/api/test/scenario', { data: { name } });
  if (!res.ok()) throw new Error(`Could not set the scenario to ${name}: ${await res.text()}`);
  const { scenario } = (await res.json()) as { scenario?: string };
  if (scenario !== name) {
    throw new Error(
      `Asked for the '${name}' scenario and the server acknowledged '${scenario}'. ` +
        `The scenario store is server-global — something else on this leg is writing it.`
    );
  }
}

/**
 * The author id of a room's one agent seat, with that seat set to answer.
 *
 * @param roomsApi - The seeding fixture, which owns the membership write.
 * @param room - The room whose roster to read.
 * @param name - The agent's display name.
 */
async function seatThatAnswers(
  roomsApi: { setResponseMode: (r: string, a: string, m: string) => Promise<void> },
  room: SeededRoom,
  name: string
): Promise<string> {
  const seat = room.members.find((member) => member.author.displayName === name);
  if (!seat) throw new Error(`${name} is not on ${room.id}'s roster`);
  await roomsApi.setResponseMode(room.id, seat.author.id, 'always');
  return seat.author.id;
}

/**
 * Put a document on a room's canvas AS THE PERSON, through the same route the
 * app's own doors use.
 *
 * Driven from the API rather than through the address bar for the tests that are
 * about what every viewer SEES: the typing is covered by its own test below, and
 * repeating it in each would add a second source of flake to prove one thing.
 *
 * @param request - The test's API context.
 * @param roomId - The room.
 * @param title - What to call it.
 * @returns The document's id, so a test can close it by name later.
 */
async function putOnCanvas(
  request: APIRequestContext,
  roomId: string,
  title: string
): Promise<string> {
  const res = await request.post(`/api/rooms/${roomId}/canvas`, {
    data: { content: { type: 'markdown', title, content: `# ${title}` } },
  });
  if (!res.ok()) throw new Error(`Could not put ${title} on the canvas: ${await res.text()}`);
  const { id } = (await res.json()) as { id: string };
  return id;
}

/**
 * Open a room and wait until it is really on screen.
 *
 * The barrier is the masthead, not the feed: a room seeded empty has no timeline
 * mounted at all, so waiting on the feed waits for something correctly absent.
 */
async function openRoom(
  page: import('@playwright/test').Page,
  basePage: BasePage,
  roomsPage: RoomsPage,
  roomId: string
): Promise<void> {
  await page.goto(`/channels?id=${roomId}`);
  await basePage.waitForAppReady();
  await expect(roomsPage.roomHeader).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
}

// Serial: the agent test writes the server-global scenario store, and a
// neighbour running beside it would answer with a runtime it did not choose.
test.describe.configure({ mode: 'serial', timeout: 120_000 });

test.describe('A room has a canvas everybody shares @smoke', () => {
  test.beforeEach(async ({ request }) => {
    await requireTestModeLeg(request);
  });

  test.afterEach(async ({ request }) => {
    await useScenario(request, 'simple-text').catch(() => {});
  });

  test('an agent puts a document on the room’s canvas, and the tab says who did', async ({
    page,
    basePage,
    roomsApi,
    roomsPage,
    request,
  }) => {
    const tag = roomsApi.runId;
    const name = `Planner${tag}`;
    const agent = await roomsApi.registerAgent(name, '🗺️', '#0891b2');
    const room = await roomsApi.createChannel(`canvas-${tag}`, `Canvas ${tag}`, [agent]);
    const seat = await seatThatAnswers(roomsApi, room, name);
    await useScenario(request, OPENS_CANVAS);

    await openRoom(page, basePage, roomsPage, room.id);
    // The panel is open on ROOM before anything arrives, which is what makes the
    // next two assertions mean something: the tab the reader is on is the tab
    // they stay on.
    await roomsPage.openRoomPanel();
    await expect(roomsPage.roomPanelTab).toHaveAttribute('aria-selected', 'true');

    await roomsApi.postEntries(room.id, [`plan it ${tag}`]);
    await roomsApi.waitForEntry(
      room.id,
      (entry) => entry.authorId === seat,
      `an answer from ${name}`
    );

    // **Nothing moved the reader's tab.** The panel stayed on Room while the
    // document arrived — the dot is how it says so, and asking for the Canvas
    // tab is what a person does next (§9.3).
    await expect(roomsPage.canvasTabUnreadDot).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await expect(roomsPage.roomPanelTab).toHaveAttribute('aria-selected', 'true');

    await roomsPage.openCanvasTab();
    await expect(roomsPage.canvasDocuments).toContainText(AGENT_DOCUMENT, {
      timeout: SERVER_ROUND_TRIP_MS,
    });
    // The face of whoever put it there, on the tab itself.
    await expect(
      roomsPage.canvasDocumentTab(AGENT_DOCUMENT).locator('[data-slot="identity-avatar"]')
    ).toBeVisible();
  });

  test('two people looking at one room see the same document, live', async ({
    page,
    basePage,
    roomsApi,
    roomsPage,
    request,
    browser,
  }) => {
    const tag = roomsApi.runId;
    const room = await roomsApi.createChannel(`canvas-live-${tag}`, `Live ${tag}`, []);

    await openRoom(page, basePage, roomsPage, room.id);
    await roomsPage.openCanvasTab();

    // A second window on the same room, opened BEFORE anything is put on the
    // table — so what it shows arrives over its own stream rather than being
    // fetched when it loaded.
    const second = await browser.newContext();
    const secondPage = await second.newPage();
    const secondBase = new BasePage(secondPage);
    const secondRooms = new RoomsPage(secondPage);
    await openRoom(secondPage, secondBase, secondRooms, room.id);
    await secondRooms.openCanvasTab();

    try {
      const title = `Shared ${tag}`;
      const documentId = await putOnCanvas(request, room.id, title);

      // Both, without either one reloading. This is the assertion a private,
      // per-browser canvas cannot pass.
      await expect(roomsPage.canvasDocuments).toContainText(title, {
        timeout: SERVER_ROUND_TRIP_MS,
      });
      await expect(secondRooms.canvasDocuments).toContainText(title, {
        timeout: SERVER_ROUND_TRIP_MS,
      });

      // A reload gets the table back from the server, which is the property
      // `localStorage` could never give: this window has never stored it.
      await page.reload();
      await basePage.waitForAppReady();
      await roomsPage.openCanvasTab();
      await expect(roomsPage.canvasDocuments).toContainText(title, {
        timeout: SERVER_ROUND_TRIP_MS,
      });

      // Closed in one window, gone in the other.
      const closed = await request.delete(`/api/rooms/${room.id}/canvas/${documentId}`);
      expect(closed.ok()).toBe(true);
      await expect(secondRooms.canvasDocuments).toHaveCount(0, {
        timeout: SERVER_ROUND_TRIP_MS,
      });
    } finally {
      await second.close();
    }
  });

  test('a person types an address and the page lands on the room’s table', async ({
    page,
    basePage,
    roomsApi,
    roomsPage,
    request,
  }) => {
    const tag = roomsApi.runId;
    const room = await roomsApi.createChannel(`canvas-page-${tag}`, `Page ${tag}`, []);

    await openRoom(page, basePage, roomsPage, room.id);
    await roomsPage.openBrowserTab();

    // The Browser tab starts empty, so the first page comes from its own
    // starting point — the same door the address bar is one step further along.
    await page.getByRole('button', { name: /Web Page/ }).click();
    await expect(roomsPage.browserDocuments).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    // At rest the bar is a BUTTON showing a tidied URL; it becomes a text box
    // only once somebody activates it, so an accidental focus can never navigate
    // (the same two-step `pages/canvas-dev-server.ts` drives).
    await page.getByRole('button', { name: /^Address:/ }).click();
    const address = page.getByRole('textbox', { name: 'Address' });
    await address.fill('https://example.com');
    await address.press('Enter');

    await expect(roomsPage.browserDocuments).toContainText('example.com', {
      timeout: SERVER_ROUND_TRIP_MS,
    });

    // And it is really ON THE ROOM, not in this browser: the server's own list
    // is what says so.
    const listed = await request.get(`/api/rooms/${room.id}/canvas`);
    const { documents } = (await listed.json()) as { documents: { content: { url?: string } }[] };
    expect(documents.some((d) => d.content.url === 'https://example.com')).toBe(true);
  });
});
