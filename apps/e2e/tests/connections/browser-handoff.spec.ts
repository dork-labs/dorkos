import type { Page, Route } from '@playwright/test';
import { test, expect } from '../../fixtures';

/**
 * The Agent browser handoff card in the real app. Only the browser's own state and
 * answers are intercepted: a real handoff needs a real agent and a real wall, and
 * those are covered by the server's own tests and QA's matrix.
 */

const ASKED_AT = '2026-11-03T14:30:00.000Z';

function handoffState(sessionId: string, reason: 'wall' | 'password') {
  return {
    connectionId: 'c1',
    sessionId,
    mode: 'new-window',
    status: 'connected',
    paused: true,
    tabs: [{ id: 't1', url: 'https://northwind.example/fares', title: 'Fares' }],
    selectedTabId: 't1',
    revision: 1,
    preparation: null,
    signIn: null,
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
  };
}

/** Open a chat with one finished turn, and hand its browser to the person. */
async function chatWithHandoff(
  page: Page,
  chatPage: { goto: (id?: string, opts?: { dir: string }) => Promise<void> } & {
    sendMessage: (text: string) => Promise<void>;
  },
  reason: 'wall' | 'password'
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
  const answers: string[] = [];
  let state: ReturnType<typeof handoffState> = handoffState(sessionId, reason);
  await page.route('**/api/local-browser/**', async (route: Route) => {
    const url = new URL(route.request().url()).pathname;
    if (url.endsWith('/capabilities')) return route.fallback();
    if (route.request().method() === 'POST') {
      answers.push(url);
      if (url.endsWith('/handoff/hand-back') || url.endsWith('/handoff/stop'))
        state = {
          ...state,
          handoff: {
            ...state.handoff,
            outcome: (url.endsWith('stop') ? 'stopped' : 'handed-back') as never,
          },
        };
    }
    return route.fulfill({ json: state });
  });
  await page.reload();
  // The seeded agent's chat carries over between tests, so what counts is what's sent now.
  const sent: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/api\/sessions\/[^/]+\/messages$/.test(request.url()))
      sent.push((request.postDataJSON() as { content: string }).content);
  });
  return { sessionId, answers, sent };
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

  test('Continue hands back and sends the agent one line a person can read', async ({
    page,
    chatPage,
  }) => {
    const { answers, sent } = await chatWithHandoff(page, chatPage, 'wall');
    await card(page).getByRole('button', { name: 'Continue' }).click();
    await expect(page.locator('[data-slot="browser-handoff-card"]')).toHaveCount(0);
    expect(answers).toContain('/api/local-browser/handoff/hand-back');
    await expect.poll(() => sent).toEqual(['I’m done in the browser. Please continue.']);
    await expect(
      page
        .getByTestId('transcript-feed')
        .getByText('I’m done in the browser. Please continue.')
        .last()
    ).toBeVisible();
  });

  test('Stop task stops it, and sends no message', async ({ page, chatPage }) => {
    const { answers, sent } = await chatWithHandoff(page, chatPage, 'wall');
    await card(page).getByRole('button', { name: 'Stop task' }).click();
    await expect(page.locator('[data-slot="browser-handoff-card"]')).toHaveCount(0);
    expect(answers).toContain('/api/local-browser/handoff/stop');
    expect(sent).toEqual([]);
  });

  test('a password page offers the plain window and no Continue', async ({ page, chatPage }) => {
    await chatWithHandoff(page, chatPage, 'password');
    await expect(
      card(page).getByRole('button', { name: 'Sign in to northwind.example' })
    ).toBeVisible();
    await expect(card(page).getByRole('button', { name: 'Continue' })).toHaveCount(0);
    await expect(card(page).getByRole('button', { name: 'Show window' })).toHaveCount(0);
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

  test('the Inbox carries the card and counts it', async ({ page, chatPage }) => {
    const { answers } = await chatWithHandoff(page, chatPage, 'wall');
    await page.getByRole('button', { name: /wants a person to continue/ }).click();
    const inboxCard = page.locator('[data-slot="browser-handoff-inbox-item"]');
    await expect(inboxCard).toBeVisible();
    await inboxCard.getByRole('button', { name: 'Stop task' }).click();
    await expect(inboxCard).toHaveCount(0);
    expect(answers).toContain('/api/local-browser/handoff/stop');
  });
});
