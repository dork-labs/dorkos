import { test, expect, type Page } from '@playwright/test';
import { BasePage } from '../../pages/BasePage.js';
import { realOwnerKey } from './community-mocks.js';

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
      const ownerKey = await realOwnerKey(route, `${method} ${path}`);
      if (ownerKey) await route.fulfill({ json: navigationState(ownerKey) }).catch(() => {});
      return;
    }
    if (method !== 'GET') return route.continue();
    if (path === '/api/community-connections') {
      await route.fulfill({ json: { connections: [connection] } });
      return;
    }
    if (path === '/api/community-connections/navigation') {
      const ownerKey = await realOwnerKey(route, `${method} ${path}`);
      if (ownerKey) await route.fulfill({ json: navigationState(ownerKey) }).catch(() => {});
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

  // With a community selected, the shortcut opens on THAT row, not on the
  // first one ("Opening focuses the selected row.").
  await trigger.focus();
  await page.keyboard.press('Meta+Shift+K');
  await expect(page.getByRole('menuitemradio', { name: /Alpha/ })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByText('Switch context', { exact: true })).toBeHidden();

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

test('An unsent Community draft comes back after switching away and back', async ({ page }) => {
  await mockCommunitySwitcher(page);
  await page.goto('/channels?community=alpha&id=general');
  await new BasePage(page).waitForAppReady();
  await expect(page.getByText('Message 2', { exact: true })).toBeVisible();
  const composer = page.getByRole('combobox', { name: /message/i }).last();
  await composer.fill('Half a thought for Alpha');

  // Away to this DorkOS, by the switcher, without reloading the page.
  await page.getByTestId('sidebar-header-block').click();
  await page.getByRole('menuitemradio', { name: /Your team|’s team/ }).click();
  await expect(page).not.toHaveURL(/community=alpha/);
  await expect(page.getByText('Half a thought for Alpha')).toHaveCount(0);

  // And back: the words are where they were left.
  await page.getByTestId('sidebar-header-block').click();
  await page.getByRole('menuitemradio', { name: /Alpha/ }).click();
  await expect(page).toHaveURL(/community=alpha/);
  await expect(page.getByRole('combobox', { name: /message/i }).last()).toHaveValue(
    'Half a thought for Alpha'
  );
});

/**
 * Answer the Community's own site so an action that opens it has somewhere to
 * land. The page stands in for the real host; what matters is WHICH address
 * the DorkOS app asked the browser to open.
 */
async function stubCommunitySite(page: Page) {
  await page
    .context()
    .route('https://alpha.example.test/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<title>Alpha</title><h1>Alpha</h1>' })
    );
}

/** Open the switcher on Alpha and step into its "Manage Alpha" submenu by keyboard. */
async function openManageAlpha(page: Page) {
  await page.goto('/channels?community=alpha&id=general');
  await new BasePage(page).waitForAppReady();
  // The menu focuses the selected row once, when it opens; wait until the
  // connection list has landed so that row exists to be focused.
  await expect(page.getByTestId('sidebar-header-block')).toHaveAccessibleName('Alpha menu');
  await page.getByTestId('sidebar-header-block').focus();
  await page.keyboard.press('Meta+Shift+K');
  await expect(page.getByRole('menuitemradio', { name: /Alpha/ })).toBeFocused();
  const manage = page.getByRole('menuitem', { name: 'Manage Alpha' });
  await page.keyboard.press('ArrowDown');
  await expect(manage).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('menuitem', { name: 'Community settings' })).toBeVisible();
}

