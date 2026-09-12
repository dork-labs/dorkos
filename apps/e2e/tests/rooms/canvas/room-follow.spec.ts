import { test, expect } from '../../../fixtures';
import { SERVER_ROUND_TRIP_MS } from '../../../fixtures/rooms-api';
import { RoomsPage } from '../../../pages/RoomsPage';
import { BasePage } from '../../../pages/BasePage';
import { publishFollowClaim, publishFollowView, tapRoomStream } from '../room-signals';

/**
 * The smallest gap there may be between two positions leaving one window.
 *
 * The client's own `ROOM_FOLLOW_PUBLISH_MS`, restated because this file may not
 * import client code. A floor, not the coalescing property itself: proving that
 * a burst of moves collapses into ONE send needs a clock, and that assertion
 * lives in `use-room-view-publish.test.tsx`.
 */
const FOLLOW_DEBOUNCE_MS = 250;

/**
 * How often a followed window re-states an unchanged position.
 *
 * Waiting longer than this is what turns "it stopped" into a claim about the
 * beat as well as about the change path.
 */
const FOLLOW_BEAT_MS = 10_000;

/**
 * Following somebody's browser, in the browser (spec `canvas-agent-seat` §6).
 *
 * **Two properties only a browser can show**, and both are about traffic that
 * either leaves this window or does not:
 *
 * - **Nothing goes out while nobody is following.** Asserted on the real
 *   network: the person moves around the room's table and not one request to
 *   say where they are looking is made.
 * - **A claim naming this viewer is what starts it**, and a position arriving
 *   for the person they follow really moves this window's panel.
 *
 * **The one thing this leg fabricates, and why.** A DorkOS install is
 * single-identity: every window on this machine is the same person, and the
 * server refuses a claim on yourself. So the second PERSON is faked in exactly
 * two places — the roster this window reads, and the claim route it calls — and
 * nowhere else. Everything downstream is the shipped code: the real room socket,
 * the real frame decoder and schema, the real store, the real panel. The server
 * half — two real people, the people-only refusals, the claim TTL, the
 * publish-only-while-followed gate — is pinned against a real database in
 * `apps/server/src/services/rooms/follow/__tests__/room-follow.test.ts`, which
 * is where two identities exist.
 *
 * **Why this lives under `tests/rooms/canvas/`**: that directory is already
 * routed to the test-mode leg, and nothing here should ever be able to start a
 * billable turn.
 */

/** The author id this window acts as, read from the room the server handed it. */
async function viewerAuthorId(
  request: import('@playwright/test').APIRequestContext,
  roomId: string
): Promise<string> {
  const res = await request.get(`/api/rooms/${roomId}`);
  if (!res.ok()) throw new Error(`Could not read ${roomId}: ${await res.text()}`);
  const { viewerAuthorId: id } = (await res.json()) as { viewerAuthorId: string };
  return id;
}

/** Put a page on a room's canvas as the person. */
async function putPageOnCanvas(
  request: import('@playwright/test').APIRequestContext,
  roomId: string,
  title: string,
  url: string
): Promise<string> {
  const res = await request.post(`/api/rooms/${roomId}/canvas`, {
    data: { content: { type: 'browser', url, title } },
  });
  if (!res.ok()) throw new Error(`Could not put ${title} on the canvas: ${await res.text()}`);
  const { id } = (await res.json()) as { id: string };
  return id;
}

/** Open a room and wait until its masthead is really on screen. */
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

test.describe.configure({ mode: 'serial', timeout: 120_000 });

