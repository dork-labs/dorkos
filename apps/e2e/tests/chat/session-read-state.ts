/**
 * Chat read state follows the reader between devices (spec `team-room-home` §D4,
 * ADR 260808-140956, DOR-1040).
 *
 * Rooms have had this covered since P3 (`tests/rooms/read-state-cross-device.spec.ts`)
 * and a session had not, even though both read the same `read_cursors` table and
 * both draw from the same `read_cursor` broadcast. What was missing is the half
 * no unit test can reach: two real browsers, one live SSE connection each, and a
 * rule that has to move on one screen because somebody read on the other.
 *
 * **Why this is a module and not a spec file.** These tests belong to
 * `chat-mock.spec.ts`, which registers them ({@link registerSessionReadStateTests}).
 * The test-mode server is shared mutable state: `POST /api/test/reset` disposes
 * every tracked session AND deletes its durable rows, and that file calls it
 * before every one of its tests. Playwright schedules separate spec FILES onto
 * concurrent workers, so a session-transcript suite living in its own spec would
 * have its transcript deleted out from under it mid-run — the single-spec
 * constraint `playwright.config.ts` states, meant for exactly this. Registering
 * from here puts these tests on that file's worker, in that file's order, while
 * keeping them findable under the feature they test.
 *
 * **So the `.ts` extension is load-bearing, and `tests/chat/` is the reason.**
 * Every other file in this directory is a `*.spec.ts` that runs on the COCKPIT
 * leg, against the real Claude Code runtime — where a driven turn bills the
 * machine's own `claude` sign-in. This suite drives four turns per test. Naming
 * it `*.spec.ts` would hand all of them to that leg, so the cockpit project also
 * names this file's basename in its `testIgnore` as a second lock. A neighbour
 * module added here inherits neither: check both before you write one.
 *
 * @module tests/chat/session-read-state
 */
import { test, expect, request as apiRequest } from '@playwright/test';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ChatPage } from '../../pages/ChatPage.js';

/**
 * How long to give an assertion that cannot pass until the server answers.
 *
 * The same ceiling `fixtures/rooms-api.ts` argues for, for the same reason: a
 * web-first assertion returns the moment it is satisfied, so this costs nothing
 * on an idle machine, and what it buys is survival on one that is several
 * worktrees deep in concurrent agents.
 */
const SERVER_ROUND_TRIP_MS = 30_000;

/**
 * Padding that makes one message far taller than the list's 80px row estimate.
 *
 * Load-bearing, not decoration. `MessageList` lands a conversation that has an
 * unread rule ON the rule rather than at the end, and being at the end is what
 * marks a session read — so a transcript short enough to fit the viewport would
 * leave every device pinned to the bottom, marking itself read the moment it
 * opened. The second device's rule would then clear for a reason that has
 * nothing to do with the first device, and this suite would pass against a
 * broadcast that was never sent.
 *
 * Six repeats is not a screenful on its own — it wraps to five or six lines,
 * something like 140px. What matters is that it is far past the list's 80px row
 * estimate and that eight of them together overrun the viewport comfortably,
 * which is what leaves a device landed on the rule with real scroll below it.
 */
const TALL_LINE = 'This line pads the message so its row stands far taller than the estimate. ';

/**
 * One seeded prompt: a word to find it by, then enough bulk to fill a viewport.
 *
 * @param word - The distinctive first word, unique within a session.
 */
function tallPrompt(word: string): string {
  return `${word} ${TALL_LINE.repeat(6)}`;
}

/**
 * A message in the rendered transcript, found by its prompt's distinctive word.
 *
 * Scoped by role because the `simple-text` scenario answers `Echo: <prompt>` —
 * so every word appears twice, once in what the person sent and once in what
 * came back.
 *
 * @param page - The cockpit to look in.
 * @param role - Which side of the exchange.
 * @param word - The prompt's distinctive first word.
 */
function messageOf(page: Page, role: 'user' | 'assistant', word: string): Locator {
  return page.locator(`[data-testid="message-item"][data-role="${role}"]`).filter({
    hasText: word,
  });
}

