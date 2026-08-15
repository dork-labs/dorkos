/**
 * Compaction, end to end — the boundary a person can see (capability L-04,
 * `meta/chat-capabilities.md`; DOR-1215).
 *
 * The row this file exists for shipped long ago and was reachable by nobody.
 * `/compact` dispatched, the runtime yielded a `compact_boundary`, the server
 * projected and persisted it — and then it rendered NOWHERE: the client store
 * dropped it from the live turn (it was missing from `TURN_EVENT_TYPES`, so
 * `foldCompactBoundary`/`CompactBoundaryRow` were never reached), and the
 * event-log history fold dropped it again on reload, so a log-backed runtime
 * lost it permanently. Every unit test around it passed the whole time, because
 * each proved its own link: the mapper mapped, the schema validated, the
 * component rendered when handed a part, the fold folded when handed an event.
 * Nothing joined them up. That is precisely the seam a browser test owns, and
 * why the old coverage — "the palette row is enabled" — could never have caught
 * it: it asserted that the command could be OFFERED, never that running it did
 * anything.
 *
 * **Why this is a module and not a spec file.** Same lock as
 * `session-read-state.ts` (read its header): these belong to
 * `chat-mock.spec.ts`, which registers them
 * ({@link registerCompactionTests}). The test-mode server is shared mutable
 * state and that file's `POST /api/test/reset` runs before each of its tests,
 * so a suite living in its own spec file would be reset out from under itself
 * by a concurrent worker. The `.ts` extension is load-bearing for a second
 * reason: every `*.spec.ts` under `tests/chat/` runs on the COCKPIT leg against
 * the real Claude Code runtime, where each driven turn bills the machine's own
 * `claude` sign-in. The cockpit project also names this basename in its
 * `testIgnore` as a second lock.
 *
 * @module tests/chat/compaction
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { ChatPage } from '../../pages/ChatPage.js';

/**
 * How long to give an assertion that cannot pass until the server answers.
 *
 * The same ceiling the rooms fixtures argue for: a web-first assertion returns
 * the moment it is satisfied, so this costs nothing on an idle machine, and
 * what it buys is survival on one that is several worktrees deep in concurrent
 * agents.
 */
const SERVER_ROUND_TRIP_MS = 30_000;

/**
 * Run `/compact` the way a person does, and prove the request actually left.
 *
 * Typing `/compact` opens the inline palette; Enter there SELECTS the row,
 * which fills the composer rather than sending, so a second Enter is what
 * submits. That two-step is easy to get wrong in a way no assertion downstream
 * would name: a test that pressed Enter once drove no compaction at all and
 * then failed on a missing boundary, which reads exactly like the product bug
 * this file is about. So the dispatch is observed directly — the trigger route
 * is trigger-only (202) and everything else arrives over the session stream, so
 * this request IS the boundary between "the test asked" and "the product
 * answered" (the DOR-1213 lesson: prove the thing, not a proxy for it).
 *
 * @param page - The page holding an open session.
 * @param chatPage - Its page object.
 */
async function runCompact(page: Page, chatPage: ChatPage): Promise<void> {
  const dispatched = page.waitForResponse(
    (res) => res.url().includes('/command-intents/compact') && res.request().method() === 'POST',
    { timeout: SERVER_ROUND_TRIP_MS }
  );

  await chatPage.openCommandPalette('/compact');
  await page.keyboard.press('Enter');
  await chatPage.input.press('Enter');

  const response = await dispatched;
  // 202: accepted and detached. Anything else and the compaction never ran, so
  // say so here rather than letting it surface as an absent row.
  expect(response.status(), 'POST /command-intents/compact must be accepted').toBe(202);
}

