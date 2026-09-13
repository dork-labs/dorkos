import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { openInCanvasBrowser, startDevServer } from '../../pages/canvas-dev-server';
import { ChatPage } from '../../pages/ChatPage';
import { RightPanelPage } from '../../pages/RightPanelPage';

/**
 * One session, two windows, one canvas (spec `canvas-agent-seat` §1).
 *
 * This is the promise the whole phase exists to keep, and it is the one thing
 * jsdom cannot prove: a document opened in one browser context appearing in
 * ANOTHER, live, with no reload — and still being there after a reload. Before
 * this landed the canvas was one browser's `localStorage`, so a second window on
 * the same session showed nothing at all, and the failure was silent.
 *
 * It found a real one on the way in: the `canvas` frame reached the socket and
 * the second window ignored it, because the client dispatches frames by NAME and
 * the name was not on `SESSION_EVENT_TYPES`. The unit pin in
 * `stream-manager.test.ts` covers that seam; this covers the whole path.
 *
 * Driven the way a person does it — the right panel's Canvas tab, its empty
 * state, its tab strip — and never by seeding rows: a test that wrote to the
 * database would prove the database works and say nothing about whether a
 * window ever hears.
 *
 * The CANVAS tab rather than the Browser one, deliberately: what is being proved
 * is that the TABLE is shared, and the Browser view's starting point frames a
 * real site, which would put a network round trip inside an assertion about a
 * database row.
 */

/** The tab an empty Canvas view's "Markdown" action opens. */
const DOCUMENT_TAB = /^Document$/;

test.describe('The session canvas is the same in every window @smoke', () => {
  // Two browser contexts, four navigations and a reload: comfortably past the
  // 30-second default, and none of it is waiting on one slow step.
  test.slow();

  test('a document opened in one window appears in the other, live, and survives a reload', async ({
    page,
    rightPanel,
    browser,
  }) => {
    const sessionId = randomUUID();

    // --- Window one: put a page on this session's canvas. ------------------
    await rightPanel.goto(`/session?session=${sessionId}`);
    await rightPanel.ensureTabStripOpen();
    await rightPanel.canvasTab.click();
    await page.getByRole('button', { name: /^Markdown/ }).click();
    await expect(page.getByRole('tab', { name: DOCUMENT_TAB })).toBeVisible();

    // --- Window two: a SEPARATE context, so nothing is shared. -------------
    // Not a second tab of the same context: `localStorage` is per origin, and a
    // second tab would have shared it — which is exactly what this must not be
    // able to lean on. Everything window two knows came off the session's own
    // stream.
    const second = await browser.newContext();
    const secondPage = await second.newPage();
    try {
      // The same page object window one uses: opening the panel is a retry
      // loop, not one click — below desktop width it is a sheet that mounts
      // nothing until it is open, and the per-agent layout restore can shut it
      // again mid-wait.
      const secondPanel = new RightPanelPage(secondPage);
      await secondPanel.goto(`/session?session=${sessionId}`);
      await secondPanel.ensureTabStripOpen();
      await secondPanel.canvasTab.click();
      // Straight off the cold snapshot — no reload, no second click.
      await expect(secondPage.getByRole('tab', { name: DOCUMENT_TAB })).toBeVisible({
        timeout: 20_000,
      });

      // --- A reload of window one still has it. ----------------------------
      await page.reload();
      await rightPanel.ensureTabStripOpen();
      await rightPanel.canvasTab.click();
      await expect(page.getByRole('tab', { name: DOCUMENT_TAB })).toBeVisible({ timeout: 20_000 });

      // --- A close in one window is a close in the other, live. ------------
      // The close control is a SIBLING of the tab, not a child of it (a button
      // inside a button is invalid HTML), so it is addressed by its own label.
      await page.getByRole('button', { name: /^Close Document/i }).click();
      await expect(secondPage.getByRole('tab', { name: DOCUMENT_TAB })).toHaveCount(0, {
        timeout: 20_000,
      });
    } finally {
      await second.close();
    }
  });
});

/**
 * A canvas opened BEFORE the first turn, carried across the rename (DOR-2015).
 *
 * A brand-new session streams under the request UUID the client minted and is
 * renamed to the runtime's canonical id mid-first-turn. Everything keyed by
 * session id has to follow — the projector, the lock, the route the window is
 * on, and the session's canvas. The move itself is pinned below the browser
 * (four `rekeyScope` cases over real SQLite, `canvas-wiring.test.ts` driving the
 * real `rekeyProjector`), but the COMPOSITION the acceptance actually names —
 * open a document on a fresh session, send the first message, and find it still
 * there under the new name — was never made anywhere.
 *
 * It runs on the test-mode leg, and that is a safety property rather than a
 * convenience: every test here sends a message, and on the ordinary leg each one
 * would start a real, billable turn. The rename is declared through
 * `POST /api/test/canonical-id`, because test mode has no SDK to mint an id of
 * its own; the runtime holds it back until the turn starts, so the rekey lands
 * mid-turn exactly as the real one does.
 */
