import { test, expect } from '../fixtures';
import { openFromCommandPalette } from '../pages/command-palette';

test.describe('Settings — URL Deep Links @smoke', () => {
  test('navigating to ?settings=tools opens Settings to Tools tab', async ({ page }) => {
    await page.goto('/?settings=tools');
    await page.waitForSelector('[data-testid="settings-dialog"]');
    await expect(page.getByRole('tab', { name: 'Tools' })).toHaveAttribute('aria-selected', 'true');
  });

  test('navigating to ?settings=tools&settingsSection=external-mcp scrolls into view', async ({
    page,
  }) => {
    await page.goto('/?settings=tools&settingsSection=external-mcp');
    await page.waitForSelector('[data-testid="settings-dialog"]');
    // External MCP card renders only after the /api/config query resolves —
    // wait for it to attach, then assert it gets scrolled into the viewport
    // by useDeepLinkScroll.
    const element = page.locator('[data-section="external-mcp"]');
    await element.waitFor({ state: 'attached' });
    await expect(element).toBeInViewport();
  });

  test('browser back closes the dialog', async ({ page }) => {
    await page.goto('/');
    await page.goto('/?settings=tools');
    await page.waitForSelector('[data-testid="settings-dialog"]');
    await page.goBack();
    await expect(page.locator('[data-testid="settings-dialog"]')).toBeHidden();
  });

  test('palette open updates URL after migration (settings=open)', async ({ page }) => {
    await page.goto('/');
    // Wait for app shell so the global keyboard handler is mounted.
    await page.waitForSelector('[data-testid="app-shell"]');
    // The shared opener presses the in-DOM trigger rather than a synthetic
    // keypress, so the test is robust across platforms (Meta vs Control), and
    // types the name — Settings is not a row until someone does.
    await openFromCommandPalette(page, 'Settings');
    await page.waitForSelector('[data-testid="settings-dialog"]');
    // Palette callsite was migrated in task 2.7 — clicking the Settings entry
    // should now drive the URL via useSettingsDeepLink().open(), producing
    // `?settings=open` (no tab argument).
    await expect(page).toHaveURL(/[?&]settings=open/);
  });

  test('navigating to ?panel=profile opens the profile on a fresh tab', async ({
    page,
    rightPanel,
    roomsApi,
  }) => {
    // A browser-level check on purpose: the deep link has unit coverage, but
    // only a real fresh tab proves it survives with no in-app opener having
    // populated any store first.
    //
    // `agentPath` is load-bearing here, and was the shape that failed. Without
    // it the link cannot be applied until the working directory settles, which
    // puts it AFTER the panel's layouts hydrate — so the version of this test
    // that omitted it certified the broken case green. With it, the link is
    // applied on the first pass, and the per-agent layout for an agent nobody
    // has opened hydrates as CLOSED right on top of it.
    const agent = await roomsApi.registerAgent(`E2E Profile ${roomsApi.runId}`, '🛠️', '#22c55e');
    const dir = encodeURIComponent(agent.projectPath);
    await page.goto(`/session?panel=profile&profilePage=rooms&agentPath=${dir}&dir=${dir}`);
    await page.waitForSelector('[data-testid="app-shell"]');

    await expect(rightPanel.header).toBeVisible();
    await expect(rightPanel.profileTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-slot="profile"][data-home="docked"]')).toBeVisible();
    // A selected tab in a panel collapsed to nothing is not an opened panel:
    // that was the failure, and `toBeVisible()` alone did not see it.
    await expect
      .poll(() => rightPanel.tabStripWidth(), {
        message: 'the panel a link asked for must have a real width',
      })
      .toBeGreaterThan(0);
    // …and on the page the link named, not just on the profile's root.
    await expect(page.locator('[data-slot="profile-page-title"]')).toHaveText('Rooms');
  });

  test('?agentPath= opens THAT agent, in a different agent’s session', async ({
    page,
    rightPanel,
    roomsApi,
  }) => {
    // The shape every other case here misses: the link names an agent the
    // session is not about. The session binds its OWN closed layout while the
    // panel is filled by the link's agent — and a version that let that bind
    // answer the link closed the panel and cleared its subject, so the link
    // opened nothing at all.
    const inSession = await roomsApi.registerAgent(`E2E Host ${roomsApi.runId}`, '🛠️', '#22c55e');
    const linked = await roomsApi.registerAgent(`E2E Linked ${roomsApi.runId}`, '🔭', '#f59e0b');
    await page.goto(
      `/session?dir=${encodeURIComponent(inSession.projectPath)}` +
        `&panel=profile&profilePage=rooms&agentPath=${encodeURIComponent(linked.projectPath)}`
    );
    await page.waitForSelector('[data-testid="app-shell"]');

    await expect(rightPanel.header).toBeVisible();
    await expect(rightPanel.profileTab).toHaveAttribute('aria-selected', 'true');
    await expect
      .poll(() => rightPanel.tabStripWidth(), {
        message: 'the panel a link asked for must have a real width',
      })
      .toBeGreaterThan(0);
    // The LINK's agent, not the session's — read off the pushed page's strip.
    await expect(page.locator('[data-slot="profile-page-title"]')).toHaveText('Rooms');
    await expect(page.locator('[data-slot="profile-strip"]')).toContainText(
      `E2E Linked ${roomsApi.runId}`
    );
  });

  test('an old ?panel=agent-hub link still lands on the profile', async ({
    page,
    rightPanel,
    roomsApi,
  }) => {
    // The Agent Hub's own links are out there in bookmarks and in other
    // people's notes. They must open the surface that replaced it, and leave
    // the reader on a URL this build speaks — not on the dead one.
    const agent = await roomsApi.registerAgent(`E2E Legacy ${roomsApi.runId}`, '🛠️', '#22c55e');
    await page.goto(
      `/session?panel=agent-hub&hubTab=sessions&dir=${encodeURIComponent(agent.projectPath)}`
    );
    await page.waitForSelector('[data-testid="app-shell"]');

    await expect(rightPanel.header).toBeVisible();
    await expect(rightPanel.profileTab).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/[?&]panel=profile/);
    await expect(page).not.toHaveURL(/hubTab=/);
    await expect
      .poll(() => rightPanel.tabStripWidth(), {
        message: 'the panel a rewritten link asked for must have a real width',
      })
      .toBeGreaterThan(0);
  });

  test('?agent= on the Team page still selects a topology node', async ({ page, roomsApi }) => {
    // `?agent=` belongs to the topology's detail panel here, and to the dead
    // agent dialog everywhere else. Claiming all of them for the profile
    // rewrote this link and the detail panel could never open again.
    const agent = await roomsApi.registerAgent(`E2E Topology ${roomsApi.runId}`, '🛠️', '#22c55e');
    await page.goto(`/team?view=topology&agent=${encodeURIComponent(agent.id)}`);
    await page.waitForSelector('[data-testid="app-shell"]');

    await expect(page).toHaveURL(new RegExp(`agent=${agent.id}`));
    await expect(page).not.toHaveURL(/panel=profile/);
  });
});
