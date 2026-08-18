/**
 * The persistent path, driven through a browser for free (DOR-1326).
 *
 * Backs five rows of `meta/chat-capabilities.md`:
 *
 * - **L-11** — an agent that stays running, so the second reply comes from the
 *   same process.
 * - **C-09a** — a chat that cannot cut in is not offered the choice, and an API
 *   steer says why instead of going quiet.
 * - **C-09b** — a steer INTO a live turn: it reaches the running agent, renders
 *   inline where the person sent it, and opens no second turn.
 * - **C-11** — Add context: the words reach the agent without provoking a reply,
 *   on both the native route and the fold.
 * - **C-10 (pump scope)** — Stop on a turn running on a held process settles
 *   honestly, and the process survives it.
 *
 * ## Why these had no browser coverage until now
 *
 * All four are claims about a session that HOLDS its agent process between
 * messages, and until this ticket the only runtime a browser test can drive for
 * free declared it never did. Worse, test-mode steered every open turn — so the
 * one shape the persistent path keeps getting wrong, **a capable runtime paired
 * with a session that cannot use the capability**, could not be staged here at
 * all. That is the shape DOR-1268 shipped (a Steer offered on a session with
 * nothing to cut into) and DOR-1307 shipped again (an Add context that booted a
 * process nobody asked for). A claude-code leg would reproduce them and spend
 * real tokens on every run, which CI cannot do.
 *
 * So test-mode holds a scripted process now, per session, behind
 * `POST /api/test/persistent`. Each suite below drives BOTH sides of its row:
 * the held session, and the same session on the resume path, which must degrade
 * rather than pretend. Every assertion names a marker only one of the two paths
 * can produce (`HELD-PROCESS-TURN-2`, `staged-native:` versus `staged-folded:`),
 * so a spec that quietly ran on the other path goes red instead of passing.
 *
 * **Why a module and not a spec file**, and why the `.ts` extension is
 * load-bearing: see the header of `live-turn-visibility.ts`. Same two locks —
 * the mock server is global mutable state that `POST /api/test/reset` wipes for
 * everyone, and every `*.spec.ts` under `tests/chat/` also runs on the COCKPIT
 * leg against a real, billable runtime.
 *
 * @module tests/chat/held-process
 */
import { test, expect } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { ChatPage } from '../../pages/ChatPage.js';

/** See the note in `live-turn-visibility.ts` — a ceiling, not a delay. */
const SERVER_ROUND_TRIP_MS = 30_000;

/** Inputs the registering spec file supplies. */
export interface HeldProcessDeps {
  /** Base URL of the test-mode API leg. */
  apiUrl: string;
  /** The seeded agent's directory, read fresh per test (the fixture reseeds). */
  agentDir: () => string;
}

/** What `GET /api/test/persistent` reports, read off the runtime's own seams. */
interface HeldState {
  enabled: boolean;
  warmth: 'cold' | 'warming' | 'warm' | 'running' | 'crashed';
  steerable: boolean;
  stageable: boolean;
}

/**
 * Register the held-process suites onto the calling spec file's worker.
 *
 * @param deps - The test-mode API base URL and the seeded agent directory.
 */
