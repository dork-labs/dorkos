import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { BasePage } from '../../pages/BasePage.js';
import { ChatPage } from '../../pages/ChatPage.js';

/**
 * One queue, every window (spec `persistent-session-runtime`, task 2.6).
 *
 * The queue used to live in the browser: messages typed while the agent worked
 * sat in React state, vanished on refresh, and were invisible to a second
 * window. It lives on the server now, and that is only true if a person can see
 * it — so this drives the thing a person does. Two windows on ONE session:
 * queue in A, see it in B, reword it in B, see the rewording in A, refresh A,
 * find it still there.
 *
 * ## The traps, and how this avoids them
 *
 * 1. **A turn that ends before you can queue behind it.** The built-in
 *    scenarios are zero-latency, so a message sent after one finishes starts a
 *    turn of its own and never becomes a chip. `demo-approval` stops on a
 *    permission prompt and stays stopped, which is a session that is genuinely
 *    busy for as long as the test needs.
 * 2. **One `browser.newContext()` per window.** Real windows share a profile
 *    and a socket budget; separate contexts do not. One context, two pages
 *    (the same trap `multi-window.spec.ts` names).
 * 3. **Two windows on DIFFERENT session ids.** The whole claim is that one
 *    queue is visible twice, so both windows open the SAME session id — the
 *    opposite of what the socket-budget test needs.
 * 4. **Asserting on the composer's own echo.** The chip text is read out of
 *    the queue panel, not out of the transcript, so a message that merely
 *    rendered somewhere cannot pass for a message that is waiting.
 */

// eslint-disable-next-line no-restricted-syntax -- E2E test config; no env.ts available
const MOCK_PORT = process.env.DORKOS_MOCK_PORT || '4243';
const API_URL = `http://localhost:${MOCK_PORT}`;

/** The mock server is shared mutable state; the reset in `beforeEach` is global. */
test.describe.configure({ mode: 'default' });

/** The queue panel's rows, in the order they will be sent. */
function chips(page: Page) {
  return page.getByRole('button', { name: /^\d+\./ });
}

/** The queue panel's header count, e.g. "Queued (3)". */
function queueHeader(page: Page) {
  return page.getByText(/^Queued \(\d+\)$/);
}

/**
 * The composer, by role rather than by its label.
 *
 * `ChatPage.input` matches the IDLE label ("Send a message…"), and the label is
 * exactly what changes here — mid-turn it becomes "Compose another — 2 queued".
 * There is one composer on the page, so the role alone is unambiguous.
 */
function composer(page: Page) {
  return page.getByRole('combobox').first();
}

/** Type into the composer while the agent works, so the message is queued. */
async function queueMessage(page: Page, text: string) {
  const input = composer(page);
  await input.fill(text);
  await input.press('Enter');
}

