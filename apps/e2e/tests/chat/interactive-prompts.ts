/**
 * The prompts a turn STOPS on, answered through the real UI (DOR-1214).
 *
 * Backs six rows of `meta/chat-capabilities.md` that had only unit or
 * live-self-test coverage:
 *
 * - **I-01** — the tool-approval card renders; Approve runs the tool and the
 *   result is visible; Deny refuses it and the refusal is visible.
 * - **I-02** — the batch approval bar, with several tools pending at once.
 * - **I-03** — an AskUserQuestion prompt renders, choosing an option delivers
 *   the answer, and the turn continues.
 * - **I-04** — an MCP elicitation prompt.
 * - **I-05** — a parked prompt survives a hard refresh and is still answerable
 *   (DOR-1269, which is what the row's missing `E` was hiding).
 * - **I-07** — a question nobody answers is honest about it after the turn
 *   closes and the page is reloaded (DOR-1293).
 *
 * **What makes these tests able to fail.** Each scenario the test-mode runtime
 * runs genuinely PARKS on the answer and then streams a branch-naming sentence
 * (`APPROVED-BRANCH` / `DENIED-BRANCH` / `ANSWER-RECEIVED: <choice>` /
 * `ELICITATION-ACCEPTED: <value>`). So "the card went away" is never the
 * assertion — the assertion is that the agent said the thing only that answer
 * could have produced. A product that dismissed the card and dropped the answer
 * on the floor passes the first and fails these. See
 * `apps/server/src/services/runtimes/test-mode/interactive-scenarios.ts`.
 *
 * **Why this is a module and not a spec file.** Same lock as
 * `session-read-state.ts`: these tests belong to `chat-mock.spec.ts`, which
 * registers them. The test-mode server is shared mutable state — every
 * `POST /api/test/reset` there wipes scenarios, sessions and projectors
 * globally — and Playwright schedules separate spec FILES onto concurrent
 * workers, so a suite living in its own file would have its parked turn torn
 * down mid-assertion. Registering from here puts these on that file's worker, in
 * its order, while keeping them findable under the feature they test.
 *
 * **And the `.ts` extension is load-bearing.** Every `*.spec.ts` in this
 * directory runs on the COCKPIT leg against the real Claude Code runtime, where
 * a driven turn bills the machine's own `claude` sign-in. The cockpit project
 * also names this basename in its `testIgnore` as a second lock.
 *
 * @module tests/chat/interactive-prompts
 */
import { test, expect } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { ChatPage } from '../../pages/ChatPage.js';

/**
 * How long to give an assertion that cannot pass until the server answers.
 *
 * The same ceiling the other test-mode suites argue for, for the same reason: a
 * web-first assertion returns the moment it is satisfied, so this costs nothing
 * on an idle machine, and what it buys is survival on one that is several
 * worktrees deep in concurrent agents. CI runs `workers: 1` and is slower than
 * any developer machine.
 */
const SERVER_ROUND_TRIP_MS = 30_000;

/** Inputs the registering spec file supplies. */
export interface InteractivePromptsDeps {
  /** Base URL of the test-mode API leg. */
  apiUrl: string;
  /** The seeded agent's directory, read fresh per test (the fixture reseeds). */
  agentDir: () => string;
}

/**
 * Register the interactive-prompt suites onto the calling spec file's worker.
 *
 * @param deps - The test-mode API base URL and the seeded agent directory.
 */
