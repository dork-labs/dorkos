import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Page, Request } from '@playwright/test';
import { test, expect } from '../../fixtures';
import {
  DRIVING_BUTTON,
  DRIVING_DONE_TEXT,
  openInCanvasBrowser,
  startDrivingFixtureServer,
} from '../../pages/canvas-dev-server';
import { RightPanelPage } from '../../pages/RightPanelPage';
import { ChatPage } from '../../pages/ChatPage';

/**
 * An agent using the page, in a real browser.
 *
 * jsdom can execute the shim and settle every refusal, and it can settle none of
 * this: it has no layout engine, no `checkVisibility`, and no second window. So
 * this spec is where the claims that need a browser get made — a click reaching
 * a live document and changing it, an outline read seeing the change, and, with
 * the same conversation open in TWO windows, exactly one of them answering.
 *
 * It runs on the test-mode leg, and that is a safety property rather than a
 * convenience: it drives a turn, and on the ordinary leg every turn here would
 * be a real, billable one. The turn it drives is the `browser-driving` scenario,
 * which calls the production handlers rather than composing an answer — so what
 * this spec proves is the round trip, not a fixture agreeing with itself.
 */
test.describe('Browser — an agent uses the page @smoke', () => {
  let fixture: Server;
  let fixturePort: number;
  let agentDir: string;

  test.beforeAll(async () => {
    const started = await startDrivingFixtureServer();
    fixture = started.server;
    fixturePort = started.port;
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  });

  // The driving scenario is selected as the server-wide DEFAULT (see below), so
  // it has to be put back after every test. Left on, every later turn on this
  // leg drives a browser instead of answering: #team's fallback seat then never
  // replies to a post, and whichever spec runs next on the same test-mode
  // server fails for a reason that is nowhere in its own file.
  test.afterEach(async ({ request }) => {
    await request.post('/api/test/reset');
  });

  /**
   * Put the test-mode runtime back to a known state, and refuse to run anywhere
   * but the leg that has one.
   *
   * `/api/test/*` is mounted only under `DORKOS_TEST_RUNTIME`, so a 404 means
   * this spec is pointed at the leg where its turn would reach a real model on
   * the machine's own sign-in.
   */
  async function selectDrivingScenario(page: Page): Promise<void> {
    const reset = await page.request.post('/api/test/reset');
    if (reset.status() === 404) {
      throw new Error(
        'This spec is running against a leg with no TestModeRuntime. It drives a turn, so ' +
          'on that leg it would start a real, billable one. Run it in the ' +
          '`chromium-browser-driving` project.'
      );
    }
    // The DEFAULT rather than a per-session selection: the session this spec
    // sends from is minted by the loader, so its id is not one the test can name
    // before the send. This project runs one file on one worker, so the default
    // is not shared with anything.
    const res = await page.request.post('/api/test/scenario', {
      data: { name: 'browser-driving' },
    });
    expect(res.ok(), `could not select the driving scenario: ${await res.text()}`).toBe(true);

    // A working directory inside the boundary. Without one the send is refused
    // with a 400 and the spec waits out its timeout on a message the server
    // never accepted — which reads as "the turn never answered".
    const seeded = await page.request.post('/api/test/seed-agent');
    expect(seeded.ok(), 'could not seed an agent to open the conversation in').toBe(true);
    agentDir = ((await seeded.json()) as { agentDir: string }).agentDir;
  }

  /** Open the fixture page in the Browser tab and wait for its shim to connect. */
  async function openFixture(page: Page, sessionId: string): Promise<void> {
    const rightPanel = new RightPanelPage(page);
    const claims: { active?: boolean; instrumented?: boolean }[] = [];
    page.on('request', (request: Request) => {
      if (request.method() !== 'POST' || !request.url().includes('/devtools/ingest')) return;
      const body = request.postDataJSON() as { active?: boolean; instrumented?: boolean } | null;
      if (body && body.active !== undefined) claims.push(body);
    });

    await openInCanvasBrowser(
      page,
      rightPanel,
      `http://localhost:${fixturePort}/`,
      sessionId,
      agentDir
    );
    const frame = page.frameLocator('iframe[title="Web Page"]');
    await expect(frame.getByRole('button', { name: DRIVING_BUTTON })).toBeVisible({
      timeout: 15_000,
    });

    // The seat claim, upgraded to instrumented once the shim handshook. Without
    // it the server would answer "that page is not instrumented" rather than
    // driving anything, so waiting for the page to paint is not enough.
    await expect
      .poll(() => claims.some((claim) => claim.active === true && claim.instrumented === true), {
        timeout: 15_000,
      })
      .toBe(true);
  }

  /** Send the message that runs the scripted driving turn, and wait for its answer. */
  async function runDrivingTurn(page: Page): Promise<string> {
    const chat = new ChatPage(page);
    await chat.sendAndLand('use the page', 60_000);
    const answer = page.locator('[data-testid="message-item"][data-role="assistant"]').last();
    await expect(answer).toContainText('click:', { timeout: 60_000 });
    return await answer.innerText();
  }

  test('reads the page, clicks a button, and sees what the click changed', async ({ page }) => {
    const sessionId = randomUUID();
    await selectDrivingScenario(page);
    await openFixture(page, sessionId);

    const frame = page.frameLocator('iframe[title="Web Page"]');
    // Before: the page says nothing has been done.
    await expect(frame.getByText('Nothing done yet')).toBeVisible();

    const answer = await runDrivingTurn(page);

    // The click landed in the real document, in the frame the person is looking
    // at — this is the assertion jsdom cannot make.
    await expect(frame.getByText(DRIVING_DONE_TEXT)).toBeVisible({ timeout: 15_000 });
    await expect(frame.getByText('Nothing done yet')).toHaveCount(0);

    // And the agent knows what it did, which page it did it in, and what the
    // page says now — the outline it read back names the changed text.
    expect(answer).toContain(`Clicked button "${DRIVING_BUTTON}".`);
    expect(answer).toContain('read-outline:');
    expect(answer).toContain(`button "${DRIVING_BUTTON}"`);
    expect(answer).toContain('button "Archive" [disabled]');
    expect(answer).toContain(`read-again-outline:`);
    expect(answer).toContain(DRIVING_DONE_TEXT);
  });

  test('with the same conversation in two windows, only the driver answers', async ({
    page,
    browser,
  }) => {
    const sessionId = randomUUID();
    await selectDrivingScenario(page);

    // Window one opens the page first, then window two — so window two holds the
    // seat, and window one must see nothing at all.
    //
    // Since the canvas became the server's table, window two does not open a
    // second page: it INHERITS this one and types the address into the page it
    // already has (`openInCanvasBrowser` takes whichever path the window is in).
    // That is what makes it the driver — a person acting in that window — rather
    // than the mere fact of mounting, which claims only a keep-alive now.
    await openFixture(page, sessionId);
    const second = await browser.newContext();
    const secondPage = await second.newPage();
    await openFixture(secondPage, sessionId);

    const firstFrame = page.frameLocator('iframe[title="Web Page"]');
    const secondFrame = secondPage.frameLocator('iframe[title="Web Page"]');
    await expect(firstFrame.getByText('Nothing done yet')).toBeVisible();
    await expect(secondFrame.getByText('Nothing done yet')).toBeVisible();

    await runDrivingTurn(page);

    // The seat is the later PERSON, so the SECOND window is the one that acted —
    // even though the turn was sent from the first.
    await expect(secondFrame.getByText(DRIVING_DONE_TEXT)).toBeVisible({ timeout: 15_000 });
    // And the first window's page is untouched. This is the whole point: before
    // the seat, both windows forwarded the command and both pages changed.
    await expect(firstFrame.getByText('Nothing done yet')).toBeVisible();
    await expect(firstFrame.getByText(DRIVING_DONE_TEXT)).toHaveCount(0);

    await second.close();
  });
  test('bounds hostile served-page reports and admits known forgery only as unverified evidence', async ({
    page,
  }) => {
    const sessionId = randomUUID();
    await selectDrivingScenario(page);
    // Install before the response-injected shim: window message listeners in
    // Chromium run in registration order even for a later capture:true listener.
    await page.addInitScript(() => {
      if (window === window.top || !location.pathname.includes('/api/workbench/serve')) return;
      window.addEventListener('message', (event) => {
        if (event.source !== parent || event.data?.__dorkosDevtools !== 'capture-request') return;
        event.stopImmediatePropagation();
        window.dispatchEvent(new CustomEvent('bridge-test-capture', { detail: event.data }));
      });
    });
    await writeFile(
      join(agentDir, 'index.html'),
      '<!doctype html><html><head><title>Bridge adversary</title></head><body><h1>Bridge adversary</h1></body></html>'
    );
    await page.request.post('/api/test/scenario', {
      data: { name: 'browser-bridge-evidence', sessionId },
    });
    const snapshots: {
      active?: boolean;
      instrumented?: boolean;
      bridgeGeneration?: string;
      screenshot?: { requestId: string; dataUrl?: string; error?: string };
    }[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/devtools/ingest'))
        snapshots.push(request.postDataJSON());
    });
    await openInCanvasBrowser(page, new RightPanelPage(page), './index.html', sessionId, agentDir);
    await expect
      .poll(() =>
        snapshots.some((s) => s.instrumented === true && typeof s.bridgeGeneration === 'string')
      )
      .toBe(true);
    const gen = snapshots.filter((s) => s.instrumented === true).at(-1)!.bridgeGeneration!;
    const child = page.frames().find((f) => f.url().includes('/api/workbench/serve'))!;
    expect(child, 'the attack must run inside the real signed served iframe').toBeDefined();
    const attempts = await child.evaluate(
      async ({ gen }) => {
        const png =
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
        const cycle: unknown[] = [];
        cycle.push(cycle);
        const messages = [
          { __dorkosDevtools: 'capture-result', requestId: 'unsolicited', dataUrl: png },
          {
            __dorkosDevtools: 'capture-result',
            bridgeGeneration: gen,
            requestId: 'unsolicited',
            dataUrl: png,
          },
          ...[[1n], cycle].map((args) => ({
            __dorkosDevtools: 'batch',
            bridgeGeneration: gen,
            seq: 1,
            console: [{ level: 'log', text: 'hostile clone', timestamp: 1, args }],
            network: [],
          })),
        ];
        for (const report of messages) parent.postMessage(report, '*');
        // Attack a known pending request from a real nested frame and from the
        // current page with the wrong generation or no outcome. Hold the valid page forgery
        // until the test observes zero HTTP captures, then prove the waiter survives.
        const state = window as Window & {
          __bridgeKnownReply?: Record<string, unknown>;
          __bridgeAttacksSent?: number;
        };
        const nested = document.createElement('iframe');
        nested.srcdoc = `<script>addEventListener('message', e => {
          top.postMessage(e.data, '*');
          parent.postMessage({ __bridgeNestedSent: true }, '*');
        });</script>`;
        const loaded = new Promise<void>((resolve) => {
          nested.addEventListener('load', () => resolve(), { once: true });
        });
        document.body.append(nested);
        await loaded;
        window.addEventListener('message', (event) => {
          if (event.source === nested.contentWindow && event.data?.__bridgeNestedSent)
            state.__bridgeAttacksSent = (state.__bridgeAttacksSent ?? 0) + 1;
        });
        window.addEventListener('bridge-test-capture', (event) => {
          const data = (event as CustomEvent<{ bridgeGeneration: string; requestId: string }>)
            .detail;
          const reply = {
            __dorkosDevtools: 'capture-result',
            bridgeGeneration: data.bridgeGeneration,
            requestId: data.requestId,
            dataUrl: png,
            evidence: { source: 'host', verified: true },
          };
          state.__bridgeKnownReply = reply;
          state.__bridgeAttacksSent = 2;
          parent.postMessage(
            {
              __dorkosDevtools: 'capture-result',
              bridgeGeneration: data.bridgeGeneration,
              requestId: data.requestId,
            },
            '*'
          );
          parent.postMessage({ ...reply, bridgeGeneration: `${gen}-other` }, '*');
          nested.contentWindow!.postMessage(reply, '*');
        });
        return messages.length;
      },
      { gen }
    );
    expect(attempts).toBe(4);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    expect(snapshots.filter((s) => s.screenshot)).toHaveLength(0);
    const turn = new ChatPage(page).sendAndLand('read the bridge evidence', 60000);
    await expect
      .poll(() =>
        child.evaluate(
          () => (window as Window & { __bridgeAttacksSent?: number }).__bridgeAttacksSent
        )
      )
      .toBe(3);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    const premature = snapshots.filter((snapshot) => snapshot.screenshot);
    expect(premature, JSON.stringify(premature)).toHaveLength(0);
    await child.evaluate(() => {
      const state = window as Window & { __bridgeKnownReply?: Record<string, unknown> };
      if (!state.__bridgeKnownReply) throw new Error('The known capture request was not observed');
      parent.postMessage(state.__bridgeKnownReply, '*');
    });
    await turn;
    const answer = page.locator('[data-testid="message-item"][data-role="assistant"]').last();
    await expect(answer).toContainText('bridgeEvidence', { timeout: 60000 });
    const text = await answer.innerText();
    expect(text).toContain('page-reported');
    expect(text).toContain('"verified":false');
    expect(text).toContain('image/png');
    await expect.poll(() => snapshots.filter((s) => s.screenshot).length).toBe(1);
    expect(snapshots.find((s) => s.screenshot)!.screenshot!.requestId).not.toBe('unsolicited');
  });
  test('delivers already host-accepted action and screenshot once after real canonical rekey and generation retirement', async ({
    page,
  }) => {
    const sessionId = randomUUID();
    const canonicalId = randomUUID();
    await selectDrivingScenario(page);
    await openFixture(page, sessionId);
    expect(
      (
        await page.request.post('/api/test/scenario', { data: { name: 'browser-bridge-rekey' } })
      ).ok()
    ).toBe(true);
    expect(
      (await page.request.post('/api/test/canonical-id', { data: { sessionId, canonicalId } })).ok()
    ).toBe(true);
    const claims: { active?: boolean; instrumented?: boolean; bridgeGeneration?: string }[] = [];
    const held: {
      url: string;
      body: { requestId?: string; bridgeGeneration: string; screenshot?: { requestId: string } };
    }[] = [];
    let release!: () => void;
    const delivery = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/sessions/*/devtools/*', async (route) => {
      const request = route.request();
      const body = request.postDataJSON();
      if (body.active !== undefined) claims.push(body);
      if (body.screenshot || request.url().endsWith('/devtools/action')) {
        held.push({ url: request.url(), body });
        await delivery;
        // Delivery may use the canonical route even though host acceptance was
        // under the temporary session. Header/body binding stays byte-for-byte.
        await route.continue({
          url: request.url().replace(`/sessions/${sessionId}/`, `/sessions/${canonicalId}/`),
        });
      } else await route.continue();
    });
    const turn = new ChatPage(page).sendAndLand('read across the canonical rename', 60000);
    await expect.poll(() => held.length, { timeout: 10000 }).toBe(2);
    expect(held.every((response) => response.url.includes(sessionId))).toBe(true);
    const generation = held[0].body.bridgeGeneration;
    expect(held[1].body.bridgeGeneration).toBe(generation);
    await expect.poll(() => page.url(), { timeout: 10000 }).toContain(canonicalId);
    await expect
      .poll(() => claims.some((c) => c.active === false && c.bridgeGeneration === generation))
      .toBe(true);
    release();
    await turn;
    const answer = page.locator('[data-testid="message-item"][data-role="assistant"]').last();
    await expect(answer).toContainText('bridgeRekey');
    const text = await answer.innerText();
    expect(text).toContain('image/png');
    expect(text).toContain('page-reported');
    expect(text).toContain('"verified":false');
    expect(text).toContain('Mark as done');
    // Canonical hydration follows the server canvas row; local address navigation
    // may have been showing a different page. Explicitly reopen the fixture to
    // prove a fresh eligible lifetime cannot admit the retired page's result.
    await openFixture(page, canonicalId);
    await expect
      .poll(() =>
        claims.some(
          (c) => c.active === true && c.instrumented === true && c.bridgeGeneration !== generation
        )
      )
      .toBe(true);
    await page
      .frameLocator('iframe[title="Web Page"]')
      .locator('body')
      .evaluate(
        (_body, { generation, held }) => {
          for (const response of held)
            parent.postMessage(
              {
                __dorkosDevtools: response.body.screenshot ? 'capture-result' : 'act-result',
                bridgeGeneration: generation,
                requestId: response.body.screenshot?.requestId ?? response.body.requestId,
                ok: true,
                dataUrl:
                  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
              },
              '*'
            );
        },
        { generation, held }
      );
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    expect(held).toHaveLength(2);
  });
  test('caps the real resource warning and clears it through keyboard reload', async ({
    page,
  }, testInfo) => {
    await selectDrivingScenario(page);
    const claims: { instrumented?: boolean; bridgeGeneration?: string }[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/devtools/ingest'))
        claims.push(request.postDataJSON());
    });
    await openFixture(page, randomUUID());
    await expect.poll(() => claims.some((claim) => claim.instrumented)).toBe(true);
    const generation = claims.filter((claim) => claim.instrumented).at(-1)!.bridgeGeneration!;
    const warning = page.getByText(/This page hit .* errors? while loading\./);
    await expect(warning).toHaveCount(0);
    const empty = testInfo.outputPath('resource-warning-empty.png');
    await page.screenshot({ path: empty });
    await testInfo.attach('resource-warning-empty', { path: empty, contentType: 'image/png' });
    const sent = await page
      .frameLocator('iframe[title="Web Page"]')
      .locator('body')
      .evaluate((_body, generation) => {
        const count = 10_001;
        for (let i = 0; i < count; i++)
          parent.postMessage(
            { __dorkosDevtools: 'resource-error', bridgeGeneration: generation },
            '*'
          );
        return count;
      }, generation);
    expect(sent).toBe(10_001);
    await expect(warning).toHaveText('This page hit at least 10,000 errors while loading.');
    const saturated = testInfo.outputPath('resource-warning-saturated.png');
    await page.screenshot({ path: saturated });
    await testInfo.attach('resource-warning-saturated', {
      path: saturated,
      contentType: 'image/png',
    });
    const reload = page.getByRole('button', { name: 'Reload', exact: true });
    await reload.focus();
    await expect(reload).toBeFocused();
    await reload.press('Enter');
    await expect(warning).toHaveCount(0);
    await expect
      .poll(() =>
        claims.some((claim) => claim.instrumented && claim.bridgeGeneration !== generation)
      )
      .toBe(true);
  });
});
