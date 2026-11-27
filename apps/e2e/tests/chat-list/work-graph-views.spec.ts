import type { Page, Route, TestInfo } from '@playwright/test';
import { test, expect } from '../../fixtures';

/**
 * The work graph's views in a browser (W5, DOR-4971): spin-offs as a tree in
 * the chat list, an agent's pull requests on its profile, and a chat's in its
 * header.
 *
 * Every work graph read is stubbed: the tree by the playground's transport,
 * the pull requests with `page.route`. These views draw what the reads answer,
 * and the reads have their own server tests (DOR-4970). Nothing here sends a
 * message, so no turn starts and nothing is billed.
 *
 * Each case takes a screenshot at phone and desktop width into its own output
 * folder, attached to the report, for a person to look at.
 */

/** A phone and a desktop, the two widths every view must hold. */
const WIDTHS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

/** Answer a route with JSON. */
function json(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

/**
 * Save a screenshot into the test's output folder and attach it to the report,
 * once every animation that ends has ended: a sheet still sliding up, or a page
 * still fading in, is not what a person sees. A looping one (a running chat's
 * dot) never ends, so it is not waited for.
 */
async function shoot(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished)
    )
  );
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: false });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

/** Two pull requests, one opened by the chat and one by a chat below it. */
const PULL_REQUESTS = {
  items: [
    {
      ref: { kind: 'pr', id: 'dork-labs/dorkos#4412' },
      text: 'dork-labs/dorkos#4412',
      firstRecordedOn: '2026-11-25',
      links: [{ relation: 'opened', chatId: 'CHAT', recordedAt: '2026-11-25T10:00:00.000Z' }],
    },
    {
      ref: { kind: 'pr', id: 'dork-labs/marketplace#88' },
      text: 'dork-labs/marketplace#88',
      firstRecordedOn: '2026-11-24',
      links: [
        { relation: 'works_on', chatId: 'CHILD', recordedAt: '2026-11-24T09:00:00.000Z' },
        { relation: 'opened', chatId: null, recordedOn: '2026-11-24' },
      ],
    },
  ],
  nextCursor: null,
};

test.describe('the chat tree in the chat list @smoke', () => {
  // The playground's chat list, over its own seeded chats and the tree its
  // transport answers for "Plan the launch week"
  // (`apps/client/src/dev/showcases/work-graph-mock-data.ts`): three folded
  // spin-offs, one of theirs, a private joint, and three chats that have not run.
  for (const size of WIDTHS) {
    test(`opens the tree at any depth, and names each state, at ${size.name} width`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.goto('/dev/features');

      // The inline chat list, not the switcher dialog over the same chats.
      const list = page.locator('[data-slot="chat-list"]').first();
      const fold = list.getByRole('button', { name: /spin-offs? from Plan the launch week/ });
      await fold.scrollIntoViewIfNeeded();
      await fold.click();

      // The read knows chats the list cannot: one waiting to start, one that
      // never did. The count covers the whole tree, the private joint left out.
      await expect(list.getByText('Waiting to start')).toBeVisible();
      await expect(list.getByText('Didn’t start: lost in a restart')).toBeVisible();
      await expect(
        list.getByRole('button', { name: '7 spin-offs from Plan the launch week' })
      ).toBeVisible();

      // A level down, and another: each chat that started chats has a toggle.
      await list.getByRole('button', { name: '1 spin-off from Check every docs link' }).click();
      await expect(list.getByText('Fix the two broken links')).toBeVisible();
      await list.getByRole('button', { name: '1 spin-off from Fix the two broken links' }).click();
      await expect(list.getByText('A private chat')).toBeVisible();
      await list.getByRole('button', { name: '1 spin-off from A private chat' }).click();
      await expect(list.getByText('Can’t be opened')).toBeVisible();

      // Nothing in the tree pushes the page sideways on a phone.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow).toBeLessThanOrEqual(0);
      await list.getByText('Can’t be opened').scrollIntoViewIfNeeded();
      await shoot(page, testInfo, `chat-tree-${size.width}`);
    });
  }
});

test.describe('pull requests by chat and by agent', () => {
  for (const size of WIDTHS) {
    test(`the chat header and the agent's profile list them, at ${size.name} width`, async ({
      page,
      roomsApi,
      basePage,
      rightPanel,
    }, testInfo) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      const agent = await roomsApi.registerAgent(`E2E Work ${roomsApi.runId}`, '🧭', '#0ea5e9');
      const chatId = '44444444-4444-4444-8444-444444444444';
      const now = Date.now();
      const chat = {
        id: chatId,
        title: 'Ship the work graph views',
        createdAt: new Date(now - 3_600_000).toISOString(),
        updatedAt: new Date(now - 60_000).toISOString(),
        permissionMode: 'default',
        runtime: 'claude-code',
        cwd: agent.projectPath,
      };
      const pullRequests = JSON.parse(
        JSON.stringify(PULL_REQUESTS).replaceAll('"CHAT"', JSON.stringify(chatId))
      );

      await page.route('**/api/sessions**', async (route) => {
        const url = new URL(route.request().url());
        if (route.request().method() !== 'GET') return route.continue();
        if (url.pathname === `/api/sessions/${chatId}/work`) return json(route, pullRequests);
        if (url.pathname === '/api/sessions')
          return json(route, { sessions: [chat], nextCursor: null });
        if (url.pathname === `/api/sessions/${chatId}`) return json(route, chat);
        return route.continue();
      });
      await page.route(`**/api/agents/${agent.id}/work**`, (route) => json(route, pullRequests));

      const dir = encodeURIComponent(agent.projectPath);
      await page.goto(`/session?session=${chatId}&dir=${dir}`, { waitUntil: 'domcontentloaded' });
      await basePage.waitForAppReady();

      // The chip says how many, as icon and count on a phone, in words on a desktop.
      const chip = page.getByTestId('chat-work-chip');
      await expect(chip).toBeVisible();
      await expect(chip).toHaveAccessibleName('2 PRs from this chat. Show them');
      if (size.name === 'phone') {
        // The shared chip's phone size: 40px drawn, with a hit area out to 44.
        expect((await chip.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(40);
      }
      await chip.click();
      const panel = page.getByRole('dialog', { name: 'Pull requests' });
      await expect(panel.getByText('dork-labs/dorkos#4412')).toBeVisible();
      await expect(panel.getByText(/Works on · Opened · Nov 24 · In a spin-off/)).toBeVisible();
      await expect(panel.getByText('dork-labs/marketplace#88')).toBeInViewport();
      await expect(panel.getByRole('link', { name: /dork-labs\/marketplace#88/ })).toHaveAttribute(
        'href',
        'https://github.com/dork-labs/marketplace/pull/88'
      );
      await shoot(page, testInfo, `chat-header-prs-${size.width}`);
      await page.keyboard.press('Escape');

      // The agent's profile: Work, then Pull requests.
      await rightPanel.openProfilePage('pull-requests', agent.projectPath);
      await expect(page.locator('[data-slot="profile-page-title"]')).toHaveText('Pull requests');
      const list = page.locator('[data-slot="profile-pull-requests"]');
      await expect(list.getByText('dork-labs/dorkos#4412')).toBeVisible();
      await expect(list.getByText('Opened · Nov 25')).toBeVisible();
      await shoot(page, testInfo, `profile-prs-${size.width}`);
    });
  }
});
