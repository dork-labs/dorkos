import { test, expect, type Page, type Route } from '@playwright/test';
import { BETA, ROOM, mockCommunities, room } from './community-mocks.js';

/**
 * Browser proofs for a Community channel's own view (DOR-2268, DOR-2229).
 *
 * All of them are geometry questions jsdom cannot answer: whether one press of
 * "Scroll to bottom" reaches a burst of rows the list has never measured,
 * whether a person's own post comes into view the moment it is accepted, and
 * what the reply line under a thread root looks like at desktop and phone
 * widths. The Community is mocked at the local server's API, the same way
 * `community-mocks.ts` does it; this file replaces the history, the posting
 * route and the live stream of its one room.
 */

const REF = BETA.ref;
const AT = Date.parse('2026-09-23T12:00:00.000Z');

type Entry = ReturnType<typeof entry>;

/** One confirmed channel message. */
function entry(seq: number, text: string, extra: Record<string, unknown> = {}) {
  return {
    community: REF,
    roomId: ROOM,
    id: `entry-${seq}`,
    authorId: `person-${REF}`,
    authorDisplayName: 'Alex',
    authorKind: 'human',
    text,
    mentions: [],
    parentEntryId: null,
    threadRootEntryId: null,
    depth: 0,
    cursor: `cursor-${REF}-${seq}`,
    createdAt: new Date(AT + seq * 60_000).toISOString(),
    remoteSeq: seq,
    attachments: [],
    ...extra,
  };
}

/** A three-paragraph message, so every unmeasured row is well over the list's 80px estimate. */
function tall(label: string) {
  return `${label}\n\nA second paragraph that wraps onto its own line.\n\nAnd a third one.`;
}

/** One SSE frame, as the local server writes it. */
function frame(type: string, data: unknown) {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Write text into the newest open stream, from the test's side, once the app has opened one. */
async function push(page: Page, text: string) {
  await page.waitForFunction(() => (window as unknown as { __streams: number }).__streams > 0);
  await page.evaluate(
    (value) => (window as unknown as { __push: (text: string) => void }).__push(value),
    text
  );
}

/**
 * Replace the room's live stream with one the test writes to.
 *
 * `page.route` can only answer a request whole, which ends the stream and
 * leaves the channel read-only while it reconnects. A person posting needs the
 * channel live, so the stream is answered inside the page instead: an open
 * body the test pushes frames into, which stays open until the app closes it.
 */
async function controllableStream(page: Page) {
  await page.addInitScript(
    ({ path }) => {
      const encoder = new TextEncoder();
      const open: ReadableStreamDefaultController<Uint8Array>[] = [];
      const exposed = window as unknown as {
        __push: (text: string) => void;
        __streams: number;
        __opened: number;
      };
      exposed.__streams = 0;
      exposed.__opened = 0;
      exposed.__push = (text) => open.at(-1)?.enqueue(encoder.encode(text));
      const original = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!new URL(url, location.href).pathname.endsWith(path)) return original(input, init);
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
        open.push(controller);
        exposed.__streams = open.length;
        exposed.__opened += 1;
        init?.signal?.addEventListener('abort', () => {
          open.splice(open.indexOf(controller), 1);
          exposed.__streams = open.length;
          try {
            controller.error(new DOMException('Aborted', 'AbortError'));
          } catch {
            // Already closed by the reader.
          }
        });
        return Promise.resolve(
          new Response(body, { headers: { 'content-type': 'text/event-stream' } })
        );
      };
    },
    { path: `/api/communities/${REF}/rooms/${ROOM}/events` }
  );
  return {
    /** Open the stream: the room and everything it holds now. */
    snapshot: (entries: Entry[]) =>
      push(
        page,
        frame('snapshot', {
          type: 'snapshot',
          room: room(BETA),
          entries,
          cursor: entries.at(-1)?.cursor ?? null,
          lastRemoteSeq: entries.at(-1)?.remoteSeq ?? 0,
          stale: false,
        })
      ),
    /** Deliver committed entries one by one, the way a live burst arrives. */
    arrive: (entries: Entry[]) =>
      push(page, entries.map((item) => frame('entry', { type: 'entry', entry: item })).join('')),
  };
}

