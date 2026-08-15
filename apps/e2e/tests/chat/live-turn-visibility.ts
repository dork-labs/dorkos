/**
 * What a live turn shows while it runs, and how it settles when it stops
 * (DOR-1214).
 *
 * Backs four rows of `meta/chat-capabilities.md`:
 *
 * - **C-10** — Stop stops a running turn, and the UI settles honestly.
 * - **R-05** — subagent blocks appear while running and clear when done.
 * - **R-06** — the todos pill's counts and statuses advance.
 * - **R-07** — the background task bar for async agents.
 *
 * **These rows are all about a MOMENT, which is why they were untested.** "The
 * blocks are visible while the work runs" is a claim about the window between
 * two events, and every existing test-mode scenario closes that window in the
 * same synchronous pass that opens it. The `demo-subagents` scenario holds it
 * open for about six seconds, which is a recording's clock, not a test's: an
 * assertion against it is racing a stopwatch it does not control, and it loses
 * that race on a runner slower than the author's machine.
 *
 * So these drive scenarios that park on a step barrier the test releases by hand
 * (`POST /api/test/step`). The running window is held open for exactly as long
 * as the assertions need, whatever the machine is doing — and the stop test's
 * turn has NO self-ending path at all, so "the turn stopped" is a claim about
 * Stop rather than about elapsed time.
 *
 * **Why this is a module and not a spec file**, and why the `.ts` extension is
 * load-bearing: see the header of `interactive-prompts.ts`. Same two locks.
 *
 * @module tests/chat/live-turn-visibility
 */
import { test, expect } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { ChatPage } from '../../pages/ChatPage.js';

/** See the note in `interactive-prompts.ts` — a ceiling, not a delay. */
const SERVER_ROUND_TRIP_MS = 30_000;

/** Inputs the registering spec file supplies. */
export interface LiveTurnVisibilityDeps {
  /** Base URL of the test-mode API leg. */
  apiUrl: string;
  /** The seeded agent's directory, read fresh per test (the fixture reseeds). */
  agentDir: () => string;
}

/**
 * Register the live-turn suites onto the calling spec file's worker.
 *
 * @param deps - The test-mode API base URL and the seeded agent directory.
 */