test.describe('A canvas survives the first-turn rename @smoke', () => {
  test.describe.configure({ timeout: 120_000 });

  /** The tab the seeded `localStorage` entry becomes once it has been imported. */
  const IMPORTED_TAB = /^Imported note$/;

  let fixture: Server;
  let fixturePort: number;
  let agentDir: string;

  test.beforeAll(async () => {
    const started = await startDevServer();
    fixture = started.server;
    fixturePort = started.port;
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  });

  /**
   * Put the test-mode runtime back to a known state, and refuse to run anywhere
   * but the leg that has one.
   *
   * `/api/test/*` is mounted only under `DORKOS_TEST_RUNTIME`, so a 404 means
   * this spec is pointed at the leg where its turn would reach a real model on
   * the machine's own sign-in.
   */
  async function prepareTestModeLeg(page: Page): Promise<void> {
    const reset = await page.request.post('/api/test/reset');
    if (reset.status() === 404) {
      throw new Error(
        'This spec is running against a leg with no TestModeRuntime. It drives a turn, so ' +
          'on that leg it would start a real, billable one. Run it in the ' +
          '`chromium-browser-driving` project.'
      );
    }
    // A working directory inside the boundary. Without one the send is refused
    // with a 400 and the spec waits out its timeout on a message the server
    // never accepted — which reads as "the turn never answered".
    const seeded = await page.request.post('/api/test/seed-agent');
    expect(seeded.ok(), 'could not seed an agent to open the conversation in').toBe(true);
    agentDir = ((await seeded.json()) as { agentDir: string }).agentDir;
  }

  /** Put one document into the retired `localStorage` map before the app mounts. */
  async function seedRetiredCanvas(page: Page, sessionId: string): Promise<void> {
    await page.addInitScript(
      ([id, key]) => {
        try {
          localStorage.setItem(
            key!,
            JSON.stringify({
              [id!]: {
                accessedAt: Date.now(),
                documents: [
                  {
                    openedAt: Date.now(),
                    content: {
                      type: 'markdown',
                      content: '# Imported\n\nFrom the retired local store.',
                      title: 'Imported note',
                    },
                  },
                ],
              },
            })
          );
        } catch {
          // about:blank has an opaque origin — the write lands on the real navigation.
        }
      },
      [sessionId, 'dorkos-canvas-sessions']
    );
  }

  /** Declare the id this session's first turn will rename it to. */
  async function declareRename(page: Page, sessionId: string, canonicalId: string): Promise<void> {
    const res = await page.request.post('/api/test/canonical-id', {
      data: { sessionId, canonicalId },
    });
    expect(res.ok(), `could not declare the first-turn rename: ${await res.text()}`).toBe(true);
  }

  test('a document and a page opened before the first message are still there after it', async ({
    page,
    rightPanel,
  }) => {
    await prepareTestModeLeg(page);
    const sessionId = randomUUID();
    const canonicalId = randomUUID();

    // A page in the Browser tab, against the local fixture server rather than a
    // real site: what is under test is a database row, not a network round trip.
    await openInCanvasBrowser(
      page,
      rightPanel,
      `http://localhost:${fixturePort}/`,
      sessionId,
      agentDir
    );
    await expect(page.getByRole('tab', { name: /^Web Page$/ })).toBeVisible();

    // And a document in the Canvas tab, both before a single message is sent.
    await rightPanel.canvasTab.click();
    await page.getByRole('button', { name: /^Markdown/ }).click();
    await expect(page.getByRole('tab', { name: DOCUMENT_TAB })).toBeVisible();

    await declareRename(page, sessionId, canonicalId);

    // Read the trigger's own answer, not just the address bar: "the rename
    // reached the client" and "the client acted on it" are two claims, and a
    // test that only watches the URL cannot say which one failed.
    const trigger = page.waitForResponse(
      (res) => res.url().includes(`/sessions/${sessionId}/messages`) && res.status() === 202
    );
    await new ChatPage(page).sendAndLand('hello', 60_000);
    expect(((await (await trigger).json()) as { sessionId: string }).sessionId).toBe(canonicalId);

    // The window moved to the name the turn gave the session.
    await expect.poll(() => page.url(), { timeout: 30_000 }).toContain(canonicalId);

    // Both documents came with it — the table the window is holding now is the
    // one the rekey moved, hydrated from the canonical id's own snapshot.
    await expect(page.getByRole('tab', { name: DOCUMENT_TAB })).toBeVisible({ timeout: 20_000 });
    await rightPanel.browserTab.click();
    await expect(page.getByRole('tab', { name: /^Web Page$/ })).toBeVisible({ timeout: 20_000 });

    // And a reload under the canonical id finds them on the server, not in this
    // window's memory.
    await page.reload();
    await rightPanel.ensureTabStripOpen();
    await rightPanel.canvasTab.click();
    await expect(page.getByRole('tab', { name: DOCUMENT_TAB })).toBeVisible({ timeout: 20_000 });
    await rightPanel.browserTab.click();
    await expect(page.getByRole('tab', { name: /^Web Page$/ })).toBeVisible({ timeout: 20_000 });
  });

  test('a canvas still in localStorage is imported BEFORE the rename and lands under the new id', async ({
    page,
    rightPanel,
  }) => {
    await prepareTestModeLeg(page);
    const sessionId = randomUUID();
    const canonicalId = randomUUID();

    // Keyed by the id the window opens under, so the one-time import runs first
    // and the rekey then has to carry what it wrote.
    await seedRetiredCanvas(page, sessionId);
    await rightPanel.goto(`/session?session=${sessionId}&dir=${encodeURIComponent(agentDir)}`);
    await rightPanel.ensureTabStripOpen();
    await rightPanel.canvasTab.click();
    await expect(page.getByRole('tab', { name: IMPORTED_TAB })).toBeVisible({ timeout: 20_000 });

    await declareRename(page, sessionId, canonicalId);
    await new ChatPage(page).sendAndLand('hello', 60_000);
    await expect.poll(() => page.url(), { timeout: 30_000 }).toContain(canonicalId);

    await page.reload();
    await rightPanel.ensureTabStripOpen();
    await rightPanel.canvasTab.click();
    await expect(page.getByRole('tab', { name: IMPORTED_TAB })).toBeVisible({ timeout: 20_000 });
  });

  /**
   * The two windows this branch is about, crossed (review round 1, finding 2).
   *
   * A document opened before the stream attached is HELD, and the first message
   * renames the session out from under it. The rebind that follows used to throw
   * the held write away — no row on the server, no tab on screen, and nothing
   * said. The socket is kept shut here so the hold is real, and the message is
   * sent without waiting for a reply: the reply rides the stream, but the 202
   * that carries the new name does not.
   */
  test('a document held for a stream that has not attached still lands after the rename', async ({
    page,
    rightPanel,
  }) => {
    await prepareTestModeLeg(page);
    const sessionId = randomUUID();
    const canonicalId = randomUUID();

    const canvasPosts: number[] = [];
    page.on('response', (res) => {
      if (res.request().method() !== 'POST') return;
      if (/\/sessions\/[^/]+\/canvas$/.test(new URL(res.url()).pathname)) {
        canvasPosts.push(res.status());
      }
    });

    let attachStream!: () => void;
    const held = new Promise<void>((resolve) => (attachStream = resolve));
    await page.routeWebSocket('**/api/sessions/**', (socket) => {
      void held.then(() => socket.connectToServer());
    });

    await rightPanel.goto(`/session?session=${sessionId}&dir=${encodeURIComponent(agentDir)}`);
    await rightPanel.ensureTabStripOpen();
    await rightPanel.canvasTab.click();
    await page.getByRole('button', { name: /^Markdown/ }).click();
    await expect(page.getByRole('tab', { name: DOCUMENT_TAB })).toBeVisible();
    await expect.poll(() => canvasPosts.length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(canvasPosts[0], 'the open must have met the not-known-yet refusal').toBe(404);

    await declareRename(page, sessionId, canonicalId);
    const chat = new ChatPage(page);
    await chat.input.fill('hello');
    await chat.sendButton.click();
    await expect.poll(() => page.url(), { timeout: 30_000 }).toContain(canonicalId);

    // The stream comes up under the NEW name, and the write that was waiting is
    // sent there.
    attachStream();
    await expect.poll(() => canvasPosts, { timeout: 30_000 }).toContain(201);
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);

    await page.reload();
    await rightPanel.ensureTabStripOpen();
    await rightPanel.canvasTab.click();
    await expect(page.getByRole('tab', { name: DOCUMENT_TAB })).toBeVisible({ timeout: 20_000 });
  });

  test('a canvas still in localStorage is imported AFTER the rename and lands under the new id', async ({
    page,
    rightPanel,
  }) => {
    await prepareTestModeLeg(page);
    const sessionId = randomUUID();
    const canonicalId = randomUUID();

    // The other order: the entry is keyed by the name the session ENDS UP with,
    // so nothing is imported while the window is on the minted id and the import
    // runs only once the rename has moved the route.
    await seedRetiredCanvas(page, canonicalId);
    await rightPanel.goto(`/session?session=${sessionId}&dir=${encodeURIComponent(agentDir)}`);
    await rightPanel.ensureTabStripOpen();
    await rightPanel.canvasTab.click();
    await expect(page.getByRole('tab', { name: IMPORTED_TAB })).toHaveCount(0);

    await declareRename(page, sessionId, canonicalId);
    await new ChatPage(page).sendAndLand('hello', 60_000);
    await expect.poll(() => page.url(), { timeout: 30_000 }).toContain(canonicalId);

    await rightPanel.ensureTabStripOpen();
    await rightPanel.canvasTab.click();
    await expect(page.getByRole('tab', { name: IMPORTED_TAB })).toBeVisible({ timeout: 20_000 });

    // On the server, not just on screen: a reload finds it under the new id.
    await page.reload();
    await rightPanel.ensureTabStripOpen();
    await rightPanel.canvasTab.click();
    await expect(page.getByRole('tab', { name: IMPORTED_TAB })).toBeVisible({ timeout: 20_000 });
  });
});

