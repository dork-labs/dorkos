/**
 * A prompt raised in one session is answerable from a route that is not it
 * (DOR-1330, spec `unified-conversation` §3–§4).
 *
 * This is the claim the whole phase exists to make, and it is the one no unit
 * test can make: the card has to reach a surface the session is not on, an
 * answer given there has to reach the runtime, and the agent has to carry on.
 *
 * **What makes it able to fail.** The `approval-gated` scenario genuinely parks
 * on the answer and then streams a branch-naming sentence — `APPROVED-BRANCH`
 * for a yes, `DENIED-BRANCH` for a no. So "the card went away" is never the
 * assertion. A product that dismissed the card in the header and dropped the
 * answer on the floor passes every visual check here and fails the last one.
 *
 * **What it deliberately does NOT cover, and where that is covered instead.**
 * The room half — a prompt from a room-bound session appearing on that room's
 * live lane — needs a room, an agent bound into it, and a turn dispatched by the
 * room runner, none of which this leg seeds. The filter itself is unit-tested
 * (`RoomLiveLane` reads `roomId`), the join is server-tested
 * (`session-list-broadcaster-asks`), and the whole path was walked in a browser
 * against a real room for the phase's acceptance check (see
 * `specs/unified-conversation/04-implementation.md`).
 *
 * **Why this is a module and not a spec file.** The same lock
 * `interactive-prompts.ts` documents: these tests belong to `chat-mock.spec.ts`,
 * whose `POST /api/test/reset` tears down every tracked session, and Playwright
 * schedules separate spec FILES onto concurrent workers — so a parked turn
 * living beside it would be disposed mid-assertion.
 *
 * @module tests/conversation/ask-anywhere
 */
import { test, expect } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { ChatPage } from '../../pages/ChatPage.js';

/** How long to give an assertion that cannot pass until the server answers. */
const SERVER_ROUND_TRIP_MS = 30_000;

/** Inputs the registering spec file supplies. */
export interface AskAnywhereDeps {
  /** Base URL of the test-mode API leg. */
  apiUrl: string;
  /** The seeded agent's directory, read fresh per test (the fixture reseeds). */
  agentDir: () => string;
}

/**
 * Register the answer-from-anywhere suite onto the calling spec file's worker.
 *
 * @param deps - The test-mode API base URL and the seeded agent directory.
 */
export function registerAskAnywhereTests(deps: AskAnywhereDeps): void {
  const { apiUrl, agentDir } = deps;

  /** The header's standing marker for "an agent is waiting on you". */
  const pill = (page: Page) => page.getByTestId('inbox-bell');

  /** One Ask card, wherever it is drawn. */
  const askCard = (page: Page) => page.getByTestId('interaction-ask');

  /**
   * Open a chat, let it settle on a session, and park it on an approval.
   *
   * Session-scoped scenario binding, for the reason `interactive-prompts.ts`
   * gives at length: this turn parks on a barrier only this test releases, and
   * as the server-wide default it would be handed to a neighbour's turn.
   *
   * @param page - The page to drive.
   * @param request - The API context used to bind the scenario.
   */
  async function parkOnApproval(
    page: Page,
    request: APIRequestContext
  ): Promise<{ chatPage: ChatPage; sessionId: string }> {
    const chatPage = new ChatPage(page);
    await chatPage.goto(undefined, { dir: agentDir() });
    await expect
      .poll(() => new URL(page.url()).searchParams.get('session'), {
        timeout: SERVER_ROUND_TRIP_MS,
      })
      .not.toBeNull();
    const sessionId = new URL(page.url()).searchParams.get('session') as string;

    const bound = await request.post(`${apiUrl}/api/test/scenario`, {
      data: { name: 'approval-gated', sessionId },
    });
    expect(bound.ok(), 'could not bind scenario approval-gated').toBe(true);

    // `sendAndLand`, not `sendMessage`: the composer is controlled, and a fill
    // that lands before the session hydrates is silently reverted — which
    // surfaces thirty seconds later as a missing CARD rather than a missing
    // send. See its own docstring for the full argument.
    await chatPage.sendAndLand('add the release checklist', SERVER_ROUND_TRIP_MS);
    await expect(page.getByTestId('tool-approval')).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    return { chatPage, sessionId };
  }

  test.describe('a prompt is answerable from anywhere', () => {
    test('the header counts it on another route, and answering there lets the agent carry on', async ({
      page,
      request,
    }) => {
      const { sessionId } = await parkOnApproval(page, request);

      // Leave the session entirely. This is the case the whole feature exists
      // for: before it, the question existed only inside the conversation that
      // asked it, and a person on another route was never told.
      await page.goto('/tasks');
      await expect(pill(page)).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      await expect(pill(page)).toContainText('1');

      // Answer it here, on a route that knows nothing about that session.
      await pill(page).click();
      const card = askCard(page).first();
      await expect(card).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      await expect(card).toContainText(/wants to edit/i);
      await card.getByRole('button', { name: 'Allow' }).click();

      // The receipt, where the answer was given.
      await expect(page.getByText(/You allowed this/)).toBeVisible({
        timeout: SERVER_ROUND_TRIP_MS,
      });
      // And the marker stops sounding the alarm, because nothing is waiting any
      // more. It does NOT have to disappear: the marker is the Inbox bell now
      // (DOR-1384), and the Inbox still holds what happened — so what has to be
      // true is that the amber is gone, not that the button is. `data-tone` is
      // the one thing amber means: something is stopped and waiting on you.
      await expect(pill(page)).toHaveAttribute('data-tone', 'neutral', {
        timeout: SERVER_ROUND_TRIP_MS,
      });
      await expect(pill(page)).not.toContainText('waiting on you');

      // The assertion that cannot be faked by a card disappearing: the agent
      // said the thing only an approval could have produced.
      const chatPage = new ChatPage(page);
      await chatPage.goto(sessionId, { dir: agentDir() });
      await expect(page.getByText(/APPROVED-BRANCH/)).toBeVisible({
        timeout: SERVER_ROUND_TRIP_MS,
      });
    });

    test('A answers the card the reader is standing on, and the agent carries on', async ({
      page,
      request,
    }) => {
      // The keyboard half, in a real engine with real key events. `A` is handled
      // ON the card, so it only ever fires while focus is inside one — which is
      // what stops an Ask that lands while somebody is typing from swallowing a
      // letter. The unit suite pins the negative half against `document.body`;
      // this pins that the positive half genuinely answers a live prompt.
      const { sessionId } = await parkOnApproval(page, request);
      await page.goto('/tasks');
      await expect(pill(page)).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      await pill(page).click();

      const card = askCard(page).first();
      await expect(card).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      await card.focus();
      // The claim is about focus, so it is asserted rather than assumed.
      expect(await card.evaluate((element) => element.contains(document.activeElement))).toBe(true);

      await page.keyboard.press('a');

      await expect(page.getByText(/You allowed this/)).toBeVisible({
        timeout: SERVER_ROUND_TRIP_MS,
      });

      // And the agent carried on, which is the half a vanished card cannot fake.
      const chatPage = new ChatPage(page);
      await chatPage.goto(sessionId, { dir: agentDir() });
      await expect(page.getByText(/APPROVED-BRANCH/)).toBeVisible({
        timeout: SERVER_ROUND_TRIP_MS,
      });
    });
  });
}