/**
 * Serve the room's history, accept posts, and hand the test the live stream.
 *
 * A post is confirmed at once with the next sequence number, the way the
 * Community answered in the two-Desktop runs (201, immediately).
 */
async function mockChannel(page: Page, history: Entry[]) {
  await mockCommunities(page, [BETA]);
  const stream = await controllableStream(page);
  let nextSeq = 1_000;
  // Registered after `mockCommunities`, so this path answers first and
  // everything else falls through to it.
  await page.route('**/api/communities/**', async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path !== `/api/communities/${REF}/rooms/${ROOM}/entries`) return route.fallback();
    if (request.method() === 'POST') {
      const body = request.postDataJSON() as { text: string };
      await route.fulfill({
        status: 201,
        json: { entry: entry(nextSeq++, body.text, { authorDisplayName: 'Me' }) },
      });
      return;
    }
    await route.fulfill({
      json: {
        community: REF,
        roomId: ROOM,
        entries: history,
        nextCursor: null,
        lastRemoteSeq: history.at(-1)?.remoteSeq ?? 0,
        stale: false,
      },
    });
  });
  return stream;
}

/** How far the scroller is from its true end, in pixels. */
async function distanceFromEnd(page: Page) {
  return page
    .getByTestId('conversation-scroller')
    .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
}

/** Type into the channel composer and send with Enter. */
async function send(page: Page, text: string) {
  const composer = page.getByRole('combobox');
  await expect(composer).toBeEditable();
  await composer.fill(text);
  await composer.press('Enter');
}

/** A burst of forty tall messages from somebody else, none of them measured yet. */
function burst() {
  return Array.from({ length: 40 }, (_, index) => entry(31 + index, tall(`Burst ${index + 1}`)));
}

/** Thirty tall messages, so a channel opens with most of its history off screen. */
const HISTORY = Array.from({ length: 30 }, (_, index) =>
  entry(index + 1, tall(`Earlier ${index + 1}`))
);