export function registerHeldProcessTests(deps: HeldProcessDeps): void {
  const { apiUrl, agentDir } = deps;

  /**
   * Open a chat, let it settle on a session, and put that session on (or off)
   * the held-process path with `scenario` bound to it.
   *
   * Both switches are session-scoped for the reason `live-turn-visibility.ts`
   * gives about scenarios, and it matters twice as much here: this leg is shared
   * by four concurrent Playwright projects, and a process-wide "keep agents
   * warm" would warm chats belonging to specs that never asked.
   *
   * @param page - The page to drive.
   * @param request - The API context used to bind the scenario and the path.
   * @param opts.scenario - The test-mode scenario name.
   * @param opts.held - Whether this session holds its process between turns.
   */
  async function openSession(
    page: Page,
    request: APIRequestContext,
    opts: { scenario: string; held: boolean }
  ): Promise<{ chatPage: ChatPage; sessionId: string }> {
    const chatPage = new ChatPage(page);
    await chatPage.goto(undefined, { dir: agentDir() });

    // Let the app SETTLE on a session id before binding anything to it — the
    // route loader decides which session the page is on, and binding to an id
    // it then re-mints leaves the scenario attached to nothing (the flake
    // `live-turn-visibility.ts` documents at length).
    await expect
      .poll(() => new URL(page.url()).searchParams.get('session'), {
        timeout: SERVER_ROUND_TRIP_MS,
      })
      .not.toBeNull();
    const sessionId = new URL(page.url()).searchParams.get('session') as string;

    const path = await request.post(`${apiUrl}/api/test/persistent`, {
      data: { sessionId, enabled: opts.held },
    });
    expect(path.ok(), 'could not set the held-process path').toBe(true);
    const bound = await request.post(`${apiUrl}/api/test/scenario`, {
      data: { name: opts.scenario, sessionId },
    });
    expect(bound.ok(), `could not bind scenario ${opts.scenario}`).toBe(true);
    return { chatPage, sessionId };
  }

  /**
   * Release ONE step barrier, waiting for the scenario to reach it first.
   *
   * Polls rather than fires blind: the step route answers `released: false`
   * until the scenario has actually parked, and a dropped step leaves the turn
   * waiting on a barrier nobody will release again — which surfaces thirty
   * seconds later as a locator timeout naming the wrong thing. Same helper, same
   * reasoning, as `live-turn-visibility.ts`.
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

  /** What the runtime says about this session's process right now. */
  async function heldState(request: APIRequestContext, sessionId: string): Promise<HeldState> {
    const res = await request.get(`${apiUrl}/api/test/persistent`, { params: { sessionId } });
    expect(res.ok(), 'could not read the session’s held-process state').toBe(true);
    return (await res.json()) as HeldState;
  }

  /** The transcript as the reader sees it — never the screen-reader announcer. */
  const transcript = (page: Page) => page.getByTestId('transcript-feed');

  /**
   * The composer, by either of the two names it wears.
   *
   * `ChatPage.input` matches only the idle one: while a turn is running the
   * field renames itself "Compose next — will send when ready", and every case
   * here types into a RUNNING turn, which is the whole point of a steer and of
   * Add context. Using the page object's locator mid-turn times out on a
   * composer that is plainly on screen — worth knowing before writing the next
   * suite that drives a live turn (it is in GOTCHAS too).
   */
  const composer = (page: Page) =>
    page.getByRole('combobox', { name: /^(message |send a message|compose next)/i });

  /** Assistant replies in the transcript; the count is how many turns answered. */
  const replies = (page: Page) =>
    page.locator('[data-testid="message-item"][data-role="assistant"]');

  /**
   * Type `text` into the composer of a STREAMING turn and pick one of the
   * alternates to Queue.
   *
   * The caret only exists while a turn is running with text in the box
   * (`InputActionButton`), and each row only exists when the verb could really
   * happen here — which is the product behaviour half these cases are about, so
   * the helper does not paper over its absence.
   *
   * @param page - The page to drive.
   * @param text - What to type.
   * @param row - The menu row to pick.
   */
  async function sendVia(page: Page, text: string, row: 'Steer' | 'Add context'): Promise<void> {
    await composer(page).fill(text);
    await page.getByRole('button', { name: 'More ways to send' }).click();
    await page.getByRole('menuitem', { name: row }).click();
  }

  test.describe('an agent that stays running between messages (L-11)', () => {
    test('the second reply comes from the process the first one left behind', async ({
      page,
      request,
    }) => {
      const { chatPage, sessionId } = await openSession(page, request, {
        scenario: 'warm-echo',
        held: true,
      });

      // Turn 1 boots the process and says so. `HELD-PROCESS-TURN-1` is not a
      // label the scenario always carries: off the held path it reads
      // `NO-HELD-PROCESS`, which is what makes every assertion here able to fail.
      await chatPage.sendAndLand('first message');
      await expect(transcript(page)).toContainText('HELD-PROCESS-TURN-1: first message', {
        timeout: SERVER_ROUND_TRIP_MS,
      });
      await releaseStep(request, sessionId);

      // Between turns the process is HELD — the state the whole idea exists for,
      // and one no product API reports because warmth is invisible to the person
      // by design.
      await expect.poll(async () => (await heldState(request, sessionId)).warmth).toBe('warm');

      // Turn 2 answers on that same process. The counter climbs only while one
      // process survives, so `TURN-2` cannot be produced by a fresh one.
      await chatPage.sendAndLand('second message');
      await expect(transcript(page)).toContainText('HELD-PROCESS-TURN-2: second message', {
        timeout: SERVER_ROUND_TRIP_MS,
      });
      await releaseStep(request, sessionId);
    });

    test('a chat that was never warmed starts fresh every time', async ({ page, request }) => {
      const { chatPage, sessionId } = await openSession(page, request, {
        scenario: 'warm-echo',
        held: false,
      });

      // The resume path, which is how a default install ships. Both turns say so,
      // and the second one is the assertion: a fixture that warmed every session
      // regardless of the opt-in would read `HELD-PROCESS-TURN-2` here.
      await chatPage.sendAndLand('first message');
      await expect(transcript(page)).toContainText('NO-HELD-PROCESS: first message', {
        timeout: SERVER_ROUND_TRIP_MS,
      });
      await releaseStep(request, sessionId);

      await chatPage.sendAndLand('second message');
      await expect(transcript(page)).toContainText('NO-HELD-PROCESS: second message', {
        timeout: SERVER_ROUND_TRIP_MS,
      });
      expect(await heldState(request, sessionId)).toMatchObject({ warmth: 'cold', enabled: false });
      await releaseStep(request, sessionId);
    });

    test('putting the agent to sleep is invisible — the next message just works', async ({
      page,
      request,
    }) => {
      const { chatPage, sessionId } = await openSession(page, request, {
        scenario: 'warm-echo',
        held: true,
      });

      await chatPage.sendAndLand('first message');
      await releaseStep(request, sessionId);
      await expect.poll(async () => (await heldState(request, sessionId)).warmth).toBe('warm');

      // The scripted stand-in for the five-minute idle reap and the warm-slot
      // eviction, neither of which a browser can wait out or provoke.
      const reaped = await request.post(`${apiUrl}/api/test/reap`, { data: { sessionId } });
      expect(reaped.ok()).toBe(true);
      expect((await heldState(request, sessionId)).warmth).toBe('cold');

      // And the person cannot tell: the next message answers normally, on a
      // fresh process that counts from one again.
      await chatPage.sendAndLand('second message');
      await expect(transcript(page)).toContainText('HELD-PROCESS-TURN-1: second message', {
        timeout: SERVER_ROUND_TRIP_MS,
      });
      await releaseStep(request, sessionId);
    });
  });

  test.describe('steering into a live turn (C-09b)', () => {
    test('a steer reaches the running turn, renders where it was sent, and opens no second turn', async ({
      page,
      request,
    }) => {
      const { chatPage, sessionId } = await openSession(page, request, {
        scenario: 'warm-echo',
        held: true,
      });
      await chatPage.sendAndLand('start something');
      await expect(transcript(page)).toContainText('HELD-PROCESS-TURN-1', {
        timeout: SERVER_ROUND_TRIP_MS,
      });
      // One reply so far — the count "no second turn" is measured against.
      await expect(replies(page)).toHaveCount(1);

      await sendVia(page, 'actually use the staging branch', 'Steer');

      // It renders INLINE, as an ordinary message at the point it arrived
      // (`turn_input`, PR #1026) — not as a queue chip, which is what a steer
      // that could not be delivered would become.
      await expect(
        page
          .locator('[data-testid="message-item"][data-role="user"]')
          .filter({ hasText: 'actually use the staging branch' })
      ).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

      // And the turn it joined is still the only turn: a steer implemented as
      // "end this turn and start another" would answer twice.
      await releaseStep(request, sessionId);
      await expect(chatPage.input).toBeEnabled({ timeout: SERVER_ROUND_TRIP_MS });
      await expect(replies(page)).toHaveCount(1);
    });
  });

  test.describe('asking to steer where a cut-in cannot happen (C-09a)', () => {
    test('the choice is not offered, and an API steer says why instead of going quiet', async ({
      page,
      request,
    }) => {
      const { chatPage, sessionId } = await openSession(page, request, {
        scenario: 'warm-echo',
        held: false,
      });
      await chatPage.sendAndLand('start something');

      // The runtime declares `supportsSteer: true` — this session simply cannot
      // take one, and the composer asks BOTH questions (DOR-1268). Typing while
      // the turn runs offers Add context and no Steer at all: hidden, never
      // greyed. `toHaveCount(0)` rather than "not visible", because a row drawn
      // and hidden is still a row that read the wrong answer.
      await composer(page).fill('cut in please');
      await page.getByRole('button', { name: 'More ways to send' }).click();
      await expect(page.getByRole('menuitem', { name: 'Add context' })).toBeVisible({
        timeout: SERVER_ROUND_TRIP_MS,
      });
      await expect(page.getByRole('menuitem', { name: 'Steer' })).toHaveCount(0);
      await page.keyboard.press('Escape');

      // A steer sent straight at the API — the path a client that ignored the
      // answer would take — is queued and SAYS SO: `not-steerable`, the reason
      // `session-idle` used to swallow. A turn is genuinely running under it,
      // which is what separates the two.
      const steered = await request.post(`${apiUrl}/api/sessions/${sessionId}/messages`, {
        data: { content: 'cut in please', cwd: agentDir(), disposition: 'steer' },
      });
      expect(steered.status()).toBe(202);
      const body = (await steered.json()) as {
        outcome: { requested: string; applied: string; degradedBecause?: string };
      };
      expect(body.outcome).toMatchObject({
        requested: 'steer',
        applied: 'queue',
        degradedBecause: 'not-steerable',
      });

      await releaseStep(request, sessionId);
    });
  });

  test.describe('adding context without provoking a reply (C-11)', () => {
    test('on a chat with a warm agent but no turn yet, the words wait for the agent — they do not become a message', async ({
      page,
      request,
    }) => {
      // The state the fake used to get wrong, and the one the pump reaches every
      // time an operator turns the experiment on and adds context before saying
      // anything (DOR-1318 saw it live). The session WOULD run its next turn on
      // a held process, so `canStageSession` says yes and the server takes the
      // native route — and a runtime that refused there with anything but
      // `unsupported` would have its words QUEUED as an ordinary message that
      // provokes a reply, which is the one thing Add context promises never to do.
      const { chatPage, sessionId } = await openSession(page, request, {
        scenario: 'warm-echo',
        held: true,
      });
      expect(await heldState(request, sessionId)).toMatchObject({
        warmth: 'cold',
        stageable: true,
      });

      const staged = await request.post(`${apiUrl}/api/sessions/${sessionId}/messages`, {
        data: { content: 'mind the rate limit', cwd: agentDir(), disposition: 'stage' },
      });
      expect(staged.status()).toBe(202);
      const body = (await staged.json()) as {
        outcome: { requested: string; applied: string; degradedBecause?: string };
      };
      // `applied: 'stage'` — it reached the agent. `applied: 'queue'` here is the
      // regression, and `degradedBecause` naming a fold would mean the words took
      // the long way round on a session that could have taken them directly.
      expect(body.outcome).toMatchObject({ requested: 'stage', applied: 'stage' });
      expect(body.outcome.degradedBecause).toBeUndefined();

      // The stage WARMED the session to reach a transcript, exactly as the pump
      // does — and it started no turn, so the transcript still has no reply in it.
      expect((await heldState(request, sessionId)).warmth).toBe('warm');
      await expect(replies(page)).toHaveCount(0);

      // And the words are there when the agent next speaks.
      await chatPage.sendAndLand('what now');
      await expect(transcript(page)).toContainText('staged-native: mind the rate limit', {
        timeout: SERVER_ROUND_TRIP_MS,
      });
      await releaseStep(request, sessionId);
    });

    test('on a warm chat the words reach the agent itself, and the next reply has them', async ({
      page,
      request,
    }) => {
      const { chatPage, sessionId } = await openSession(page, request, {
        scenario: 'warm-echo',
        held: true,
      });
      await chatPage.sendAndLand('start something');
      await expect(replies(page)).toHaveCount(1);

      await sendVia(page, 'mind the rate limit', 'Add context');

      // The quiet note, which is deliberately NOT a message bubble: nothing
      // replied to it.
      const note = page.getByTestId('staged-context-note');
      await expect(note).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      await expect(note).toContainText('mind the rate limit');
      // And it provoked no reply of its own.
      await expect(replies(page)).toHaveCount(1);

      await releaseStep(request, sessionId);
      await chatPage.sendAndLand('carry on');
      // `staged-native:` is the label for words that reached the HELD process.
      // The fold route labels itself differently, so this cannot pass on it.
      await expect(transcript(page)).toContainText('staged-native: mind the rate limit', {
        timeout: SERVER_ROUND_TRIP_MS,
      });
      await releaseStep(request, sessionId);
    });

    test('on a chat with no warm agent the words are folded into the next reply instead', async ({
      page,
      request,
    }) => {
      const { chatPage, sessionId } = await openSession(page, request, {
        scenario: 'warm-echo',
        held: false,
      });
      await chatPage.sendAndLand('start something');

      // Add context stays OFFERED here, unlike Steer, because a fold is a real
      // answer rather than a refusal (DOR-1307) — and the person is told the
      // same thing either way.
      await sendVia(page, 'mind the rate limit', 'Add context');
      const note = page.getByTestId('staged-context-note');
      await expect(note).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      await expect(note).toContainText('mind the rate limit');

      await releaseStep(request, sessionId);
      await chatPage.sendAndLand('carry on');
      // Same words, different route: the server held them and handed them to the
      // next turn as context. Nothing was lost, which is the whole claim.
      await expect(transcript(page)).toContainText('staged-folded: mind the rate limit', {
        timeout: SERVER_ROUND_TRIP_MS,
      });
      await releaseStep(request, sessionId);
    });
  });

  test.describe('Stop on a turn running on a warm agent (C-10, pump scope)', () => {
    test('the turn settles as stopped, and the agent stays up for the next message', async ({
      page,
      request,
    }) => {
      const { chatPage, sessionId } = await openSession(page, request, {
        scenario: 'stoppable-turn',
        held: true,
      });
      await chatPage.sendAndLand('start something long');

      // The turn is parked on a barrier this test never releases, so nothing but
      // Stop can end it — which makes the assertions below about Stop rather
      // than about elapsed time.
      await expect(transcript(page)).toContainText('STOPPABLE-TURN', {
        timeout: SERVER_ROUND_TRIP_MS,
      });
      expect((await heldState(request, sessionId)).warmth).toBe('running');

      const stop = page.getByRole('button', { name: 'Stop generating' });
      await expect(stop).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      await stop.click();

      // Settles honestly: the composer comes back, and no red failure card —
      // a turn the person stopped is not a turn that failed.
      await expect(stop).toBeHidden({ timeout: SERVER_ROUND_TRIP_MS });
      await expect(chatPage.inferenceStreaming).toBeHidden({ timeout: SERVER_ROUND_TRIP_MS });
      await expect(chatPage.input).toBeEnabled();
      await expect(page.getByTestId('error-message-block')).toHaveCount(0);

      // The pump-specific half: an acked Stop leaves the agent RUNNING (what the
      // 2026-08-17 flag-ON runs measured), so the next message has a warm
      // process to answer on rather than paying for a fresh one.
      await expect.poll(async () => (await heldState(request, sessionId)).warmth).toBe('warm');
    });
  });
}