test.describe('the queue every window can see', () => {
  // Two windows, a blocked turn, and several round trips — the suite default
  // (30s) is not enough to fail informatively.
  test.setTimeout(90_000);

  let agentDir: string;

  test.beforeEach(async ({ request }) => {
    await request.post(`${API_URL}/api/test/reset`);
    await request.patch(`${API_URL}/api/config`, {
      data: {
        onboarding: { dismissedAt: new Date().toISOString() },
        // The consent banner is a modal, and the second window is the one that
        // gets it — a window opened after the first has to answer it before it
        // can reach anything, including the queue this test is about.
        telemetry: { userHasDecided: true },
      },
    });
    const seeded = await request.post(`${API_URL}/api/test/seed-agent`);
    if (!seeded.ok()) {
      throw new Error(`seed-agent failed (${seeded.status()}): ${await seeded.text()}`);
    }
    ({ agentDir } = (await seeded.json()) as { agentDir: string });
    // A turn that keeps working for as long as this test needs one (trap 1).
    // NOT `demo-approval`: a permission prompt swaps the composer for the
    // approval card, and the queue panel is exactly what that card replaces.
    await request.post(`${API_URL}/api/test/scenario`, { data: { name: 'long-turn' } });
  });

  test('one queue: two windows agree, edits cross, and a refresh keeps it', async ({ browser }) => {
    // ONE context, so both pages share a profile the way two real windows do
    // (trap 2).
    const context = await browser.newContext();
    const sessionId = randomUUID();

    try {
      const windowA = await context.newPage();
      const chatA = new ChatPage(windowA);
      await chatA.goto(sessionId, { dir: agentDir });

      // Start the turn that everything queues behind. It keeps working.
      await chatA.sendMessage('Migrate the auth tokens table');
      await expect(windowA.getByTestId('transcript-feed')).toContainText(/Working on it/, {
        timeout: 20_000,
      });

      // Three messages typed while the agent works.
      await queueMessage(windowA, 'then update the docs');
      await queueMessage(windowA, 'then run the tests');
      await queueMessage(windowA, 'then open a PR');

      await expect(queueHeader(windowA)).toHaveText('Queued (3)', { timeout: 10_000 });
      await expect(chips(windowA)).toHaveText([
        /then update the docs/,
        /then run the tests/,
        /then open a PR/,
      ]);

      // A second window on the SAME session (trap 3) shows the same three,
      // hydrated from the snapshot rather than from anything this browser
      // remembered. It opens A's CURRENT url: the first message re-keys the
      // session to the runtime's canonical id, so the uuid this test navigated
      // with is not the id the queue is filed under.
      const windowB = await context.newPage();
      await windowB.goto(windowA.url());
      await new BasePage(windowB).waitForAppReady();

      await expect(queueHeader(windowB)).toHaveText('Queued (3)', { timeout: 20_000 });
      await expect(chips(windowB)).toHaveText([
        /then update the docs/,
        /then run the tests/,
        /then open a PR/,
      ]);

      // Every chip in B is marked as another window's — B did not type them.
      await expect(windowB.getByText('Queued from another window')).toHaveCount(3);

      // Reword the second one in B; A shows the rewording.
      await chips(windowB).nth(1).click();
      const inputB = composer(windowB);
      await inputB.fill('then run the tests on staging');
      await inputB.press('Enter');

      await expect(chips(windowA).nth(1)).toContainText('then run the tests on staging', {
        timeout: 15_000,
      });

      // Remove the third in B; A's list shortens.
      await windowB.getByLabel('Remove queued message 3').click();
      await expect(queueHeader(windowA)).toHaveText('Queued (2)', { timeout: 15_000 });

      // Reorder in A; B agrees on the new order.
      await windowA.getByLabel('Send queued message 2 next').click();
      await expect(chips(windowA)).toHaveText([
        /then run the tests on staging/,
        /then update the docs/,
      ]);
      await expect(chips(windowB)).toHaveText(
        [/then run the tests on staging/, /then update the docs/],
        { timeout: 15_000 }
      );

      // A hard refresh of A: the queue is the server's, so it comes back whole.
      await windowA.reload();
      await expect(queueHeader(windowA)).toHaveText('Queued (2)', { timeout: 20_000 });
      await expect(chips(windowA)).toHaveText([
        /then run the tests on staging/,
        /then update the docs/,
      ]);
    } finally {
      await context.close();
    }
  });

  test('when the turn ends the queue sends itself, in both windows', async ({ browser }) => {
    const context = await browser.newContext();
    const sessionId = randomUUID();

    try {
      const windowA = await context.newPage();
      const chatA = new ChatPage(windowA);
      await chatA.goto(sessionId, { dir: agentDir });

      // Turns that finish on their own after a few seconds, so the queue
      // genuinely drains rather than being drained by anything this test does.
      await context.request.post(`${API_URL}/api/test/scenario`, {
        data: { name: 'brief-turn' },
      });

      await chatA.sendMessage('Migrate the auth tokens table');
      await expect(windowA.getByTestId('transcript-feed')).toContainText(/Working on it/, {
        timeout: 20_000,
      });

      await queueMessage(windowA, 'then update the docs');
      await queueMessage(windowA, 'then run the tests');
      await expect(queueHeader(windowA)).toHaveText('Queued (2)', { timeout: 10_000 });

      const windowB = await context.newPage();
      await windowB.goto(windowA.url());
      await new BasePage(windowB).waitForAppReady();
      await expect(queueHeader(windowB)).toHaveText('Queued (2)', { timeout: 20_000 });

      // Nobody presses send. Each turn ends, the head goes, and the panel is
      // gone from BOTH windows once nothing is waiting — the assertion is
      // monotone on purpose, so it cannot miss an intermediate count.
      await expect(queueHeader(windowA)).toHaveCount(0, { timeout: 60_000 });
      await expect(queueHeader(windowB)).toHaveCount(0, { timeout: 60_000 });

      // And both messages were actually said, in the order they waited in.
      await expect(windowA.getByTestId('transcript-feed')).toContainText('then update the docs');
      await expect(windowA.getByTestId('transcript-feed')).toContainText('then run the tests');
    } finally {
      await context.close();
    }
  });
});
