import type { Page, Route } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { LocalBrowserPage } from '../../pages/LocalBrowserPage';

/**
 * The Agent browser's status pill in the real app (DOR-4428). Only the browser's own
 * routes are faked, with made-up pages: plain Chromium has no native page to drive,
 * and the server's take-over lock has its own tests. What this proves is the app:
 * the pill's words, its real Radix popover, and that using the chrome while an agent
 * drives takes the page in one call, with no confirm.
 */

const ASKED_AT = '2026-11-15T11:58:00.000Z';

type BrowserState = Record<string, unknown> & { takenOver: boolean; paused: boolean };

function drivenBy(sessionId: string): BrowserState {
  return {
    connectionId: 'c1',
    sessionId,
    mode: 'new-window',
    status: 'connected',
    paused: false,
    tabs: [{ id: 't1', url: 'https://northwind.example/pricing', title: 'Pricing' }],
    selectedTabId: 't1',
    revision: 1,
    preparation: null,
    handoff: null,
    signIn: null,
    takenOver: false,
  };
}

/**
 * Open a chat with one finished turn, share a made-up page with it, and open its
 * Agent browser panel. Returns every POST the panel made to the browser.
 */
async function chatWithBrowser(
  page: Page,
  chatPage: { goto: (id?: string, opts?: { dir: string }) => Promise<void> } & {
    sendMessage: (text: string) => Promise<void>;
  },
  initial: (sessionId: string) => BrowserState = drivenBy
) {
  const seed = await page.request.post('/api/test/seed-agent');
  expect(seed.ok()).toBe(true);
  const { agentDir } = (await seed.json()) as { agentDir: string };
  await page.request.patch('/api/config', {
    data: { onboarding: { dismissedAt: new Date().toISOString() } },
  });
  await chatPage.goto(undefined, { dir: agentDir });
  await chatPage.sendMessage('Compare the team plans on the pricing page.');
  await expect(page.getByTestId('transcript-feed').getByText(/Echo:/).first()).toBeVisible();
  const sessionId = new URL(page.url()).searchParams.get('session')!;
  const posts: string[] = [];
  let state = initial(sessionId);
  await page.route('**/api/local-browser/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/capabilities')) return route.fallback();
    if (route.request().method() === 'POST') {
      posts.push(path.replace('/api/local-browser', ''));
      // What the server does: a person's navigation or Take over locks the agent out.
      if (path.endsWith('/navigate') || path.endsWith('/take-over'))
        state = { ...state, paused: true, takenOver: true };
      if (path.endsWith('/resume')) state = { ...state, paused: false, takenOver: false };
      if (path.endsWith('/handoff/hand-back'))
        state = {
          ...state,
          paused: false,
          handoff: { ...(state.handoff as object), outcome: 'handed-back' },
        };
    }
    return route.fulfill({ json: state });
  });
  await page.reload();
  const browser = new LocalBrowserPage(page);
  await browser.open();
  return { browser, posts, sessionId };
}

const pill = (page: Page) => page.locator('[data-slot="browser-status-pill"]');

test.describe('Agent browser status pill', () => {
  // Every test uses the seeded agent's one chat, so they take turns.
  test.describe.configure({ mode: 'default', timeout: 60_000 });

  test('Reload while the agent drives takes the page in one step, with no confirm', async ({
    page,
    chatPage,
  }) => {
    const { browser, posts } = await chatWithBrowser(page, chatPage);
    await expect(pill(page)).toHaveAttribute('data-state-kind', 'driving');
    await expect(pill(page)).toHaveAccessibleName(/is using this page\.$/);
    await browser.controls.getByRole('button', { name: 'Reload', exact: true }).click();
    await expect(pill(page)).toHaveAttribute('data-state-kind', 'you');
    expect(posts).toEqual(['/navigate']);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(
      browser.controls.locator('[role="status"]', { hasText: /^You have the page\./ })
    ).toHaveText(/can’t see it until you hand it back\.$/);
  });

  test('Enter while the agent is paused takes the page too', async ({ page, chatPage }) => {
    const { browser, posts } = await chatWithBrowser(page, chatPage, (id) => ({
      ...drivenBy(id),
      paused: true,
    }));
    await expect(pill(page)).toHaveAttribute('data-state-kind', 'paused');
    await browser.controls.getByRole('button', { name: /^Address:/ }).click();
    const field = browser.controls.getByRole('textbox', { name: 'Address', exact: true });
    await field.fill('northwind.example/plans');
    await field.press('Enter');
    await expect(pill(page)).toHaveAttribute('data-state-kind', 'you');
    expect(posts).toEqual(['/navigate']);
  });

  test('Take over and Hand back from the popover', async ({ page, chatPage }) => {
    const { posts } = await chatWithBrowser(page, chatPage);
    await pill(page).click();
    // A real Radix popover, which the native page's layer rule hides the page under.
    await expect(page.locator('[data-radix-popper-content-wrapper]')).toHaveCount(1);
    await page.getByRole('button', { name: 'Take over', exact: true }).click();
    await expect(pill(page)).toHaveAttribute('data-state-kind', 'you');
    await pill(page).click();
    await page.getByRole('button', { name: /^Hand back to / }).click();
    await expect(pill(page)).toHaveText('Handed back');
    await expect(pill(page)).toHaveAttribute('data-state-kind', 'driving', { timeout: 8_000 });
    expect(posts).toEqual(['/take-over', '/resume']);
  });

  test('Your turn names the host DorkOS read, never a lookalike the agent wrote', async ({
    page,
    chatPage,
  }) => {
    const { posts } = await chatWithBrowser(page, chatPage, (id) => ({
      ...drivenBy(id),
      mode: 'embedded',
      paused: true,
      // During a handoff the server sends each tab cut to its site, with no title.
      tabs: [{ id: 't1', url: 'https://attacker.example', title: '' }],
      handoff: {
        id: 'h1',
        sessionId: id,
        // An agent picks its own name; a hostile one picks a bank's.
        agentName: 'your-bank.example',
        agentId: null,
        agentFolder: null,
        profileId: null,
        reason: 'password',
        site: 'attacker.example',
        askedAt: ASKED_AT,
        outcome: null,
      },
    }));
    await expect(pill(page)).toHaveAttribute('data-state-kind', 'your-turn');
    await expect(pill(page)).toHaveText('Your turn');
    await expect(pill(page)).toHaveAccessibleName(
      'your-bank.example needs you to sign in to attacker.example.'
    );
    await pill(page).click();
    await page.getByRole('button', { name: 'Hand back to your-bank.example' }).click();
    await expect(pill(page)).toHaveText('Handed back');
    expect(posts).toEqual(['/handoff/hand-back']);
  });

  test('at 390 the popover is a bottom sheet with its buttons on screen', async ({
    page,
    chatPage,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chatWithBrowser(page, chatPage);
    await pill(page).click();
    const sheet = page.locator('[data-slot="drawer-content"]');
    await expect(sheet).toBeVisible();
    for (const name of ['Take over', 'Pause agent'])
      await expect(sheet.getByRole('button', { name, exact: true })).toBeInViewport();
  });
});