test('Community actions open the Community’s own pages, by keyboard', async ({
  page,
}, testInfo) => {
  await mockCommunitySwitcher(page);
  await stubCommunitySite(page);
  await openManageAlpha(page);

  // The submenu opens on its first action; the note above it is not a stop.
  await expect(page.getByRole('menuitem', { name: 'Invite people' })).toBeFocused();
  const shot = testInfo.outputPath('community-actions-desktop.png');
  await page.screenshot({ path: shot, animations: 'disabled' });
  await testInfo.attach('community-actions-desktop.png', { path: shot, contentType: 'image/png' });
  await page.keyboard.press('ArrowDown');
  // Settings for a Community open THAT Community's settings, on its site.
  await expect(page.getByRole('menuitem', { name: 'Community settings' })).toBeFocused();
  const settings = page.context().waitForEvent('page');
  await page.keyboard.press('Enter');
  const settingsPage = await settings;
  expect(settingsPage.url()).toBe('https://alpha.example.test/c/remote-alpha/settings');
  await settingsPage.close();

  await openManageAlpha(page);
  const invite = page.context().waitForEvent('page');
  await page.getByRole('menuitem', { name: 'Invite people' }).press('Enter');
  expect((await invite).url()).toBe('https://alpha.example.test/c/remote-alpha/settings/community');

  await openManageAlpha(page);
  const leave = page.context().waitForEvent('page');
  await page.getByRole('menuitem', { name: 'Leave community' }).press('Enter');
  expect((await leave).url()).toBe('https://alpha.example.test/c/remote-alpha/settings/account');
});

test('Disconnecting asks first, then removes only that Community and leaves it', async ({
  page,
}) => {
  await mockCommunitySwitcher(page);
  let disconnected = false;
  await page.route('**/api/community-connections/alpha', async (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    disconnected = true;
    // The local server removed its copy but could not reach Alpha to end the
    // grant there, so the person is told how to finish.
    await route.fulfill({ json: { remoteRevoked: false } });
  });
  // Once the server has dropped the connection, it stops listing it.
  await page.route('**/api/community-connections', async (route) => {
    if (!disconnected || route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({ json: { connections: [] } });
  });

  await openManageAlpha(page);
  await page.getByRole('menuitem', { name: 'Disconnect…' }).press('Enter');
  const confirm = page.getByRole('alertdialog', { name: 'Disconnect this DorkOS from Alpha?' });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('You stay a member of Alpha');
  await confirm.getByRole('button', { name: 'Keep connected' }).click();
  await expect(confirm).toBeHidden();
  expect(disconnected).toBe(false);
  await expect(page).toHaveURL(/community=alpha/);

  await openManageAlpha(page);
  await page.getByRole('menuitem', { name: 'Disconnect…' }).press('Enter');
  await confirm.getByRole('button', { name: 'Disconnect' }).click();
  await expect(confirm).toBeHidden();
  expect(disconnected).toBe(true);
  await expect(
    page.getByText(
      'Alpha is disconnected here, but it couldn’t be reached. To finish, remove this DorkOS under Local connections on Alpha.',
      { exact: true }
    )
  ).toBeVisible();
  // Routed away, and nothing of Alpha is left on screen.
  await expect(page).not.toHaveURL(/community=alpha/);
  await expect(page.getByText('Message 2', { exact: true })).toBeHidden();
  await page.getByTestId('sidebar-header-block').click();
  await expect(page.getByRole('menuitemradio', { name: /Alpha/ })).toHaveCount(0);
});

test('A Community that ends elsewhere is left within seconds, on the server’s push', async ({
  page,
}) => {
  // Spec `community-switcher-navigation` §"Removed membership or revoked
  // connection removes content immediately"; the acceptance bar is 10 s.
  // The acceptance run's defect: the local server learned in ~26 ms that the
  // person had left, but the window moved only on its next 30-second poll of
  // the connection list. A real Community cannot be left from here, so the
  // LIST is mocked and the PUSH is real: `/api/test/community-connection-change`
  // commits a change in the real connection store, and the real server sends
  // `community_connections_changed` over the real `/api/events` socket.
  await mockCommunitySwitcher(page);
  let ended = false;
  const listReads: number[] = [];
  await page.route('**/api/community-connections', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    listReads.push(Date.now());
    if (!ended) return route.fallback();
    await route.fulfill({
      json: { connections: [{ ...connection, status: 'reconnect-required' }] },
    });
  });
  // The global stream is a WebSocket; know when it is open, and see the push.
  const frames: string[] = [];
  const streamOpen = new Promise<void>((resolve) => {
    page.on('websocket', (socket) => {
      if (!new URL(socket.url()).pathname.endsWith('/api/events')) return;
      socket.on('framereceived', (frame) => {
        frames.push(String(frame.payload));
        resolve();
      });
    });
  });

  await page.goto('/channels?community=alpha&id=general');
  await new BasePage(page).waitForAppReady();
  await expect(page.getByText('Message 2', { exact: true })).toBeVisible();
  await streamOpen;

  // Alpha ends. Nothing in the window re-reads the list until told to.
  ended = true;
  const endedAt = Date.now();
  const lastReadBefore = listReads.at(-1)!;
  const pushed = await page.request.post('/api/test/community-connection-change');
  expect(pushed.ok()).toBe(true);

  await expect(page).not.toHaveURL(/community=alpha/, { timeout: 10_000 });
  const leftAfter = Date.now() - endedAt;
  test.info().annotations.push({ type: 'left-after-ms', description: String(leftAfter) });
  expect(leftAfter).toBeLessThan(10_000);
  await expect(page.getByText('Message 2', { exact: true })).toBeHidden();
  expect(frames.some((frame) => frame.includes('community_connections_changed'))).toBe(true);
  // The re-read that carried the end came from the push, not the poll: it
  // landed well inside the poll's 30-second interval.
  const endingRead = listReads.find((at) => at >= endedAt)!;
  expect(endingRead - lastReadBefore).toBeLessThan(30_000);
  expect(endingRead - endedAt).toBeLessThan(10_000);
});

