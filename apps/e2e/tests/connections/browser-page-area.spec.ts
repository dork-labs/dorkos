import type { Page, Route } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { LocalBrowserPage } from '../../pages/LocalBrowserPage';

/**
 * The Agent browser's page area when there is no page to show (DOR-4433): one
 * centred block in the panel, instead of a stack of hints above it. Only the
 * browser's own state is intercepted, with made-up chats and pages.
 */

const NOT_OPEN = {
  connectionId: null,
  sessionId: null,
  mode: null,
  status: 'disconnected',
  paused: false,
  tabs: [],
  selectedTabId: null,
  revision: 0,
  preparation: null,
  signIn: null,
  handoff: null,
  takenOver: false,
};

/** Open a chat whose browser reports `state`, then its Agent browser panel. */
async function panelWith(
  page: Page,
  chatPage: { goto: (id?: string, opts?: { dir: string }) => Promise<void> },
  state: (sessionId: string) => Record<string, unknown>
) {
  const seed = await page.request.post('/api/test/seed-agent');
  expect(seed.ok()).toBe(true);
  const { agentDir } = (await seed.json()) as { agentDir: string };
  await page.request.patch('/api/config', {
    data: { onboarding: { dismissedAt: new Date().toISOString() } },
  });
  await chatPage.goto(undefined, { dir: agentDir });
  const sessionId = new URL(page.url()).searchParams.get('session') ?? 'this-chat';
  await page.route('**/api/local-browser/**', async (route: Route) => {
    const url = new URL(route.request().url()).pathname;
    if (url.endsWith('/capabilities') || url.endsWith('/profiles')) return route.fallback();
    return route.fulfill({ json: state(sessionId) });
  });
  await page.reload();
  const browser = new LocalBrowserPage(page);
  await browser.open();
  return browser;
}

const block = (browser: LocalBrowserPage) =>
  browser.controls.locator('[data-slot="local-browser-page-area-block"]');

test.describe('Agent browser page area', () => {
  // Every test uses the seeded agent's one chat, so they take turns.
  test.describe.configure({ mode: 'default', timeout: 60_000 });

  test('not open: one centred block, and nothing stacked above it', async ({ page, chatPage }) => {
    const browser = await panelWith(page, chatPage, () => NOT_OPEN);
    await expect(block(browser)).toHaveCount(1);
    // The first status is the block's own line; Forget keeps a quiet one of its own.
    await expect(block(browser).getByRole('status').first()).toHaveText('Not open yet');
    await expect(browser.controls.getByRole('heading', { name: 'Agent browser' })).toHaveCount(0);
    const open = block(browser).getByRole('button', { name: 'Open browser', exact: true });
    await expect(open).toBeVisible();
    // Centred in the panel: the block's middle sits near the panel's middle.
    const panel = (await browser.controls.boundingBox())!;
    const inner = (await block(browser).locator(':scope > div').boundingBox())!;
    expect(inner.width).toBeLessThanOrEqual(360);
    const offset = Math.abs(inner.x + inner.width / 2 - (panel.x + panel.width / 2));
    expect(offset).toBeLessThan(4);
    await expect(
      block(browser).getByRole('button', { name: 'Forget saved sign-ins…', exact: true })
    ).toBeVisible();
  });

  test('another chat has it: the block names that chat and offers Take it here', async ({
    page,
    chatPage,
  }) => {
    const browser = await panelWith(page, chatPage, () => ({
      ...NOT_OPEN,
      connectionId: 'c1',
      sessionId: 'another-chat',
      mode: 'new-window',
      status: 'connected',
      tabs: [{ id: 't1', url: 'https://northwind.example/fares', title: 'Fares' }],
      selectedTabId: 't1',
    }));
    await expect(block(browser).getByText('This browser is open in another chat')).toBeVisible();
    await expect(block(browser).getByRole('button', { name: 'Take it here' })).toBeVisible();
    // The page's own title never shows in this chat.
    await expect(browser.controls.getByText('Fares')).toHaveCount(0);
  });

  test('at 390 the block and its buttons stay on screen', async ({ page, chatPage }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const browser = await panelWith(page, chatPage, () => NOT_OPEN);
    for (const name of ['Open browser', 'Forget saved sign-ins…'])
      await expect(block(browser).getByRole('button', { name, exact: true })).toBeInViewport();
  });
});