/**
 * How far down the page something is drawn.
 *
 * Position is read from geometry rather than DOM order because the list is
 * virtualized: rows are absolutely positioned, so where a row SITS is the only
 * honest reading of where the rule was placed.
 *
 * @param locator - The element to measure. Must be on screen.
 */
async function topOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('Expected an element on screen, but it was not rendered');
  return box.y;
}

/**
 * How many messages this session's transcript holds, as the SERVER reads it back.
 *
 * @param api - The test-mode server's origin.
 * @param request - An API context.
 * @param sessionId - The session to read.
 * @param agentDir - The session's working directory, which the route bounds-checks.
 */
async function historyCount(
  api: string,
  request: APIRequestContext,
  sessionId: string,
  agentDir: string
): Promise<number> {
  const res = await request.get(
    `${api}/api/sessions/${sessionId}/messages?cwd=${encodeURIComponent(agentDir)}`
  );
  if (!res.ok()) throw new Error(`Reading the transcript of ${sessionId} answered ${res.status()}`);
  const { messages } = (await res.json()) as { messages: unknown[] };
  return messages.length;
}

/**
 * Drive one scripted turn per word and return once the transcript holds them all.
 *
 * Turns are driven over the API rather than through a composer because this
 * suite is about read state, not about sending — and because a browser that
 * sends is a browser sitting at the bottom of its list, which marks the session
 * read and destroys the very state under test.
 *
 * Sequential and awaited to completion: a session takes one turn at a time, and
 * `POST /messages` answers 202 before the turn has run, so a caller that fired
 * them together would collect 409s. The poll after each turn is what makes
 * "seeded" mean stored rather than accepted.
 *
 * @param api - The test-mode server's origin.
 * @param request - An API context.
 * @param sessionId - The session to build.
 * @param agentDir - The seeded agent's directory, which the turn runs in.
 * @param words - One distinctive word per turn. Each yields a user message and
 *   the `simple-text` scenario's `Echo:` reply, so the transcript ends up twice
 *   this long.
 */
async function seedTurns(
  api: string,
  request: APIRequestContext,
  sessionId: string,
  agentDir: string,
  words: string[]
): Promise<void> {
  const before = await historyCount(api, request, sessionId, agentDir);
  for (const [index, word] of words.entries()) {
    const res = await request.post(`${api}/api/sessions/${sessionId}/messages`, {
      data: { content: tallPrompt(word), cwd: agentDir, agentPath: agentDir },
    });
    if (res.status() !== 202) {
      throw new Error(`Turn "${word}" answered ${res.status()}: ${await res.text()}`);
    }
    await expect
      .poll(() => historyCount(api, request, sessionId, agentDir), {
        timeout: SERVER_ROUND_TRIP_MS,
        message: `turn "${word}" was accepted but never reached the transcript`,
      })
      .toBe(before + (index + 1) * 2);
  }
}

/**
 * Where the server says this person has read up to in a session, or null.
 *
 * The route only ever answers about its CALLER, and an API context carries no
 * agent header — so the cursor read here is the same local human's the browser
 * writes. That is the whole reason the two can be compared at all.
 *
 * @param api - The test-mode server's origin.
 * @param request - An API context.
 * @param sessionId - The session to read.
 */
async function storedCursor(
  api: string,
  request: APIRequestContext,
  sessionId: string
): Promise<number | null> {
  const res = await request.get(`${api}/api/read-cursors/session/${sessionId}`);
  if (!res.ok()) throw new Error(`Reading the cursor of ${sessionId} answered ${res.status()}`);
  const { cursor } = (await res.json()) as { cursor: { lastReadSeq: number } | null };
  return cursor?.lastReadSeq ?? null;
}

/**
 * Put this person's cursor part-way through a session, the way a device they
 * read on yesterday would have left it.
 *
 * Seeded over the API rather than by driving a first browser, because the store
 * is monotonic: a cockpit that read the session to build it could never be wound
 * back to a partial position afterwards.
 *
 * @param api - The test-mode server's origin.
 * @param request - An API context.
 * @param sessionId - The session to mark.
 * @param lastReadSeq - How many messages count as read.
 */
