/**
 * A prompt nobody answered in time WAITS, and is still answerable (DOR-1350,
 * spec `ask-parks-on-timeout`).
 *
 * The park is a visual state that spans four things no unit test sees at once:
 * the server's derivation of `parked` from `startedAt` and the declared budget,
 * the fan-out that carries it, the store that holds it, and the card that draws
 * it. So it is walked here, in a browser, end to end — including a reload
 * mid-park, the one path where the transcript's own card is rebuilt from the
 * recovery snapshot rather than from the live turn.
 *
 * **What makes it able to fail.** The `approval-parks` scenario raises its
 * prompt with `timeoutMs: 0`, so the SERVER's own selector — the real one, not a
 * scenario-authored flag — has to decide the prompt is parked before the card
 * can say so. And the scenario genuinely holds the decision: it streams
 * `ANSWERED-LATE` only for an approval and `DECLINED-LATE` only for a refusal,
 * so "the card went away" is never the assertion.
 *
 * **Why this is a module and not a spec file.** The same lock
 * `interactive-prompts.ts` documents at length: these tests belong to
 * `chat-mock.spec.ts`, whose `POST /api/test/reset` tears down every tracked
 * session, and Playwright schedules separate spec FILES onto concurrent workers
 * — so a parked turn living beside it would be disposed mid-assertion. A
 * `*.spec.ts` here would also run on the COCKPIT leg against the real runtime,
 * where a driven turn bills the machine's own sign-in.
 *
 * @module tests/conversation/ask-parks
 */
import { test, expect } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { ChatPage } from '../../pages/ChatPage.js';

/** How long to give an assertion that cannot pass until the server answers. */
const SERVER_ROUND_TRIP_MS = 30_000;

/** Inputs the registering spec file supplies. */
export interface AskParksDeps {
  /** Base URL of the test-mode API leg. */
  apiUrl: string;
  /** The seeded agent's directory, read fresh per test (the fixture reseeds). */
  agentDir: () => string;
}

/**
 * Register the parked-Ask suite onto the calling spec file's worker.
 *
 * @param deps - The test-mode API base URL and the seeded agent directory.
 */
export function registerAskParksTests(deps: AskParksDeps): void {
  const { apiUrl, agentDir } = deps;

  /** The header's standing marker for "an agent is waiting on you". */
  const pill = (page: Page) => page.getByTestId('approvals-indicator');

  /** One Ask card, wherever it is drawn. */
  const askCard = (page: Page) => page.getByTestId('interaction-ask');

  /**
   * Open a chat, let it settle on a session, and park it on a prompt whose
   * countdown has already run out.
   *
   * @param page - The page to drive.
   * @param request - The API context used to bind the scenario.
   */
  async function parkOnAnsweredNothing(
    page: Page,
    request: APIRequestContext
  ): Promise<{ sessionId: string }> {
    const chatPage = new ChatPage(page);
    await chatPage.goto(undefined, { dir: agentDir() });
    await expect
      .poll(() => new URL(page.url()).searchParams.get('session'), {
        timeout: SERVER_ROUND_TRIP_MS,
      })
      .not.toBeNull();
    const sessionId = new URL(page.url()).searchParams.get('session') as string;

    const bound = await request.post(`${apiUrl}/api/test/scenario`, {
      data: { name: 'approval-parks', sessionId },
    });
    expect(bound.ok(), 'could not bind scenario approval-parks').toBe(true);

    await chatPage.sendAndLand('add the release checklist', SERVER_ROUND_TRIP_MS);
    await expect(page.getByTestId('tool-approval')).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    return { sessionId };
  }

  test.describe('a prompt nobody answered in time', () => {
    test('says the agent is waiting, draws no countdown, and still takes an answer', async ({
      page,
      request,
    }) => {
      const { sessionId } = await parkOnAnsweredNothing(page, request);

      // RELOAD MID-PARK, first, because this is the shape that shipped a lie:
      // the recovery snapshot carries a parked DTO with no budget and a
      // remainder to the four-hour ceiling, and the transcript card read that
      // as a countdown — "228:59 remaining", with a draining bar, over a prompt
      // the agent was quietly holding.
      await page.reload();
      await new ChatPage(page).basePage.waitForAppReady();
      const inlineCard = page.getByTestId('tool-approval');
      await expect(inlineCard).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      await expect(inlineCard).toContainText('waiting for you');
      await expect(inlineCard).not.toContainText('remaining');
      await expect(inlineCard.locator('[data-slot="ask-countdown"] [aria-hidden]')).toHaveCount(0);

      // The fleet-wide surfaces are where the parked DTO is drawn, so this
      // leaves the session the way a person who walked away would.
      await page.goto('/tasks');
      await expect(pill(page)).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      await pill(page).click();

      const card = askCard(page).first();
      await expect(card).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

      // Where the timer was, the card says the agent is waiting — and there is
      // no draining bar, because a parked prompt ships no budget to draw one
      // against. The bar is the only `aria-hidden` node inside the countdown.
      const countdown = card.locator('[data-slot="ask-countdown"]');
      await expect(countdown).toContainText('waiting for you');
      await expect(countdown).not.toContainText('expired');
      await expect(countdown.locator('[aria-hidden]')).toHaveCount(0);

      // Both answers are still live. The failure mode is a card that LOOKS
      // finished while the agent is still holding the tool call.
      await expect(card.locator('[data-slot="ask-allow"]')).toBeVisible();
      await expect(card.locator('[data-slot="ask-deny"]')).toBeVisible();

      await card.getByRole('button', { name: 'Allow' }).click();

      // The receipt, where the answer was given.
      await expect(page.getByText(/You allowed this/)).toBeVisible({
        timeout: SERVER_ROUND_TRIP_MS,
      });

      // And the assertion no vanished card can fake: the agent took the answer
      // it was handed, and never went down the refusal branch.
      const chatPage = new ChatPage(page);
      await chatPage.goto(sessionId, { dir: agentDir() });
      await expect(page.getByText(/ANSWERED-LATE/)).toBeVisible({
        timeout: SERVER_ROUND_TRIP_MS,
      });
      await expect(page.getByTestId('transcript-feed')).not.toContainText('DECLINED-LATE');
    });
  });
}