/**
 * Opening a file as the very FIRST thing you do on a new session (DOR-2016).
 *
 * `POST /api/sessions/:id/canvas` refuses an id no projector and no runtime
 * binding knows, which is what keeps a canvas out of a scope nothing can ever
 * reclaim. A session that has never taken a turn has no binding, and the
 * projector is created by its durable stream attaching — so between the window
 * mounting and the socket connecting, that refusal was aimed at a session the
 * person was looking at. The document vanished and they were told "Session not
 * found".
 *
 * The window is held open here by keeping the stream's SOCKET shut, which is why
 * this lives in a browser at all: the durable stream is a WebSocket, so the
 * ordinary request interception never sees it, and a first version of this
 * passed while the open quietly returned 201. The POST statuses are asserted for
 * that reason — `404` then `201` is the whole case, and without it the test
 * proves nothing while looking exactly the same.
 */
test.describe('A file opened before the session stream attaches @smoke', () => {
  test.describe.configure({ timeout: 120_000 });

  test('lands once the stream is there, and says nothing in the meantime', async ({
    page,
    rightPanel,
  }) => {
    const seeded = await page.request.post('/api/test/seed-agent');
    expect(seeded.ok(), 'could not seed an agent to open the conversation in').toBe(true);
    const { agentDir } = (await seeded.json()) as { agentDir: string };
    const sessionId = randomUUID();

    const canvasPosts: number[] = [];
    page.on('response', (res) => {
      if (res.request().method() !== 'POST') return;
      if (/\/sessions\/[^/]+\/canvas$/.test(new URL(res.url()).pathname)) {
        canvasPosts.push(res.status());
      }
    });

    let attachStream!: () => void;
    const held = new Promise<void>((resolve) => (attachStream = resolve));
    await page.routeWebSocket('**/api/sessions/**', (socket) => {
      void held.then(() => socket.connectToServer());
    });

    await rightPanel.goto(`/session?session=${sessionId}&dir=${encodeURIComponent(agentDir)}`);
    await rightPanel.ensureTabStripOpen();
    await rightPanel.canvasTab.click();
    await page.getByRole('button', { name: /^Markdown/ }).click();

    // The document is on screen, and the refusal was not made the person's
    // problem: it is the client's to retry.
    await expect(page.getByRole('tab', { name: DOCUMENT_TAB })).toBeVisible();
    await expect.poll(() => canvasPosts.length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(canvasPosts[0], 'the first open must have met the not-known-yet refusal').toBe(404);
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: DOCUMENT_TAB })).toBeVisible();

    // The stream attaches, and the held write goes out.
    attachStream();
    await expect.poll(() => canvasPosts, { timeout: 20_000 }).toContain(201);
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);

    // On the SERVER, not just on screen — and still there after a reload.
    await page.reload();
    await rightPanel.ensureTabStripOpen();
    await rightPanel.canvasTab.click();
    await expect(page.getByRole('tab', { name: DOCUMENT_TAB })).toBeVisible({ timeout: 20_000 });
  });
});