async function seedCursor(
  api: string,
  request: APIRequestContext,
  sessionId: string,
  lastReadSeq: number
): Promise<void> {
  const res = await request.put(`${api}/api/read-cursors/session/${sessionId}`, {
    data: { lastReadSeq },
  });
  if (!res.ok()) {
    throw new Error(`Seeding the cursor of ${sessionId} answered ${res.status()}`);
  }
}

/**
 * Register the cross-device session read-state tests into the calling spec file.
 *
 * **Two contexts, not two pages in one** — the same argument the rooms spec
 * makes. A context has its own storage, and this cursor USED to live in
 * `localStorage`, which is exactly the bug the shared table fixed; a test that
 * shared a profile could pass against a cursor that never left the browser.
 *
 * **What makes the live assertion mean something.** `use-unread-cursor` reads
 * the stored cursor exactly once per session open and never polls. The second
 * cockpit issues no mutation of its own and never reloads. So the only thing
 * that can move its rule is the `read_cursor` frame arriving on its global event
 * stream — remove the broadcast and this goes red.
 *
 * No real runtime and no API key: every turn comes from the `simple-text`
 * scenario, on the test-mode leg.
 *
 * @param options - How to reach the test-mode server, and where its seeded agent
 *   is. `agentDir` is a getter because the caller's `beforeEach` is what seeds
 *   the agent, and it runs after this registration.
 */