test('Joining with an invitation opens the link on the Community’s site, not a pairing', async ({
  page,
}) => {
  await mockCommunitySwitcher(page);
  await stubCommunitySite(page);
  // Home's composer takes focus a beat after load, which can pull it out of an
  // open menu; start from a page without one.
  await page.goto('/tasks');
  await new BasePage(page).waitForAppReady();
  await page.getByTestId('sidebar-header-block').focus();
  await page.keyboard.press('Meta+Shift+K');
  await expect(page.getByRole('menuitemradio', { name: /Your team|’s team/ })).toBeFocused();
  // Down past the destinations to the add submenu, then into it. Addressed by
  // its stable id rather than its wording.
  const add = page.locator('[data-menu-item-id="add-community"]');
  for (
    let step = 0;
    step < 4 && !(await add.evaluate((el) => el === document.activeElement));
    step++
  )
    await page.keyboard.press('ArrowDown');
  await expect(add).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('menuitem', { name: 'Connect a community' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Join with an invitation…' })).toBeFocused();
  await page.keyboard.press('Enter');
  const field = page.getByLabel('Invitation link');
  await field.fill('https://alpha.example.test/c/remote-alpha');
  await page.getByRole('button', { name: 'Open invitation' }).click();
  await expect(page.getByRole('alert')).toContainText('That isn’t an invitation link.');

  const link = 'https://alpha.example.test/c/remote-alpha/join#invite=one-time';
  await field.fill(link);
  const opened = page.context().waitForEvent('page');
  await page.getByRole('button', { name: 'Open invitation' }).click();
  expect((await opened).url()).toBe(link);
  await expect(field).toBeHidden();
  await expect(page).not.toHaveURL(/\/connections/);
});

test('Community actions fit the 390px phone sheet', async ({ page }, testInfo) => {
  await mockCommunitySwitcher(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/channels?community=alpha&id=general');
  await new BasePage(page).waitForAppReady();
  await page.getByTestId('sidebar-header-block').click();
  const manage = page.getByRole('group', { name: 'Manage Alpha' });
  await expect(manage).toBeVisible();
  // Rows that leave the app say where, in their accessible names.
  for (const name of ['Invite people', 'Community settings', 'Leave community…']) {
    const row = manage.getByRole('menuitem', { name });
    await expect(row).toBeVisible();
    await expect(row).toHaveAccessibleName(/opens on alpha\.example\.test$/);
  }
  await expect(manage.getByRole('menuitem', { name: 'Disconnect…', exact: true })).toBeVisible();
  // The flattened add group, by its stable id; its rows are asserted by name.
  const add = page.getByRole('group').filter({
    has: page.locator('[data-menu-group-id="add-community"]'),
  });
  await add.scrollIntoViewIfNeeded();
  for (const name of ['Connect a community', 'Join with an invitation…', 'Run your own community'])
    await expect(add.getByRole('menuitem', { name })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await manage.scrollIntoViewIfNeeded();
  const shot = testInfo.outputPath('community-actions-390.png');
  await page.screenshot({ path: shot, animations: 'disabled' });
  await testInfo.attach('community-actions-390.png', { path: shot, contentType: 'image/png' });
});
