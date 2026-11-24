import type { Page, Route } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { fakeBrowserState } from '../../pages/fake-browser-state';

/**
 * The Agent browser handoff card in the real app. Only the browser's own state and
 * answers are intercepted: a real handoff needs a real agent and a real wall, and
 * those are covered by the server's own tests and QA's matrix.
 */

const ASKED_AT = '2026-11-03T14:30:00.000Z';

function handoffState(sessionId: string, reason: 'wall' | 'password') {
  return fakeBrowserState({
    connectionId: 'c1',
    sessionId,
    mode: 'new-window',
    status: 'connected',
    paused: true,
    tabs: [{ id: 't1', url: 'https://northwind.example/fares', title: 'Fares' }],
    selectedTabId: 't1',
    revision: 1,
    handoff: {
      id: 'h1',
      sessionId,
      agentName: 'Atlas',
      agentId: null,
      agentFolder: '/home/sam/agents/atlas',
      profileId: null,
      reason,
      site: 'northwind.example',
      askedAt: ASKED_AT,
      outcome: null,
    },
  });
}

/** Open a chat with one finished turn, and hand its browser to the person. */
async function chatWithHandoff(
  page: Page,
  chatPage: { goto: (id?: string, opts?: { dir: string }) => Promise<void> } & {
    sendMessage: (text: string) => Promise<void>;
  },
  reason: 'wall' | 'password',
  { windowClosed = false } = {}
) {
  const seed = await page.request.post('/api/test/seed-agent');
  expect(seed.ok()).toBe(true);
  const { agentDir } = (await seed.json()) as { agentDir: string };
  await page.request.patch('/api/config', {
    data: { onboarding: { dismissedAt: new Date().toISOString() } },
  });
  await chatPage.goto(undefined, { dir: agentDir });
  await chatPage.sendMessage('Find the cheapest fare to Lisbon.');
  await expect(page.getByTestId('transcript-feed').getByText(/Echo:/).first()).toBeVisible();
  const sessionId = new URL(page.url()).searchParams.get('session')!;
  const asked = handoffState(sessionId, reason);
  let state = windowClosed
    ? fakeBrowserState({ ...asked, status: 'closed', tabs: [], selectedTabId: null })
    : asked;
  await page.route('**/api/local-browser/**', async (route: Route) => {
    const url = new URL(route.request().url()).pathname;
    if (url.endsWith('/capabilities')) return route.fallback();
    if (route.request().method() === 'POST') {
      if (url.endsWith('/open')) state = asked;
      if (url.endsWith('/handoff/hand-back') || url.endsWith('/handoff/stop'))
        state = {
          ...state,
          handoff: state.handoff && {
            ...state.handoff,
            outcome: url.endsWith('stop') ? 'stopped' : 'handed-back',
          },
        };
    }
    return route.fulfill({ json: state });
  });
  await page.reload();
  return { sessionId };
}

const card = (page: Page) => page.locator('[data-slot="browser-handoff-card"]').first();

test.describe('Agent browser handoff card', () => {
  // Every test uses the seeded agent's one chat, so they take turns.
  test.describe.configure({ mode: 'default', timeout: 60_000 });

  test('sits above the composer, outside the transcript, and names the site, agent and folder', async ({
    page,
    chatPage,
  }) => {
    await chatWithHandoff(page, chatPage, 'wall');
    await expect(card(page)).toBeVisible();
    await expect(
      card(page).getByRole('heading', { name: 'northwind.example wants a person to continue' })
    ).toBeVisible();
    await expect(card(page).getByText('Atlas is paused')).toBeVisible();
    await expect(card(page).getByText('~/agents/atlas')).toBeVisible();
    // An agent can write a message that looks like a card, but not into this slot.
    await expect(
      page.getByTestId('transcript-feed').locator('[data-slot="browser-handoff-card"]')
    ).toHaveCount(0);
  });

  test('at 390 the closed-window card keeps its buttons on screen', async ({ page, chatPage }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chatWithHandoff(page, chatPage, 'wall', { windowClosed: true });
    for (const name of ['Open window', 'Stop task'])
      await expect(card(page).getByRole('button', { name })).toBeInViewport();
    await expect(chatPage.input).toBeInViewport();
  });

  test('at 390 the composer stays usable and every button is on screen', async ({
    page,
    chatPage,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chatWithHandoff(page, chatPage, 'wall');
    for (const name of ['Continue', 'Show window', 'Stop task'])
      await expect(card(page).getByRole('button', { name })).toBeInViewport();
    await expect(chatPage.input).toBeInViewport();
  });

  test('with both open, answering either clears the card and the Inbox item together', async ({
    page,
    chatPage,
  }) => {
    await chatWithHandoff(page, chatPage, 'wall');
    await page.getByRole('button', { name: /wants a person to continue/ }).click();
    await expect(page.locator('[data-slot="browser-handoff-card"]')).toHaveCount(2);
    await page
      .locator('[data-slot="browser-handoff-inbox-item"]')
      .getByRole('button', { name: 'Continue' })
      .click();
    await expect(page.locator('[data-slot="browser-handoff-card"]')).toHaveCount(0);
  });
});