test.describe('Following somebody’s browser in a room', () => {
  test('says nothing until followed, one thing when it is, and stops when told to', async ({
    page,
    basePage,
    roomsApi,
    roomsPage,
    request,
  }, testInfo) => {
    const tag = roomsApi.runId;
    const room = await roomsApi.createChannel(`watching-${tag}`, `Watching ${tag}`, []);
    const me = await viewerAuthorId(request, room.id);
    await putPageOnCanvas(request, room.id, `Preview ${tag}`, 'http://localhost:5173/');
    await putPageOnCanvas(request, room.id, `Docs ${tag}`, 'http://localhost:5173/docs');

    // Every request this window makes to say where it is looking.
    const positions: Array<{ at: number; body: string }> = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/follow/view')) {
        positions.push({ at: Date.now(), body: req.postData() ?? '' });
      }
    });

    await tapRoomStream(page);
    await openRoom(page, basePage, roomsPage, room.id);
    await roomsPage.openBrowserTab();
    await expect(roomsPage.browserDocuments).toContainText(`Preview ${tag}`, {
      timeout: SERVER_ROUND_TRIP_MS,
    });

    // Move around the table while nobody is following. Not one request.
    await roomsPage.canvasDocumentTab(`Docs ${tag}`).click();
    await page.waitForTimeout(1_000);
    expect(positions).toEqual([]);
    await testInfo.attach('nobody-is-following-yet', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });

    // The room says somebody is following this person. Now, and only now, one
    // position goes out, carrying the document.
    const claimedAt = Date.now();
    await publishFollowClaim(page, { followerId: 'author-someone-else', leaderId: me });
    await expect.poll(() => positions.length, { timeout: 2_000 }).toBe(1);
    expect(positions[0]!.body).toContain('documentId');
    expect(claimedAt).toBeLessThanOrEqual(positions[0]!.at);

    // **And the SERVER stops it, which is the half only this leg can show.**
    // The claim above is a frame this test put on the socket; the server holds
    // no such claim, so its answer to that position is `{followed:false}` — the
    // documented stop signal. The window goes quiet on it rather than carrying
    // on for the thirty seconds the claim would otherwise have lived, and the
    // wait below is longer than a whole republish beat, so a leader that kept
    // beating would be caught here.
    for (const title of [`Docs ${tag}`, `Preview ${tag}`, `Docs ${tag}`]) {
      await roomsPage.canvasDocumentTab(title).click();
    }
    await page.waitForTimeout(FOLLOW_BEAT_MS + 1_000);
    expect(positions).toHaveLength(1);

    // The gaps that DID happen respect the debounce. One send cannot show a
    // window, so this is a floor rather than the property: the coalescing
    // itself is asserted with a clock, in `use-room-view-publish.test.tsx`.
    const gaps = positions.slice(1).map((sent, i) => sent.at - positions[i]!.at);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(FOLLOW_DEBOUNCE_MS);
  });

  test('moves this window onto the document the person you follow is on', async ({
    page,
    basePage,
    roomsApi,
    roomsPage,
    request,
  }, testInfo) => {
    const tag = roomsApi.runId;
    const room = await roomsApi.createChannel(`watching-move-${tag}`, `Move ${tag}`, []);
    const me = await viewerAuthorId(request, room.id);
    const first = await putPageOnCanvas(
      request,
      room.id,
      `Preview ${tag}`,
      'http://localhost:5173/'
    );
    const second = await putPageOnCanvas(
      request,
      room.id,
      `Docs ${tag}`,
      'http://localhost:5173/docs'
    );

    // The two fabrications, and the only two: a second person on the roster
    // this window reads, and the claim route answering for them. See the header.
    const OTHER = 'author-kai-e2e';
    await page.route(`**/api/rooms/${room.id}`, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as {
        members: Array<Record<string, unknown>>;
      };
      body.members = [
        ...body.members,
        { author: { id: OTHER, kind: 'human', displayName: 'Kai', handle: 'kai' } },
      ];
      await route.fulfill({ response, json: body });
    });
    await page.route(`**/api/rooms/${room.id}/follow`, (route) =>
      route.fulfill({ status: 204, body: '' })
    );

    await tapRoomStream(page);
    await openRoom(page, basePage, roomsPage, room.id);
    await roomsPage.openBrowserTab();
    await expect(roomsPage.browserDocuments).toContainText(`Docs ${tag}`, {
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await roomsPage.canvasDocumentTab(`Preview ${tag}`).click();
    await expect(roomsPage.canvasDocumentTab(`Preview ${tag}`)).toHaveAttribute(
      'aria-selected',
      'true'
    );

    // Follow Kai. The control lists people; there are no agents in this room, so
    // the only name in it is the one the roster gained.
    await roomsPage.roomPanel.getByRole('button', { name: 'Follow', exact: true }).click();
    await page.getByText('Kai', { exact: true }).click();
    await expect(
      roomsPage.roomPanel.getByRole('button', { name: 'Following Kai', exact: true })
    ).toBeVisible();
    await testInfo.attach('following-kai', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });

    // Kai moves. This window follows, within the debounce window.
    await publishFollowView(page, { authorId: OTHER, view: { documentId: second } });
    await expect(roomsPage.canvasDocumentTab(`Docs ${tag}`)).toHaveAttribute(
      'aria-selected',
      'true',
      { timeout: 2_000 }
    );
    await testInfo.attach('followed-kai-to-the-docs-page', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });

    // …and back again, so the move is following rather than a one-way jump.
    await publishFollowView(page, { authorId: OTHER, view: { documentId: first } });
    await expect(roomsPage.canvasDocumentTab(`Preview ${tag}`)).toHaveAttribute(
      'aria-selected',
      'true',
      { timeout: 2_000 }
    );
  });

  test('puts the Follow control within reach on a phone', async ({
    page,
    basePage,
    roomsApi,
    roomsPage,
    request,
  }, testInfo) => {
    // The control opens a responsive menu, which is a dropdown on a desktop and
    // a sheet below `md`. Two different components behind one button, so the
    // phone is its own case rather than an assumption.
    await page.setViewportSize({ width: 390, height: 844 });
    const tag = roomsApi.runId;
    const room = await roomsApi.createChannel(`watching-phone-${tag}`, `Phone ${tag}`, []);
    await putPageOnCanvas(request, room.id, `Preview ${tag}`, 'http://localhost:5173/');

    const OTHER = 'author-kai-phone';
    await page.route(`**/api/rooms/${room.id}`, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { members: Array<Record<string, unknown>> };
      body.members = [
        ...body.members,
        { author: { id: OTHER, kind: 'human', displayName: 'Kai', handle: 'kai' } },
      ];
      await route.fulfill({ response, json: body });
    });

    await openRoom(page, basePage, roomsPage, room.id);
    await roomsPage.openBrowserTab();
    await expect(roomsPage.browserDocuments).toContainText(`Preview ${tag}`, {
      timeout: SERVER_ROUND_TRIP_MS,
    });

    const control = roomsPage.roomPanel.getByRole('button', { name: 'Follow', exact: true });
    await expect(control).toBeVisible();
    await control.click();
    await expect(page.getByText('Kai', { exact: true })).toBeVisible();
    await testInfo.attach('follow-on-a-phone', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  });

  test('offers nobody to follow in a room with nobody else in it', async ({
    page,
    basePage,
    roomsApi,
    roomsPage,
    request,
  }) => {
    const tag = roomsApi.runId;
    const name = `Planner${tag}`;
    const agent = await roomsApi.registerAgent(name, '🗺️', '#0891b2');
    const room = await roomsApi.createChannel(`watching-alone-${tag}`, `Alone ${tag}`, [agent]);
    await putPageOnCanvas(request, room.id, `Preview ${tag}`, 'http://localhost:5173/');

    await openRoom(page, basePage, roomsPage, room.id);
    await roomsPage.openBrowserTab();
    await expect(roomsPage.browserDocuments).toContainText(`Preview ${tag}`, {
      timeout: SERVER_ROUND_TRIP_MS,
    });

    // An agent is in the room, and an agent is not somebody you can follow.
    await expect(
      roomsPage.roomPanel.getByRole('button', { name: 'Follow', exact: true })
    ).toHaveCount(0);
  });
});