test.describe('Community channel view', () => {
  test('one press of Scroll to bottom reaches the newest message after a burst (DOR-2268)', async ({
    page,
  }) => {
    const stream = await mockChannel(page, HISTORY);
    await page.goto(`/channels?community=${REF}&id=${ROOM}`);
    await expect(page.getByText('Earlier 30', { exact: true })).toBeVisible();
    await stream.snapshot(HISTORY);

    // The reader goes back to the top of what was said.
    await page.getByTestId('conversation-scroller').evaluate((el) => el.scrollTo({ top: 0 }));
    await expect(page.getByText('Earlier 1', { exact: true })).toBeVisible();

    await stream.arrive(burst());
    const jump = page.getByRole('button', { name: 'Scroll to bottom' });
    await expect(jump).toBeVisible();

    await jump.click();

    // One press is the whole promise: the newest message is on screen and the
    // list is at its real end, not at the end the estimate predicted.
    await expect(page.getByText('Burst 40', { exact: true })).toBeInViewport();
    await expect.poll(() => distanceFromEnd(page), { timeout: 5_000 }).toBeLessThanOrEqual(2);
    await expect(jump).toBeHidden();
  });

  test('your own post comes into view the moment it is accepted, right after opening (DOR-2268)', async ({
    page,
  }) => {
    const stream = await mockChannel(page, HISTORY);
    await page.goto(`/channels?community=${REF}&id=${ROOM}`);
    await stream.snapshot(HISTORY);

    // No settling first: the channel has only just opened.
    await send(page, 'Posting straight away');

    await expect(page.getByText('Posting straight away', { exact: true })).toBeInViewport({
      timeout: 1_500,
    });
    await expect.poll(() => distanceFromEnd(page), { timeout: 1_500 }).toBeLessThanOrEqual(2);
  });

  test('your own post brings you back from earlier history, past a burst (DOR-2268)', async ({
    page,
  }) => {
    const stream = await mockChannel(page, HISTORY);
    await page.goto(`/channels?community=${REF}&id=${ROOM}`);
    await stream.snapshot(HISTORY);
    await expect(page.getByText('Earlier 30', { exact: true })).toBeVisible();
    // Reading back, with a burst from other people landing below, unmeasured.
    await page.getByTestId('conversation-scroller').evaluate((el) => el.scrollTo({ top: 0 }));
    await stream.arrive(burst());
    await expect(page.getByRole('button', { name: 'Scroll to bottom' })).toBeVisible();

    await send(page, 'My answer to all of that');

    await expect(page.getByText('My answer to all of that', { exact: true })).toBeInViewport({
      timeout: 1_500,
    });
    await expect.poll(() => distanceFromEnd(page), { timeout: 1_500 }).toBeLessThanOrEqual(2);
  });

  test('your own post comes into view after the connection is re-checked (DOR-2268)', async ({
    page,
  }) => {
    // The local server re-checks every Community connection each time the app
    // lists them — every 30 seconds — and stamps the answer with the time. The
    // channel must treat an unchanged answer as unchanged: rebuilding itself
    // restarted the stream, emptied the list and dropped the receipt of a post
    // in flight, which is how a person's own message took ~20 seconds to show.
    const stream = await mockChannel(page, HISTORY);
    let listings = 0;
    await page.route('**/api/community-connections', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      listings += 1;
      const capabilities = { read: true, post: true, enrollAgent: false, stream: true };
      await route.fulfill({
        json: {
          connections: [
            {
              ref: REF,
              remoteCommunityId: `remote-${REF}`,
              label: BETA.label,
              pinnedOrigin: `https://${REF}.example.test`,
              connectedHumanMemberId: `person-${REF}`,
              status: 'connected',
              expiresAt: null,
              access: {
                state: 'verified',
                effective: capabilities,
                lastKnown: {
                  lifecycle: 'active',
                  capabilities,
                  verifiedAt: new Date().toISOString(),
                },
              },
              attention: {
                state: 'unavailable',
                unreadCount: null,
                mentionCount: null,
                verifiedAt: null,
              },
            },
          ],
        },
      });
    });
    await page.clock.install();
    await page.goto(`/channels?community=${REF}&id=${ROOM}`);
    await stream.snapshot(HISTORY);
    await expect(page.getByText('Earlier 30', { exact: true })).toBeInViewport();
    const before = listings;

    const recheck = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/community-connections'
    );
    await page.clock.fastForward('00:31');
    await recheck;
    expect(listings).toBeGreaterThan(before);
    // A window for the regression to show in, not a wait for the fix: when the
    // channel rebuilt itself on a re-check it reopened its stream within half a
    // second of the answer, measured. Nothing is expected to happen here.
    await page.waitForTimeout(1_000);

    // Same access, same channel: the one stream it opened is still the one.
    expect(await page.evaluate(() => (window as unknown as { __opened: number }).__opened)).toBe(1);
    await send(page, 'Still here after the check');
    await expect(page.getByText('Still here after the check', { exact: true })).toBeInViewport({
      timeout: 1_500,
    });
  });

  for (const viewport of [
    { name: 'desktop', width: 1280, height: 800 },
    { name: 'phone', width: 390, height: 844 },
  ]) {
    test(`shows the reply count under a thread root and keeps it current (DOR-2229, ${viewport.name})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const root = entry(2, 'Can someone look at the failing build?', {
        thread: { replyCount: 3, lastReplyAt: new Date(AT + 5 * 60_000).toISOString() },
        threadLastReplySeq: 5,
      });
      const history = [entry(1, 'Morning, all.'), root, entry(6, 'Unrelated news.')];
      const stream = await mockChannel(page, history);
      await page.goto(`/channels?community=${REF}&id=${ROOM}`);
      await stream.snapshot(history);

      const line = page.getByRole('button', { name: /^3 replies · last / });
      await expect(line).toBeVisible();
      await page.screenshot({ path: test.info().outputPath(`replies-${viewport.name}.png`) });

      // A reply lands over the live stream: the line counts it, once.
      await stream.arrive([
        entry(7, 'On it.', { parentEntryId: root.id, threadRootEntryId: root.id, depth: 1 }),
      ]);
      await expect(page.getByRole('button', { name: /^4 replies · last / })).toBeVisible();
      await page.screenshot({ path: test.info().outputPath(`replies-live-${viewport.name}.png`) });

      await page.getByRole('button', { name: /^4 replies/ }).click();
      await expect(page).toHaveURL(new RegExp(`thread=${root.id}`));
    });
  }
});
