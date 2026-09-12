import { test, expect } from '../../../fixtures';
import { SERVER_ROUND_TRIP_MS } from '../../../fixtures/rooms-api';
import { RoomsPage } from '../../../pages/RoomsPage';
import { BasePage } from '../../../pages/BasePage';
import { publishFollowClaim, publishFollowView, tapRoomStream } from '../room-signals';

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
  test('says nothing at all until somebody is following, then says where you are', async ({
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
    const positions: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/follow/view')) {
        positions.push(req.postData() ?? '');
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

    // The room says somebody is following this person. Now, and only now, a
    // position goes out — inside the debounce window, not a second later.
    await publishFollowClaim(page, { followerId: 'author-someone-else', leaderId: me });
    await expect.poll(() => positions.length, { timeout: 2_000 }).toBeGreaterThan(0);
    expect(positions[0]).toContain('documentId');

    // …and it stops again when the last follower lets go.
    await publishFollowClaim(page, { followerId: 'author-someone-else', leaderId: null });
    await page.waitForTimeout(600);
    const settled = positions.length;
    await roomsPage.canvasDocumentTab(`Preview ${tag}`).click();
    await page.waitForTimeout(1_000);
    expect(positions).toHaveLength(settled);
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
