/**
 * What a session went through before the page loaded still reaches DorkBot
 * (DOR-1136).
 *
 * The global event stream used to carry transitions only, so a session that
 * errored before the page loaded was something a new page had simply never
 * heard about — and the ✦ Ask DorkBot seed lost its recent-errors line on a
 * reload. The stream now opens with the fleet's current state, and this proves
 * it end to end: the seed names the errored session while the page watched it
 * fail, and still names it after a fresh load.
 *
 * Only a browser can answer this. The defect lives in what a FRESH connection is
 * told, so the test does the same two things in order: prove the line is there
 * while the client watched it happen, then reload and prove it is still there.
 *
 * **Why this is a module and not a spec file.** It belongs to
 * `chat-mock.spec.ts`, which registers it: the `error` scenario is only
 * available on the test-mode leg, and that server is shared mutable state whose
 * `POST /api/test/reset` runs before every one of that file's tests. See
 * `tests/chat/session-read-state.ts` for the same reasoning at length. The `.ts`
 * extension is load-bearing — a `*.spec.ts` here would run on the COCKPIT leg,
 * where driving a turn bills the machine's own `claude` sign-in.
 *
 * @module tests/dashboard-sidebar/dorkbot-seed-survives-reload
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { BasePage } from '../../pages/BasePage.js';
import { ChatPage } from '../../pages/ChatPage.js';
import { HomeSurfacePage } from '../../pages/HomeSurfacePage.js';

/**
 * Ceiling for an assertion that cannot pass until the server answers.
 *
 * Web-first assertions return the moment they are satisfied, so this costs
 * nothing on an idle machine; what it buys is survival on one running several
 * worktrees of agents at once.
 */
const SERVER_ROUND_TRIP_MS = 30_000;

/** What {@link registerDorkBotSeedSurvivesReloadTests} needs from its host spec. */
export interface DorkBotSeedSurvivesReloadDeps {
  /** Base URL of the test-mode server, for its `/api/test/*` control routes. */
  apiUrl: string;
  /** The seeded agent's directory, read lazily — the host seeds it per test. */
  agentDir: () => string;
}

/**
 * Register the reload tests on `chat-mock.spec.ts`'s worker.
 *
 * @param deps - The host spec's server URL and seeded agent directory.
 */
export function registerDorkBotSeedSurvivesReloadTests({
  apiUrl,
  agentDir,
}: DorkBotSeedSurvivesReloadDeps): void {
  test.describe('What a session went through survives a page load', () => {
    /** Drive one session to a turn that ends in an error, and open the sidebar. */
    async function errorASession(page: Page, request: Page['request']): Promise<void> {
      await request.post(`${apiUrl}/api/test/scenario`, { data: { name: 'error' } });
      const chatPage = new ChatPage(page);
      await chatPage.goto(undefined, { dir: agentDir() });
      await chatPage.sendMessage('Break something');
      await new BasePage(page).ensureSidebarOpen();
    }

    test('the Ask DorkBot seed still names the errored session after a reload', async ({
      page,
      request,
    }) => {
      await errorASession(page, request);

      // The seed only exists at the moment of a send, so the send is what has to
      // be inspected — and then stopped. DorkBot's own seat runs on the REAL
      // runtime even on this leg (see `tests/team-room/*`'s header), so letting
      // this request through would start a turn that bills the machine's own
      // sign-in. Aborting it costs nothing the assertion needs: the seed is
      // composed client-side and is already in the body.
      let seedContext: string | undefined;
      await page.route('**/api/sessions/*/messages', async (route) => {
        seedContext = (route.request().postDataJSON() as { seedContext?: string }).seedContext;
        await route.abort();
      });

      /** Press ✦ Ask DorkBot, send once, and answer with the seed that rode it. */
      async function seedFromAskDorkBot(): Promise<string | undefined> {
        seedContext = undefined;
        // SCOPED TO THE FOOTER STRIP, which is the ✦ press this test means:
        // `{ name: 'Ask DorkBot' }` is a substring match, and the phrase is a
        // common one for a card or a suggestion to borrow.
        //
        // Through the page object rather than the raw testid: the strip already
        // has a name in `HomeSurfacePage`, and a second hand-rolled copy of the
        // selector is the thing that goes stale when the strip is renamed.
        const previousSession = new URL(page.url()).searchParams.get('session');
        await new HomeSurfacePage(page).sidebarNav
          .getByRole('button', { name: 'Ask DorkBot' })
          .click();
        await expect(page).toHaveURL(
          (url) =>
            url.pathname === '/session' &&
            url.searchParams.get('seed') === 'dorkbot-help' &&
            url.searchParams.get('draft')?.replaceAll('"', '') === '1' &&
            url.searchParams.get('session') !== previousSession
        );
        const dorkbotChat = new ChatPage(page);
        await dorkbotChat.panel.waitFor({ state: 'visible', timeout: SERVER_ROUND_TRIP_MS });
        await expect(page.getByRole('combobox', { name: /^Message DorkBot/ })).toBeVisible();
        await dorkbotChat.sendMessage('What went wrong?');
        await expect.poll(() => seedContext, { timeout: SERVER_ROUND_TRIP_MS }).toBeDefined();
        return seedContext;
      }

      // Half one: this page watched the turn fail, so the seed names it. Without
      // this the assertion below could pass on a seed that never mentions errors
      // for reasons that have nothing to do with reloading.
      expect(await seedFromAskDorkBot()).toMatch(/ended in an error/);

      // Half two: a fresh page load, which is where the line used to vanish.
      await page.goto('/');
      await new BasePage(page).waitForAppReady();
      await new BasePage(page).ensureSidebarOpen();

      expect(await seedFromAskDorkBot()).toMatch(/ended in an error/);
    });
  });
}