export function registerInteractivePromptTests(deps: InteractivePromptsDeps): void {
  const { apiUrl, agentDir } = deps;

  /**
   * Open a chat, wait for it to settle on a session, and bind `scenario` to it.
   *
   * Session-scoped (`setForSession`) rather than the server-wide default, and
   * that is a safety property rather than tidiness: four Playwright projects
   * share this test-mode leg, and several of the scenarios here PARK on a step
   * barrier only their own test will release. As the default, one of them would
   * be handed to a neighbouring project's turn, which would then hang until its
   * spec timed out.
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
    // Read the refusal out loud. An unbound scenario silently falls back to the
    // `simple-text` echo, and every assertion below then fails on a locator
    // timeout that names a card instead of naming the cause.
    expect(bound.ok(), `could not bind scenario ${scenario}`).toBe(true);
    return { chatPage, sessionId };
  }

  /**
   * Release ONE step barrier, waiting for the scenario to reach it first.
   *
   * `POST /api/test/step` answers `released: false` when nothing is parked yet,
   * so firing blind drops the step and leaves the turn waiting on a barrier
   * nobody will release again — which surfaces thirty seconds later as a
   * locator timeout naming the wrong thing. Polling returns the instant the
   * scenario is ready and survives a slow runner.
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

  test.describe('tool approval — the card, and what each answer actually does (I-01)', () => {
    test('Approve runs the tool, and the result is visible', async ({ page, request }) => {
      // Auto-hide of completed tool calls is a stored preference, ON by default,
      // and it does not hide a finished card — it never puts it in the DOM at
      // all. The approved branch's tool call completes in the same pass that
      // ends the turn, so the RESULT half of this row ("Approve runs the tool")
      // is unobservable with the default on. Turned off here only, so every
      // other spec keeps the shipped default (see GOTCHAS).
      await page.addInitScript(() => {
        localStorage.setItem('dorkos-auto-hide-tool-calls', 'false');
      });
      const { chatPage } = await openScenario(page, request, 'approval-gated');
      await chatPage.sendAndLand('edit the release notes');

      // The card renders, naming the thing it is asking about.
      const card = page.getByTestId('tool-approval');
      await expect(card).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      await expect(card).toContainText('Edit notes/release.md');

      // The turn is genuinely parked: neither branch has been streamed. Without
      // this, a scenario that ran straight through would make the click below
      // decorative and every assertion after it vacuous.
      await expect(transcript(page)).not.toContainText('APPROVED-BRANCH');
      await expect(transcript(page)).not.toContainText('DENIED-BRANCH');

      // NOT `exact`: the button's accessible name is "Approve Enter" — it
      // carries a `<Kbd>` shortcut hint that the name concatenates, and the hint
      // only renders while the card is the active one, so the name is not even
      // stable.
      //
      // And the exclusion is a LOOKAHEAD, not a `\b`. `/^Approve\b/` matches
      // "Approve All" — the boundary sits between "Approve" and the space, so it
      // is satisfied by exactly the string it was meant to exclude. Scoping to
      // the card hides that today (the batch bar lives in the composer), but the
      // comment would have been a lie and the guard would evaporate the moment
      // anyone reused this selector page-wide.
      await card.getByRole('button', { name: /^Approve(?!\s+All)/ }).click();

      // The tool RAN — the branch only an approval reaches, and the result it
      // produced, both in the transcript.
      await expect(transcript(page)).toContainText('APPROVED-BRANCH', {
        timeout: SERVER_ROUND_TRIP_MS,
      });
      // The tool's RESULT lives inside its card, which renders collapsed — a
      // one-line "Edit" header. So "the result is visible" costs one expand, and
      // asserting on the collapsed header instead would have proved only that a
      // tool was mentioned, not that it produced anything.
      //
      // The turn has to be OVER before the card is clicked. While it is closing,
      // the transcript is still reflowing and Playwright refuses to click an
      // element it cannot see hold still ("element is not stable"), which it
      // then reports as a click timeout rather than as an animation.
      await expect(chatPage.inferenceStreaming).toBeHidden({ timeout: SERVER_ROUND_TRIP_MS });
      const toolCard = chatPage.toolCallCards.first();
      await expect(toolCard).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      await toolCard.click();
      await expect(toolCard).toContainText('Applied 1 edit to notes/release.md', {
        timeout: SERVER_ROUND_TRIP_MS,
      });

      // And the transcript keeps a DURABLE record of which way it went, rather
      // than the card merely vanishing.
      //
      // Deliberately the receipt and not `tool-approval-decided`. That testid is
      // the LIVE in-place row, and it exists only until the turn ends and the
      // message is rebuilt from history — at which point the durable
      // `approval-receipt` takes its place. Asserting the transient one is
      // therefore a race against the turn closing, which is exactly the kind of
      // green-by-timing this suite must not ship.
      const receipt = page.getByTestId('approval-receipt').first();
      await expect(receipt).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      await expect(receipt).toHaveAttribute('data-outcome', 'allowed');
    });

    test('Deny refuses the tool, and the refusal is visible', async ({ page, request }) => {
      const { chatPage } = await openScenario(page, request, 'approval-gated');
      await chatPage.sendAndLand('edit the release notes');

      const card = page.getByTestId('tool-approval');
      await expect(card).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      await card.getByRole('button', { name: /^Deny(?!\s+All)/ }).click();

      await expect(transcript(page)).toContainText('DENIED-BRANCH', {
        timeout: SERVER_ROUND_TRIP_MS,
      });
      // The refusal is real, not merely a different label on the same outcome:
      // the tool produced NO result. `Applied 1 edit` is the approved branch's
      // result string, and its absence is what separates the two.
      await expect(transcript(page)).not.toContainText('Applied 1 edit');

      // The durable record says REFUSED — see the note on the approve case for
      // why this is the receipt rather than the transient live row.
      const receipt = page.getByTestId('approval-receipt').first();
      await expect(receipt).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      await expect(receipt).toHaveAttribute('data-outcome', 'denied');
    });

    test('the answered card stops being answerable', async ({ page, request }) => {
      // The ghost DOR-1148 closed: an interaction that was answered but never
      // resolved in the projection leaves every window showing a live card over
      // a turn that has already moved on — so a second click could answer an ask
      // nobody is waiting for.
      const { chatPage } = await openScenario(page, request, 'approval-gated');
      await chatPage.sendAndLand('edit the release notes');

      const card = page.getByTestId('tool-approval');
      await expect(card).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      await card.getByRole('button', { name: /^Approve(?!\s+All)/ }).click();
      await expect(transcript(page)).toContainText('APPROVED-BRANCH', {
        timeout: SERVER_ROUND_TRIP_MS,
      });

      // No pending card, and no Approve button left to press.
      await expect(card).toHaveCount(0, { timeout: SERVER_ROUND_TRIP_MS });
      await expect(page.getByRole('button', { name: /^Approve(?!\s+All)/ })).toHaveCount(0);
    });
  });

  test.describe('batch approval — several tools pending at once (I-02)', () => {
    test('the burst card appears with the count, and Allow all answers every ask', async ({
      page,
      request,
    }) => {
      const { chatPage } = await openScenario(page, request, 'approval-batch');
      await chatPage.sendAndLand('do the three things');

      // The burst card is the surface this row is about, and it mounts only at
      // two or more pending — so the count IS the assertion, not decoration. It
      // was the batch bar until DOR-1330 replaced it with the stacked card;
      // behaviour and the two transport calls are unchanged.
      const bar = page.getByText('3 tools are waiting on you');
      await expect(bar).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

      await page.getByRole('button', { name: /^Allow all/ }).click();

      // Every one of the three was answered: the scenario counts them itself and
      // only reaches this sentence once all three have come back.
      await expect(transcript(page)).toContainText('BATCH-SETTLED: 3 of 3 approved', {
        timeout: SERVER_ROUND_TRIP_MS,
      });
      await expect(bar).toBeHidden();
    });

    test('Deny all refuses every ask, and says so', async ({ page, request }) => {
      const { chatPage } = await openScenario(page, request, 'approval-batch');
      await chatPage.sendAndLand('do the three things');

      // The burst card the batch bar became (DOR-1330): the same behaviour,
      // the same two calls, drawn in the card family's own chrome.
      await expect(page.getByText('3 tools are waiting on you')).toBeVisible({
        timeout: SERVER_ROUND_TRIP_MS,
      });
      await page.getByRole('button', { name: /^Deny all/ }).click();

      // `0 of 3` rather than merely "the bar went away": a Deny All that quietly
      // approved would clear the bar just as convincingly.
      await expect(transcript(page)).toContainText('BATCH-SETTLED: 0 of 3 approved', {
        timeout: SERVER_ROUND_TRIP_MS,
      });
    });
  });

  test.describe('AskUserQuestion — the answer reaches the agent (I-03)', () => {
    test('choosing an option delivers it and the turn continues', async ({ page, request }) => {
      const { chatPage } = await openScenario(page, request, 'question-prompt');
      await chatPage.sendAndLand('set up the tests');

      // The prompt renders as a real radio group named by the question.
      const group = page.getByRole('radiogroup', { name: 'Which test runner should I set up?' });
      await expect(group).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      await expect(group.getByText('Vitest')).toBeVisible();
      await expect(group.getByText('Jest')).toBeVisible();

      // Parked until answered — the same guard as I-01, for the same reason.
      await expect(transcript(page)).not.toContainText('ANSWER-RECEIVED');

      await group.getByRole('radio', { name: /Vitest/ }).click();
      await page.getByRole('button', { name: /^Submit/ }).click();

      // THE ROW'S CLAIM: the CHOICE was delivered, and the turn continued past
      // it. Quoting the chosen option back is what makes "delivered" separable
      // from "dismissed" — and picking the other option would produce the other
      // string, so this cannot pass by accident.
      await expect(transcript(page)).toContainText('ANSWER-RECEIVED: Vitest', {
        timeout: SERVER_ROUND_TRIP_MS,
      });
      await expect(transcript(page)).not.toContainText('ANSWER-RECEIVED: Jest');

      // The prompt stops being answerable — no radio group left over a question
      // that has already been answered.
      //
      // Deliberately NOT `question-prompt-submitted`, which is the transient
      // live summary: the scenario ends the turn immediately after the answer,
      // and the rebuild from history replaces that row — so asserting it is a
      // race against the turn closing. It lost that race once in 3 repeats.
      await expect(group).toHaveCount(0, { timeout: SERVER_ROUND_TRIP_MS });
    });
  });

  test.describe('a parked prompt survives a reload (I-05)', () => {
    test('a question is still there, and still answerable, after a hard refresh', async ({
      page,
      request,
    }) => {
      const { chatPage } = await openScenario(page, request, 'question-prompt');
      await chatPage.sendAndLand('set up the tests');

      const question = 'Which test runner should I set up?';
      await expect(page.getByRole('radiogroup', { name: question })).toBeVisible({
        timeout: SERVER_ROUND_TRIP_MS,
      });

      // The refresh. Everything the browser held is gone; the card has to come
      // back from the session's own cold snapshot or not at all.
      await page.reload();
      await chatPage.basePage.waitForAppReady();

      const group = page.getByRole('radiogroup', { name: question });
      await expect(group).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      await expect(group.getByText('Vitest')).toBeVisible();

      // Still parked — the reload did not answer it on the person's behalf.
      await expect(transcript(page)).not.toContainText('ANSWER-RECEIVED');

      // And answering the RECOVERED card still reaches the agent: the choice is
      // quoted back, which the other option would not produce.
      await group.getByRole('radio', { name: /Vitest/ }).click();
      await page.getByRole('button', { name: /^Submit/ }).click();
      await expect(transcript(page)).toContainText('ANSWER-RECEIVED: Vitest', {
        timeout: SERVER_ROUND_TRIP_MS,
      });
      await expect(group).toHaveCount(0, { timeout: SERVER_ROUND_TRIP_MS });
    });

    test('a tool approval is still there, and still answerable, after a hard refresh', async ({
      page,
      request,
    }) => {
      const { chatPage } = await openScenario(page, request, 'approval-gated');
      await chatPage.sendAndLand('edit the release notes');

      await expect(page.getByTestId('tool-approval')).toBeVisible({
        timeout: SERVER_ROUND_TRIP_MS,
      });

      await page.reload();
      await chatPage.basePage.waitForAppReady();

      const card = page.getByTestId('tool-approval');
      await expect(card).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      await expect(card).toContainText('Edit notes/release.md');
      await expect(transcript(page)).not.toContainText('APPROVED-BRANCH');

      await card.getByRole('button', { name: /^Approve(?!\s+All)/ }).click();
      await expect(transcript(page)).toContainText('APPROVED-BRANCH', {
        timeout: SERVER_ROUND_TRIP_MS,
      });
      // And the RECOVERED card closes behind the answer, like the live one does.
      // A recovery that restores an unanswerable-but-still-showing card would
      // satisfy every assertion above this line.
      await expect(card).toHaveCount(0, { timeout: SERVER_ROUND_TRIP_MS });
    });
  });

  test.describe('a question nobody answered, reopened later (I-07)', () => {
    test('a reload after the turn closes says nobody answered, not "answered"', async ({
      page,
      request,
    }) => {
      const { chatPage, sessionId } = await openScenario(page, request, 'question-expires');
      await chatPage.sendAndLand('set up the tests');

      const question = 'Which test runner should I set up?';
      await expect(page.getByRole('radiogroup', { name: question })).toBeVisible({
        timeout: SERVER_ROUND_TRIP_MS,
      });

      // Nobody answers. The step barrier stands in for the ten-minute timer,
      // and everything downstream of it is the production path: the same
      // `interaction_cancelled`/`timeout` the real handler fires, through the
      // same normalizer and projector.
      await releaseStep(request, sessionId);
      await expect(transcript(page)).toContainText('MOVED-ON', {
        timeout: SERVER_ROUND_TRIP_MS,
      });

      // The reload is the whole point. Past `turn_end` the page is served from
      // RECONSTRUCTED HISTORY rather than a replayed live turn — which is
      // exactly where an unanswered question used to come back wearing a green
      // "Question answered" (DOR-1293).
      await page.reload();
      await chatPage.basePage.waitForAppReady();

      const row = page.getByTestId('question-prompt-unanswered');
      await expect(row).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      await expect(row).toHaveAttribute('data-outcome', 'expired');
      await expect(row).toContainText('Nobody answered in time');

      // And the lie is gone rather than merely reworded: the answered summary
      // carries its own test id, and no receipt claims an answer exists.
      await expect(page.getByTestId('question-prompt-submitted')).toHaveCount(0);
      await expect(transcript(page)).not.toContainText('Question answered');
      // Nor is it drawn as a PERMISSION receipt — "Expired — denied" over a
      // question nobody was asked to approve is the other half of the same bug.
      await expect(page.getByTestId('approval-receipt')).toHaveCount(0);
    });
  });

  test.describe('MCP elicitation — a server asking for input (I-04)', () => {
    test('the prompt renders and an accepted value reaches the agent', async ({
      page,
      request,
    }) => {
      const { chatPage } = await openScenario(page, request, 'elicitation-prompt');
      await chatPage.sendAndLand('deploy the release');

      // The card names the server doing the asking and what it wants.
      const feed = transcript(page);
      await expect(feed.getByText('deploy-tools')).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      await expect(feed.getByText('requests input')).toBeVisible();
      await expect(feed.getByText('Which environment should this release go to?')).toBeVisible();

      await expect(feed).not.toContainText('ELICITATION-ACCEPTED');

      // The form field is labelled by the requested schema's `description` —
      // the client's form builder uses `prop.description ?? key` and ignores
      // `title` entirely (`ElicitationPrompt.tsx`).
      await page.getByLabel('Environment').fill('staging');
      await page.getByRole('button', { name: /^Accept\b/ }).click();

      // The VALUE the person typed reached the agent — not merely an acceptance.
      await expect(feed).toContainText('ELICITATION-ACCEPTED: staging', {
        timeout: SERVER_ROUND_TRIP_MS,
      });
    });

    test('Decline is carried as a refusal', async ({ page, request }) => {
      const { chatPage } = await openScenario(page, request, 'elicitation-prompt');
      await chatPage.sendAndLand('deploy the release');

      const feed = transcript(page);
      await expect(feed.getByText('requests input')).toBeVisible({
        timeout: SERVER_ROUND_TRIP_MS,
      });
      await page.getByRole('button', { name: /^Decline\b/ }).click();

      await expect(feed).toContainText('ELICITATION-DECLINE', { timeout: SERVER_ROUND_TRIP_MS });
      await expect(feed).not.toContainText('ELICITATION-ACCEPTED');
    });
  });
}
