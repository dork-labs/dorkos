/**
 * The operator's ruling, in a browser: **what you write in shows up in Today**
 * (DOR-1156).
 *
 * Today's order key is `max(userLastMessageAt, userLastOpenedAt)` (spec
 * `sidebar-now-today-library` BC-16), and until this change the only thing that
 * ever wrote the client half was a click on a sidebar row. So a conversation
 * reached any other way — a deep link, a bookmark, the home surface — could be
 * typed into at length and then vanish from Today the moment the operator
 * looked at something else. That is what was reported, in live use.
 *
 * **Only a browser can answer it.** The claim spans a jsdom-hostile chain: a
 * real send over the durable stream, a persisted store in real `localStorage`,
 * a real navigation away from the conversation, and a sidebar rebuilt from
 * scratch on the other side of it. Every unit test of the pieces can be green
 * with the product broken, because the thing that broke is the seam.
 *
 * **The door is deliberately one that records nothing.** `ChatPage.goto` is a
 * deep link — no sidebar row is clicked, no palette entry is picked — so the
 * send is the only signal there is. Deleting the write in
 * `use-session-submit.ts` reddens both assertions below.
 *
 * **Why this is a module and not a spec file.** Same reason as
 * `now-survives-reload.ts` beside it: it belongs to `chat-mock.spec.ts`, whose
 * test-mode leg answers a turn for free and deterministically. The `.ts`
 * extension is load-bearing — a `*.spec.ts` here would run on the COCKPIT leg,
 * where driving a turn bills the machine's own `claude` sign-in.
 *
 * @module tests/dashboard-sidebar/send-lands-in-today
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { BasePage } from '../../pages/BasePage.js';
import { ChatPage } from '../../pages/ChatPage.js';
import { DashboardSidebarPage } from '../../pages/DashboardSidebarPage.js';

/** Ceiling for an assertion that cannot pass until the server answers. */
const SERVER_ROUND_TRIP_MS = 30_000;

/** What {@link registerSendLandsInTodayTests} needs from its host spec. */
export interface SendLandsInTodayDeps {
  /** The seeded agent's directory, read lazily — the host seeds it per test. */
  agentDir: () => string;
}

/**
 * Register the "a send puts it in Today" tests on `chat-mock.spec.ts`'s worker.
 *
 * @param deps - The host spec's seeded agent directory.
 */
export function registerSendLandsInTodayTests({ agentDir }: SendLandsInTodayDeps): void {
  test.describe('Sidebar Today — what you write in shows up', () => {
    /**
     * Open a brand-new conversation by DEEP LINK and write one sentence in it.
     *
     * Two things about this path are load-bearing. **The deep link records
     * nothing** — no sidebar row is clicked, no palette entry picked — so what
     * Today knows afterwards it learned from the send. And **the id is minted
     * here** rather than left to `?dir=` alone, because `?dir=` resumes that
     * directory's most recent conversation instead of starting one — so two
     * calls would write both sentences into a single session and the ordering
     * case below would have nothing to order.
     *
     * A client-minted id is also what a runtime re-keys, but **this leg never
     * exercises that**: `retiredSessionId` is emitted by claude-code's message
     * sender alone, and `TestModeRuntime` keeps the id it was given. The carry
     * onto a canonical id is covered in units instead — both routes, each with
     * its own case, in `features/chat/__tests__/send-records-interaction`.
     *
     * @param page - The page to drive.
     * @param text - The sentence to send. It becomes the session's title, which
     *   is how the row is found again later.
     */
    async function openFreshAndWrite(page: Page, text: string): Promise<void> {
      const chat = new ChatPage(page);
      await chat.goto(crypto.randomUUID(), { dir: agentDir() });
      await chat.sendMessage(text);
      // The turn has to finish before the next one starts: the title is derived
      // from the first message server-side, and the row is found by it.
      await expect(page.getByTestId('message-list')).toContainText(text, {
        timeout: SERVER_ROUND_TRIP_MS,
      });
    }

    test('a conversation you only wrote in is still in Today after you walk away', async ({
      page,
    }) => {
      const marker = `lemon tree ${Date.now()}`;
      await openFreshAndWrite(page, marker);

      const sidebar = new DashboardSidebarPage(page);
      const base = new BasePage(page);
      await base.ensureSidebarOpen();

      // Half one: the row is there while the conversation is open. On its own
      // this proves nothing — BC-21 gives the OPEN conversation a row whatever
      // the store says — but without it a green second half could mean the row
      // was never drawn at all.
      await expect(sidebar.todayRows.filter({ hasText: marker })).toHaveCount(1, {
        timeout: SERVER_ROUND_TRIP_MS,
      });

      // Half two: walk away. Home anchors nothing, so the anchor rule is gone
      // and the interaction record the SEND wrote is the only thing that can
      // keep the row. This is the assertion the report was about.
      await page.goto('/');
      await base.waitForAppReady();
      await base.ensureSidebarOpen();

      await expect(sidebar.todayRows.filter({ hasText: marker })).toHaveCount(1, {
        timeout: SERVER_ROUND_TRIP_MS,
      });
    });

    test('Today is ordered by when you wrote, newest first', async ({ page }) => {
      const older = `first thing ${Date.now()}`;
      const newer = `second thing ${Date.now()}`;
      await openFreshAndWrite(page, older);
      await openFreshAndWrite(page, newer);

      const sidebar = new DashboardSidebarPage(page);
      const base = new BasePage(page);
      await page.goto('/');
      await base.waitForAppReady();
      await base.ensureSidebarOpen();

      // Both rows, and the one written in last is above the one written in
      // first. Membership alone would be satisfied by a rule that put every
      // session in Today; the ORDER is what says the key is the operator's own
      // act (BC-16).
      await expect(sidebar.todayRows.filter({ hasText: newer })).toHaveCount(1, {
        timeout: SERVER_ROUND_TRIP_MS,
      });
      await expect(sidebar.todayRows.filter({ hasText: older })).toHaveCount(1);
      // Lower-cased on both sides: the server's title deriver capitalizes the
      // first letter of the sentence it was given, so a row's text is not the
      // marker verbatim.
      const drawn = (await sidebar.todayRows.allInnerTexts()).map((row) => row.toLowerCase());
      const at = (needle: string) => drawn.findIndex((row) => row.includes(needle.toLowerCase()));
      expect(at(older), 'the older conversation has a row at all').toBeGreaterThanOrEqual(0);
      expect(at(newer), 'the conversation written in last comes first').toBeLessThan(at(older));
    });
  });
}
