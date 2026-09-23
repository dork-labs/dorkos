import { test, expect, type Page } from '@playwright/test';
import { BasePage } from '../../pages/BasePage.js';

const access = {
  state: 'verified',
  effective: { read: true, post: true, enrollAgent: true, stream: false },
  lastKnown: {
    lifecycle: 'active',
    capabilities: { read: true, post: true, enrollAgent: true, stream: false },
    verifiedAt: '2026-09-21T12:00:00.000Z',
  },
};

const attention = {
  state: 'verified',
  unreadCount: 2,
  mentionCount: 1,
  verifiedAt: '2026-09-21T12:00:00.000Z',
};

const connection = {
  ref: 'alpha',
  remoteCommunityId: 'remote-alpha',
  label: 'Alpha',
  pinnedOrigin: 'https://alpha.example.test',
  connectedHumanMemberId: 'person-alpha',
  status: 'connected',
  expiresAt: null,
  access,
  attention,
};

const destination = {
  ref: 'alpha',
  roomId: 'general',
  threadId: null,
  scrollAnchorEntryId: 'entry-2',
};

const room = {
  community: 'alpha',
  roomId: 'general',
  remoteCommunityId: 'remote-alpha',
  kind: 'channel',
  title: 'General',
  slug: 'general',
  topic: null,
  archived: false,
  createdAt: '2026-09-21T12:00:00.000Z',
  lastActivityAt: '2026-09-21T12:00:00.000Z',
  unreadCount: 2,
  visibility: 'public',
  readable: true,
  writable: true,
  joined: true,
  stale: false,
  cacheCursor: null,
  lastRemoteSeq: 3,
  access,
};

const entries = ['entry-1', 'entry-2', 'entry-3'].map((id, index) => ({
  community: 'alpha',
  roomId: 'general',
  id,
  authorId: 'person-alpha',
  authorDisplayName: 'Alex',
  authorKind: 'human',
  text: `Message ${index + 1}`,
  mentions: [],
  parentEntryId: null,
  threadRootEntryId: null,
  depth: 0,
  cursor: `cursor-${index + 1}`,
  createdAt: `2026-09-21T12:0${index}:00.000Z`,
  remoteSeq: index + 1,
  attachments: [],
}));

/** The saved state the proof restores, under the real server's owner key. */
function navigationState(ownerKey: string) {
  return {
    ownerKey,
    installationDestination: { path: '/', search: {} },
    order: ['alpha'],
    destinations: [destination],
  };
}

/**
 * Route the owner-qualified Community reads and writes the switcher proof needs.
 *
 * Every navigation call still reaches the real server first, so a missing
 * route or a failed owner check fails here instead of being papered over.
 * The answer is then the mocked owner state, because the real server has no
 * `alpha` connection and would prune the remembered destination this proof
 * restores: a write's real reply, landing in the query cache, used to race
 * the timeline and land it at the end instead of the remembered row.
 */
async function mockCommunitySwitcher(page: Page) {
  await page.route('**/api/community-connections**', async (route) => {
    const method = route.request().method();
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/api/community-connections/navigation') && method !== 'GET') {
      const real = await route.fetch();
      expect(real.status(), `${method} ${path}`).toBe(200);
      const { ownerKey } = (await real.json()) as { ownerKey: string };
      await route.fulfill({ json: navigationState(ownerKey) });
      return;
    }
    if (method !== 'GET') return route.continue();
    if (path === '/api/community-connections') {
      await route.fulfill({ json: { connections: [connection] } });
      return;
    }
    if (path === '/api/community-connections/navigation') {
      const real = await route.fetch();
      expect(real.status()).toBe(200);
      const { ownerKey } = (await real.json()) as { ownerKey: string };
      await route.fulfill({ json: navigationState(ownerKey) });
      return;
    }
    if (path === '/api/community-connections/navigation/alpha/destination') {
      await route.fulfill({ json: { destination } });
      return;
    }
    await route.continue();
  });
  await page.route('**/api/communities/alpha/rooms', async (route) => {
    await route.fulfill({
      json: {
        community: 'alpha',
        rooms: [room],
        stale: false,
      },
    });
  });
  await page.route('**/api/communities/alpha/rooms/general', async (route) => {
    await route.fulfill({ json: { room } });
  });
  await page.route('**/api/communities/alpha/rooms/general/entries**', async (route) => {
    await route.fulfill({
      json: {
        community: 'alpha',
        roomId: 'general',
        entries,
        nextCursor: null,
        lastRemoteSeq: 3,
        stale: false,
      },
    });
  });
  await page.route('**/api/communities/alpha/rooms/general/members', async (route) => {
    await route.fulfill({
      json: { community: 'alpha', roomId: 'general', members: [], stale: false },
    });
  });
}

test('Community switcher supports keyboard selection and a narrow accessible menu @smoke', async ({
  page,
}, testInfo) => {
  await mockCommunitySwitcher(page);
  await page.goto('/');
  await new BasePage(page).waitForAppReady();

  const trigger = page.getByTestId('sidebar-header-block');
  await trigger.focus();
  await page.keyboard.press('Meta+Shift+K');
  await expect(page.getByText('Switch context', { exact: true })).toBeVisible();
  // The community list waits for the owner check, so it can land a beat after
  // the menu opens. Arrow only once its row is there to move to.
  await expect(page.getByRole('menuitemradio', { name: /Alpha/ })).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitemradio', { name: /Alpha/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/channels\?community=alpha&id=general/);
  await expect(page.locator('[data-slot="conversation-timeline"]')).toHaveAttribute(
    'data-landed-on',
    'remembered'
  );
  await expect(page.getByText('Message 2', { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await new BasePage(page).waitForAppReady();
  await expect(page.getByTestId('sidebar-header-block')).toHaveCount(1);
  await page.getByTestId('sidebar-header-block').click();
  const alpha = page.getByRole('radio', { name: /Alpha/ });
  await expect(alpha).toBeVisible();
  await expect(alpha).toHaveAccessibleName(/Alpha.*1 mention.*1 other unread/);
  // The phone sheet is this menu's only home on a phone, so it keeps the
  // settings row and the version line below the destinations (BC-44).
  await expect(page.getByRole('menuitem', { name: /Workspace settings/ })).toBeVisible();
  await expect(
    page.getByRole('menuitem', { name: /beta/ }).or(page.getByText('Development build'))
  ).toBeVisible();
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
  await expect
    .poll(() => page.evaluate(() => window.visualViewport?.scale ?? 1))
    .toBeGreaterThan(1);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await session.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
  await testInfo.attach('community-switcher-390.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});