export function registerSessionReadStateTests(options: {
  apiUrl: string;
  agentDir: () => string;
}): void {
  const { apiUrl: api } = options;

  test.describe('Read state in a session — one mark, every device', () => {
    // Two cockpits per test, each loading a session of eight tall messages.
    test.describe.configure({ timeout: 120_000 });

    test('reading to the end on one device takes the rule down on the other', async ({
      browser,
      page,
      request,
    }) => {
      const agentDir = options.agentDir();
      const sessionId = randomUUID();
      await seedTurns(api, request, sessionId, agentDir, ['alpha', 'bravo', 'charlie', 'delta']);
      // Read as far as the first reply and no further, so both devices open with
      // a rule to draw. Two is the number asserted below, not "some" — a rule in
      // a different place is a different bug.
      await seedCursor(api, request, sessionId, 2);

      // Device one: the fixture's own page.
      await new ChatPage(page).goto(sessionId, { dir: agentDir });
      const ruleA = page.getByTestId('unread-divider');
      await expect(ruleA).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      // Where the rule SITS, not merely that it exists: after the first reply and
      // before the second prompt. That is the stored position of 2, read back
      // through the placement rules and drawn.
      expect(await topOf(ruleA)).toBeGreaterThan(
        await topOf(messageOf(page, 'assistant', 'alpha'))
      );
      expect(await topOf(ruleA)).toBeLessThan(await topOf(messageOf(page, 'user', 'bravo')));

      const secondDevice = await browser.newContext();
      try {
        const pageB = await secondDevice.newPage();
        await new ChatPage(pageB).goto(sessionId, { dir: agentDir });

        const ruleB = pageB.getByTestId('unread-divider');
        // Both screens agree where the reader left off before anybody reads
        // further. Asserting the POSITION on both is what stops this passing
        // against a second cockpit that drew no transcript at all — "no rule"
        // would otherwise be indistinguishable from "no messages".
        await expect(ruleB).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
        expect(await topOf(ruleB)).toBeGreaterThan(
          await topOf(messageOf(pageB, 'assistant', 'alpha'))
        );
        expect(await topOf(ruleB)).toBeLessThan(await topOf(messageOf(pageB, 'user', 'bravo')));

        // The guard that keeps this test honest: device two must NOT be sitting
        // at the bottom of its own list. A list pinned to the bottom marks itself
        // read, and its rule would then clear on its own — passing this test with
        // the broadcast deleted. The jump affordance renders only while the
        // reader is away from the end, so its presence is that claim.
        await expect(pageB.getByRole('button', { name: 'Scroll to bottom' })).toBeVisible();

        // Read the rest on device one. Reaching the end is what moves the cursor.
        await page.getByRole('button', { name: 'Scroll to bottom' }).click();
        await expect(page.getByRole('button', { name: 'Scroll to bottom' })).toBeHidden();
        // Asked as its own step so a failure says which half broke: the reader
        // never recorded the position, or the other device never heard about it.
        // It cannot make the next assertion pass on its own — nothing but the
        // broadcast reaches device two.
        await expect
          .poll(() => storedCursor(api, request, sessionId), {
            timeout: SERVER_ROUND_TRIP_MS,
            message: 'reading to the end never moved the stored cursor',
          })
          .toBe(8);

        // And device two puts its rule away, having been told. Deliberately no
        // `pageB.reload()` between the click and this line: a reload would prove
        // only that the server stored the cursor, which the route tests already
        // say. What is on trial here is the live path.
        await expect(ruleB).toHaveCount(0, { timeout: SERVER_ROUND_TRIP_MS });

        // Device one keeps its own rule, which is not an oversight: the rule a
        // reader is looking at must not vanish under them, so `use-unread-cursor`
        // ignores the echo of its own write. Asserted so that a change which
        // "tidies" it away has to argue with a test.
        await expect(ruleA).toBeVisible();
      } finally {
        await secondDevice.close();
      }
    });

    test('a device opening cold lands the rule where the other one stopped', async ({
      browser,
    }) => {
      // The other half of "one mark": durability, and a POSITION rather than a
      // yes/no. The test above proves the rule moves live; this one proves the
      // thing it moved to is stored per PERSON and not per browser — a fresh
      // context, which has never seen this session and holds no storage of its
      // own, must open knowing exactly how far the first device got.
      const agentDir = options.agentDir();
      const sessionId = randomUUID();
      // The suite's own API context rather than the `request` fixture, because
      // this test owns no page and the seeding outlives both of its browsers.
      const seeder = await apiRequest.newContext();
      try {
        await seedTurns(api, seeder, sessionId, agentDir, ['alpha', 'bravo', 'charlie', 'delta']);

        const firstDevice = await browser.newContext();
        try {
          // Device one reads the whole thing by opening it: with no cursor there
          // is no rule, so the list lands at the end — and being at the end is
          // what records it.
          const pageA = await firstDevice.newPage();
          await new ChatPage(pageA).goto(sessionId, { dir: agentDir });
          await expect(messageOf(pageA, 'assistant', 'delta')).toBeVisible({
            timeout: SERVER_ROUND_TRIP_MS,
          });
          await expect
            .poll(() => storedCursor(api, seeder, sessionId), {
              timeout: SERVER_ROUND_TRIP_MS,
              message: 'opening a session at its end never recorded it as read',
            })
            .toBe(8);
        } finally {
          // Closed BEFORE the conversation moves on. Left open, device one would
          // follow the two new turns down its own live stream, mark those read
          // too, and leave device two nothing to be behind on.
          await firstDevice.close();
        }

        await seedTurns(api, seeder, sessionId, agentDir, ['indigo', 'juliet']);

        const laterDevice = await browser.newContext();
        try {
          const pageB = await laterDevice.newPage();
          await new ChatPage(pageB).goto(sessionId, { dir: agentDir });

          const ruleB = pageB.getByTestId('unread-divider');
          await expect(ruleB).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
          // Cold, from a store this browser has never written to: the rule is
          // neither above everything (what "this reader has read nothing" looks
          // like) nor absent (what "all caught up" looks like), but exactly after
          // the eighth message — the position device one left it at.
          expect(await topOf(ruleB)).toBeGreaterThan(
            await topOf(messageOf(pageB, 'assistant', 'delta'))
          );
          expect(await topOf(ruleB)).toBeLessThan(await topOf(messageOf(pageB, 'user', 'indigo')));
        } finally {
          await laterDevice.close();
        }
      } finally {
        await seeder.dispose();
      }
    });
  });
}