/** Register the compaction suite onto `chat-mock.spec.ts`'s worker. */
export function registerCompactionTests(ctx: { apiUrl: string; agentDir: () => string }): void {
  test.describe('Compaction — the boundary a person can see (L-04)', () => {
    test('running /compact draws the boundary, keeps the history above it, and the next turn still answers', async ({
      page,
    }) => {
      const chatPage = new ChatPage(page);
      await chatPage.goto(undefined, { dir: ctx.agentDir() });

      // Something to compact. The transcript-scoped locator is deliberate: an
      // assistant's words are in the DOM twice while the turn is live, once in
      // the message and once in the screen-reader announcer, and a bare
      // getByText resolves to two elements and fails on its FIRST poll (see
      // GOTCHAS — it reproduces only on a runner slow enough for the announcer
      // to adopt, which is CI and not this machine).
      const feed = page.getByTestId('transcript-feed');
      await chatPage.sendMessage('said before the compaction');
      await expect(feed.getByText(/Echo: said before the compaction/)).toBeVisible({
        timeout: SERVER_ROUND_TRIP_MS,
      });

      await runCompact(page, chatPage);

      // The LIVE row is deliberately not asserted here — it is transient (the
      // turn ends at once, the client reconciles against canonical history, and
      // the durable row below replaces it), so an assertion on it from a
      // command that cannot be held open is racing the handover rather than
      // testing it. The sibling test holds a compaction open and pins the live
      // row and the handover there; this one follows the boundary through to
      // the transcript it has to survive in.

      // The conversation ABOVE the boundary is still there. Compaction summarizes
      // the model's context; it does not erase the transcript a person is reading.
      //
      // `exact` on the prompt, because the scenario answers `Echo: <prompt>` —
      // so the loose form matches the person's line AND the agent's, and
      // Playwright treats that strict-mode violation as non-retriable rather
      // than waiting it out.
      await expect(feed.getByText('said before the compaction', { exact: true })).toBeVisible();
      await expect(feed.getByText(/Echo: said before the compaction/)).toBeVisible();

      // AFTER A RELOAD, from history alone — the half the server fold dropped.
      // A different component draws it here (the durable `compaction` message
      // rebuilt from the event log, not the live turn's part), so this is a
      // separate claim from the live row the sibling test pins, and it is the
      // one that decides whether a compaction is still there tomorrow.
      await page.reload();
      await chatPage.basePage.waitForAppReady();

      const durableRow = page.getByTestId('compaction-row');
      await expect(durableRow).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      // The readings the boundary carried, all the way to the rule a person
      // reads: what it cost, and who asked for it. This row is stable (it is
      // reconstructed history, not a live turn), so it is where the detail is
      // pinned rather than on the transient row above.
      await expect(durableRow).toHaveText('Context compacted · 51.2k tokens · manual');
      // …and the history above it came back with it, in order.
      await expect(feed.getByText('said before the compaction', { exact: true })).toBeVisible();
      await expect(feed.getByText(/Echo: said before the compaction/)).toBeVisible();

      // And the session is not wedged: the turn after a compaction answers like
      // any other. A compaction takes the session write-lock, so a lock left
      // held would show up precisely here and nowhere earlier.
      await chatPage.sendMessage('said after the compaction');
      await expect(feed.getByText(/Echo: said after the compaction/)).toBeVisible({
        timeout: SERVER_ROUND_TRIP_MS,
      });
      // Both sides of the boundary on screen at once — which is the whole claim.
      await expect(page.getByTestId('compaction-row')).toBeVisible();
      await expect(feed.getByText('said before the compaction', { exact: true })).toBeVisible();
    });

    test('an auto-compaction fired by context pressure says so, and survives the reload', async ({
      page,
      request,
    }) => {
      // The other trigger, and the one nobody can drive by hand: an auto
      // compaction happens TO you. `compacting-hold` is a turn that compacts
      // instead of answering, in the Claude adapter's own event shape (progress
      // started → boundary → progress done), and then STAYS OPEN until this
      // test ends it — which is what makes the live row observable rather than
      // a flash this assertion has to win a race against.
      // Checked, not fired and forgotten: a rejected scenario leaves the server
      // on `simple-text`, and this test would then fail on a missing boundary —
      // naming the row rather than the setup that never took (DOR-1213).
      const scenarioSet = await request.post(`${ctx.apiUrl}/api/test/scenario`, {
        data: { name: 'compacting-hold' },
      });
      expect(
        scenarioSet.ok(),
        `could not select the compacting-hold scenario (${scenarioSet.status()}): ${await scenarioSet.text()}`
      ).toBe(true);

      const chatPage = new ChatPage(page);
      await chatPage.goto(undefined, { dir: ctx.agentDir() });
      await chatPage.sendMessage('this turn compacts instead of answering');

      // LIVE, while the turn is still open — the half the client store dropped.
      // Removing `compact_boundary` from its TURN_EVENT_TYPES reddens here and
      // nowhere else, because the durable row below is built by the server from
      // a different path entirely.
      const liveRow = page.getByTestId('compact-boundary-row');
      await expect(liveRow).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      await expect(liveRow).toContainText('Compacted context — 51.2k → 4.2k tokens');
      // `auto`, not `manual`. The badge is the only thing that tells a reader
      // the machine did this rather than them, and the two are one enum apart
      // the whole way down from the SDK — so a boundary that arrived with the
      // wrong one, or none, would still draw a perfectly convincing rule.
      await expect(page.getByTestId('compact-boundary-trigger')).toHaveText('auto');

      // Now end the turn and watch the HANDOVER: the live row gives way to the
      // durable one. Both rows exist for the same boundary and are drawn by
      // different components from different sources, and the seam between them
      // is where a compaction could go missing without either component being
      // wrong — which is exactly what used to happen.
      await request.post(`${ctx.apiUrl}/api/test/finish-turn`);
      const durableRow = page.getByTestId('compaction-row');
      await expect(durableRow).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      await expect(liveRow).toHaveCount(0);

      // And it is durable in the sense that matters: it comes back from history
      // alone, with nothing of the live turn left to draw it.
      await page.reload();
      await chatPage.basePage.waitForAppReady();
      await expect(durableRow).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      // `auto`, not `manual`. The trigger is the only thing that tells a reader
      // the machine did this rather than them, and the two are one enum apart
      // the whole way down from the SDK — so a boundary that arrived with the
      // wrong one, or with none, would still draw a perfectly convincing rule.
      await expect(durableRow).toHaveText('Context compacted · 51.2k tokens · auto');
    });
  });
}
