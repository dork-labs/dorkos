/**
 * Heads up survives a page load (DOR-1136).
 *
 * The spec's first promised experience is "open the app with something waiting
 * → Heads up sits at the top", and it did not hold: the global event stream carried
 * transitions only, so a session that errored before the page loaded was
 * something the new page had simply never heard about. Heads up rendered zero rows
 * with work genuinely waiting, and the ✦ Ask DorkBot seed lost its recent-errors
 * line on the same reload.
 *
 * Only a browser can answer this. The defect lives in what a FRESH connection is
 * told, so every test here does the same two things in order: prove the row is
 * there while the client watched it happen, then reload and prove it is still
 * there. Without the second half the first proves nothing about the bug; without
 * the first half a green run could mean the row was never rendered at all.
 *
 * **Why this is a module and not a spec file.** It belongs to
 * `chat-mock.spec.ts`, which registers it: the `error` scenario is only
 * available on the test-mode leg, and that server is shared mutable state whose
 * `POST /api/test/reset` runs before every one of that file's tests. See
 * `tests/chat/session-read-state.ts` for the same reasoning at length. The `.ts`
 * extension is load-bearing — a `*.spec.ts` here would run on the COCKPIT leg,
 * where driving a turn bills the machine's own `claude` sign-in.
 *
 * @module tests/dashboard-sidebar/now-survives-reload
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { BasePage } from '../../pages/BasePage.js';
import { ChatPage } from '../../pages/ChatPage.js';

/**
 * Ceiling for an assertion that cannot pass until the server answers.
 *
 * Web-first assertions return the moment they are satisfied, so this costs
 * nothing on an idle machine; what it buys is survival on one running several
 * worktrees of agents at once.
 */
const SERVER_ROUND_TRIP_MS = 30_000;

/** The Heads up zone, however many rows it currently holds. */
function nowZone(page: Page) {
  return page.locator('[data-sidebar-zone="now"]');
}

/** The Heads up row a stopped session draws — the copy `select-now-items` gives it. */
function erroredRow(page: Page) {
  return nowZone(page).getByText('Stopped with an error');
}

/** The Heads up row a session waiting on a permission answer draws. */
function blockedRow(page: Page) {
  return nowZone(page).getByText('Waiting on you');
}

/** What {@link registerNowSurvivesReloadTests} needs from its host spec. */
export interface NowSurvivesReloadDeps {
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
export function registerNowSurvivesReloadTests({ apiUrl, agentDir }: NowSurvivesReloadDeps): void {
  test.describe('Sidebar Heads up — survives a page load', () => {
    /** Drive one session to a turn that ends in an error, and open the sidebar. */
    async function errorASession(page: Page, request: Page['request']): Promise<void> {
      await request.post(`${apiUrl}/api/test/scenario`, { data: { name: 'error' } });
      const chatPage = new ChatPage(page);
      await chatPage.goto(undefined, { dir: agentDir() });
      await chatPage.sendMessage('Break something');
      await new BasePage(page).ensureSidebarOpen();
    }

    test('an errored session is still in Heads up after a reload', async ({ page, request }) => {
      await errorASession(page, request);

      // Half one: the row exists while this page watched the turn fail. An
      // assertion about what survives a reload is meaningless without it.
      await expect(erroredRow(page)).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

      // Half two: the reload. The transition is now in the past, and nothing
      // will ever repeat it — a stopped session does not move again.
      await page.reload();
      await new BasePage(page).waitForAppReady();
      await new BasePage(page).ensureSidebarOpen();

      await expect(erroredRow(page)).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    });

    // The other lifecycle Heads up is built from, and the one an operator loses most
    // by not seeing: a turn parked on a permission answer stays parked, so the
    // transition that announced it is the only one there will ever be.
    test('a session waiting on a permission answer is still in Heads up after a reload', async ({
      page,
      request,
    }) => {
      // `demo-approval` deliberately never yields `done` — the turn stays
      // blocked awaiting the operator, which is the state under test.
      await request.post(`${apiUrl}/api/test/scenario`, { data: { name: 'demo-approval' } });
      const chatPage = new ChatPage(page);
      await chatPage.goto(undefined, { dir: agentDir() });
      await chatPage.sendMessage('Migrate the tokens table');
      await new BasePage(page).ensureSidebarOpen();

      await expect(blockedRow(page)).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

      await page.reload();
      await new BasePage(page).waitForAppReady();
      await new BasePage(page).ensureSidebarOpen();

      await expect(blockedRow(page)).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    });

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
        // SCOPED TO THE FOOTER STRIP, which is the ✦ press this test means.
        // Unscoped, `{ name: 'Ask DorkBot' }` is a substring match and also
        // catches the Getting-started suggestion row "Ask DorkBot anything",
        // which the sidebar draws whenever DorkBot has no session yet — true on
        // every fresh test-mode home. Two matches is a strict-mode violation,
        // so the unscoped locator was only ever passing by winning a race
        // against that row appearing.
        await page
          .getByTestId('sidebar-footer-strip-row')
          .getByRole('button', { name: 'Ask DorkBot' })
          .click();
        const dorkbotChat = new ChatPage(page);
        await dorkbotChat.panel.waitFor({ state: 'visible', timeout: SERVER_ROUND_TRIP_MS });
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
