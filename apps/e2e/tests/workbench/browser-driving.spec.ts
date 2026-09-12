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
    await openFixture(page, sessionId);
    const second = await browser.newContext();
    const secondPage = await second.newPage();
    await openFixture(secondPage, sessionId);

    const firstFrame = page.frameLocator('iframe[title="Web Page"]');
    const secondFrame = secondPage.frameLocator('iframe[title="Web Page"]');
    await expect(firstFrame.getByText('Nothing done yet')).toBeVisible();
    await expect(secondFrame.getByText('Nothing done yet')).toBeVisible();

    await runDrivingTurn(page);

    // The seat is the later claim, so the SECOND window is the one that acted —
    // even though the turn was sent from the first.
    await expect(secondFrame.getByText(DRIVING_DONE_TEXT)).toBeVisible({ timeout: 15_000 });
    // And the first window's page is untouched. This is the whole point: before
    // the seat, both windows forwarded the command and both pages changed.
    await expect(firstFrame.getByText('Nothing done yet')).toBeVisible();
    await expect(firstFrame.getByText(DRIVING_DONE_TEXT)).toHaveCount(0);

    await second.close();
  });
});