export function registerLiveTurnVisibilityTests(deps: LiveTurnVisibilityDeps): void {
  const { apiUrl, agentDir } = deps;

  /**
   * Open a chat, wait for it to settle on a session, and bind `scenario` to it.
   *
   * Session-scoped rather than the server-wide default, so a neighbouring
   * project on this shared leg never inherits a step-gated scenario it would
   * hang on. See the same helper in `interactive-prompts.ts`.
   *
   * @param page - The page to drive.
   * @param request - The API context used to bind the scenario.
   * @param scenario - The test-mode scenario name.
   */
  async function openScenario(
    page: Page,
    request: APIRequestContext,
    scenario: string
  ): Promise<{ chatPage: ChatPage; sessionId: string }> {
    const chatPage = new ChatPage(page);
    await chatPage.goto(undefined, { dir: agentDir() });

    // Let the app SETTLE on a session id, then bind to that one.
    //
    // This used to mint the id here and navigate straight to it, and that raced:
    // the route loader decides for itself which session the page is on, and when
    // it re-minted after the send had already gone out, the optimistic message
    // was dropped and the transcript snapped back to "Start a conversation" —
    // with the scenario bound to an id nothing was using. It cost three flakes
    // in 36 runs and it read as a missing card every time.
    //
    // Binding AFTER the URL settles is safe because the scenario is only
    // consulted when a turn starts, which is strictly later.
    await expect
      .poll(() => new URL(page.url()).searchParams.get('session'), {
        timeout: SERVER_ROUND_TRIP_MS,
      })
      .not.toBeNull();
    const sessionId = new URL(page.url()).searchParams.get('session') as string;

    const bound = await request.post(`${apiUrl}/api/test/scenario`, {
      data: { name: scenario, sessionId },
    });
    expect(bound.ok(), `could not bind scenario ${scenario}`).toBe(true);
    return { chatPage, sessionId };
  }

  /**
   * Release ONE step barrier, waiting for the scenario to reach it first.
   *
   * `POST /api/test/step` answers `released: false` when nothing is parked yet,
   * and a scenario only parks once every event before the barrier has been
   * consumed — which is a network round trip and a few microtasks behind the
   * send that started it. Firing a step blind therefore drops it on the floor
   * and leaves the turn waiting on a barrier nobody will release again, which
   * surfaces thirty seconds later as a locator timeout naming the wrong thing.
   *
   * Polling rather than sleeping for the same reason everything else here does:
   * it returns the instant the scenario is ready and survives a slow runner.
   *
   * @param request - The API context.
   * @param sessionId - The session whose scenario should advance.
   */
  async function releaseStep(request: APIRequestContext, sessionId: string): Promise<void> {
    await expect
      .poll(
        async () => {
          const res = await request.post(`${apiUrl}/api/test/step`, { data: { sessionId } });
          if (!res.ok()) return false;
          return ((await res.json()) as { released: boolean }).released;
        },
        { timeout: SERVER_ROUND_TRIP_MS }
      )
      .toBe(true);
  }

  /** The transcript as the reader sees it — never the screen-reader announcer. */
  const transcript = (page: Page) => page.getByTestId('transcript-feed');

  test.describe('Stop ends a running turn, and the UI settles honestly (C-10)', () => {
    test('a turn with no self-ending path stops when Stop is pressed', async ({
      page,
      request,
    }) => {
      const { chatPage } = await openScenario(page, request, 'stoppable-turn');
      await chatPage.sendAndLand('start something long');

      // The turn is live: it has streamed, and it is parked on a barrier this
      // test will never release. Nothing but Stop can end it — which is what
      // makes the assertion below about Stop rather than about a timer.
      await expect(transcript(page)).toContainText('STOPPABLE-TURN', {
        timeout: SERVER_ROUND_TRIP_MS,
      });
      const stop = page.getByRole('button', { name: 'Stop generating' });
      await expect(stop).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

      await stop.click();

      // SETTLES: the stop affordance goes away and the composer comes back, so
      // the person can type again. A turn that was killed server-side but left
      // the UI streaming would fail here, and that is the dishonest settle this
      // row exists to catch.
      await expect(stop).toBeHidden({ timeout: SERVER_ROUND_TRIP_MS });
      await expect(chatPage.inferenceStreaming).toBeHidden({ timeout: SERVER_ROUND_TRIP_MS });
      await expect(chatPage.input).toBeEnabled();

      // And HONESTLY: the turn really stopped where it was. The scenario's text
      // past the barrier is unreachable unless the turn kept running, so its
      // absence is the proof that Stop reached the runtime rather than only the
      // browser.
      // `toHaveCount(0)` rather than `not.toContainText` on the feed: an
      // interrupted turn can leave the session with no persisted history at all,
      // and then the transcript unmounts for the empty state — at which point a
      // `not.toContainText` fails on "element not found" instead of passing.
      // The count form is true whether the feed is empty or absent.
      await expect(page.getByText('unreachable unless the test released a step')).toHaveCount(0);
    });

    test('a turn parked on an approval offers no Stop — answering is the only way out', async ({
      page,
      request,
    }) => {
      // NOT the assertion this case was written to make, and the difference is a
      // real finding rather than a test detail.
      //
      // The intent was "Stop reaches a blocked turn". The RUNTIME does — the
      // interrupt aborts a scenario parked on an approval and closes the turn,
      // pinned by `interactive-scenarios.test.ts` ("ends a turn parked on an
      // approval nobody will ever give"). But the UI never asks it to: while a
      // turn is blocked, the approval card REPLACES the composer, and the
      // composer is where Stop lives. There is no affordance to drive, so there
      // is nothing for a browser test to click.
      //
      // So this pins what is actually true today, and the gap is written up in
      // GOTCHAS. If a Stop is ever offered on a blocked turn, this goes red and
      // names the reason — which is the behaviour wanted from a pin like this.
      const { chatPage } = await openScenario(page, request, 'approval-gated');
      await chatPage.sendAndLand('edit the release notes');

      const card = page.getByTestId('tool-approval');
      await expect(card).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0);

      // The way out is answering it, and that does end the turn.
      await card.getByRole('button', { name: /^Deny\b/ }).click();
      await expect(transcript(page)).toContainText('DENIED-BRANCH', {
        timeout: SERVER_ROUND_TRIP_MS,
      });
      await expect(chatPage.input).toBeEnabled({ timeout: SERVER_ROUND_TRIP_MS });
    });
  });

  test.describe('subagents and the background task bar (R-05, R-07)', () => {
    test('blocks and the task bar are visible while the sub-agents run, and settle when done', async ({
      page,
      request,
    }) => {
      const { chatPage, sessionId } = await openScenario(page, request, 'subagent-fanout');
      await chatPage.sendAndLand('fan this out');

      // R-05 — one block per sub-agent, both RUNNING. The window is held open by
      // the barrier, so this cannot lose a race to a scenario finishing early.
      const blocks = page.getByTestId('subagent-block');
      await expect(blocks).toHaveCount(2, { timeout: SERVER_ROUND_TRIP_MS });
      await expect(blocks.first()).toHaveAttribute('data-status', 'running');
      await expect(blocks.nth(1)).toHaveAttribute('data-status', 'running');
      // Scoped to the block. Each sub-agent's description is on screen TWICE
      // while it runs — once in its transcript block and once in the background
      // task bar below — so a bare `getByText` resolves to two elements and
      // fails Playwright's strict-mode check on its FIRST poll, non-retriably.
      await expect(blocks.first()).toContainText('Audit the server for unused exports');

      // R-07 — the background task bar reports the same two, as a live region.
      const taskBar = page.getByRole('status', { name: /2 background tasks running/i });
      await expect(taskBar).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      await expect(taskBar).toContainText('2');

      await releaseStep(request, sessionId); // progress beats
      await releaseStep(request, sessionId); // completions

      // R-05, the other half — the blocks CLEAR, and they clear completely: when
      // the turn ends the message is rebuilt from history and the settled
      // sub-agent parts are dropped rather than left collapsed, exactly as a
      // finished tool call is (the shipped auto-hide default). So the honest
      // assertion is a count of zero.
      //
      // NOT `data-status="complete"` on each block, which is what this reached
      // for first: that state exists only in the window between the completions
      // landing and the rebuild, so asserting it is racing the turn closing —
      // green on a fast machine, red on a slow one, for no product reason.
      await expect(transcript(page)).toContainText('FANOUT-SETTLED', {
        timeout: SERVER_ROUND_TRIP_MS,
      });
      await expect(blocks).toHaveCount(0, { timeout: SERVER_ROUND_TRIP_MS });
      // And the bar, which exists only while work is live, goes away.
      await expect(taskBar).toBeHidden({ timeout: SERVER_ROUND_TRIP_MS });
    });
  });

  test.describe('the todos pill advances (R-06)', () => {
    test('counts and statuses move as the agent works through the list', async ({
      page,
      request,
    }) => {
      const { chatPage, sessionId } = await openScenario(page, request, 'todo-progress');
      await chatPage.sendAndLand('plan the work');

      // Three tasks, none done. `0/3` rather than "the pill exists": a pill that
      // rendered a frozen count would pass the second and fail every step below.
      const pill = page.getByRole('button', { name: /\d+\/3 tasks/ });
      await expect(pill).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      await expect(pill).toContainText('0/3 tasks');

      // The scenario walks each task pending → in_progress → completed, one
      // released step per transition, so the count moves only on the steps that
      // complete something — which is what makes each number below discriminate.
      await releaseStep(request, sessionId); // task 1 → in_progress
      await expect(pill).toContainText('0/3 tasks');
      await releaseStep(request, sessionId); // task 1 → completed
      await expect(pill).toContainText('1/3 tasks', { timeout: SERVER_ROUND_TRIP_MS });

      await releaseStep(request, sessionId); // task 2 → in_progress
      await releaseStep(request, sessionId); // task 2 → completed
      await expect(pill).toContainText('2/3 tasks', { timeout: SERVER_ROUND_TRIP_MS });

      await releaseStep(request, sessionId); // task 3 → in_progress
      await releaseStep(request, sessionId); // task 3 → completed
      await expect(pill).toContainText('3/3 tasks', { timeout: SERVER_ROUND_TRIP_MS });

      await releaseStep(request, sessionId); // the turn finishes
      await expect(transcript(page)).toContainText('TODOS-DONE', {
        timeout: SERVER_ROUND_TRIP_MS,
      });
    });
  });
}
