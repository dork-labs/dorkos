import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '../../fixtures';

/**
 * DOR-329's sidebar-organization spec deferred a committed browser test — its
 * live verification pass was a one-off script run outside the repo, and it
 * caught two real pointer-only bugs jsdom's unit suite could not (one fixed
 * via `use-menu-close-focus-guard`). This spec is the committed replacement:
 * group create → drag-into-group → reload persistence, driven by real
 * pointer events against the actual dnd-kit `PointerSensor`.
 *
 * No Claude SDK / API key involved — sidebar organization is pure `ui.sidebar`
 * config plus mesh registration, so this stays a fast `@smoke` test.
 */
test.describe('Dashboard Sidebar — Groups @smoke', () => {
  const runId = randomUUID().slice(0, 8);
  const agentName = `E2E Sidebar Agent ${runId}`;
  const groupName = `E2E Group ${runId}`;
  const agentDir = join(homedir(), '.dork-e2e-fixtures', `sidebar-dnd-${randomUUID()}`);
  let agentId: string | undefined;

  test.beforeEach(async ({ request, basePage, dashboardSidebar }) => {
    const res = await request.post('/api/mesh/agents', {
      data: { path: agentDir, overrides: { name: agentName, runtime: 'claude-code' } },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    agentId = (await res.json()).id as string;

    await basePage.goto();
    await basePage.waitForAppReady();
    await basePage.ensureSidebarOpen();
    await expect(dashboardSidebar.agentRow(agentName)).toBeVisible();
  });

  test.afterEach(async ({ request, dashboardSidebar }) => {
    // Drop the group first (moves the member back to Agents) so no orphaned
    // group with a dangling member path survives in the shared dev DORK_HOME
    // this suite reuses (this project is not CI-isolated).
    if (
      await dashboardSidebar
        .groupHeader(groupName)
        .isVisible()
        .catch(() => false)
    ) {
      await dashboardSidebar.deleteGroup(groupName);
    }
    if (agentId) {
      await request.delete(`/api/mesh/agents/${agentId}/data`);
    }
  });

  test('creates a group, drags an agent into it, and persists across reload', async ({
    page,
    request,
    basePage,
    dashboardSidebar,
  }) => {
    await dashboardSidebar.createGroup(groupName);
    const group = dashboardSidebar.groupContainer(groupName);
    await expect(group).toBeVisible();
    await expect(group).toContainText('Drag agents here');

    await dashboardSidebar.dragAgentIntoGroup(agentName, groupName);

    // DOM: the agent row now renders inside the group's own member list.
    await expect(group).toContainText(agentName);
    await expect(group).not.toContainText('Drag agents here');

    // Server: the drop persisted the whole `ui.sidebar` section (PATCH
    // /api/config), independent of DOM re-render timing.
    const configRes = await request.get('/api/config');
    const config = await configRes.json();
    const persistedGroup = config.ui.sidebar.groups.find(
      (g: { name: string }) => g.name === groupName
    );
    expect(persistedGroup).toBeDefined();
    expect(persistedGroup.agentPaths).toHaveLength(1);

    // Reload — the actual persistence-across-reload proof.
    await page.reload();
    await basePage.waitForAppReady();
    await basePage.ensureSidebarOpen();

    const groupAfterReload = dashboardSidebar.groupContainer(groupName);
    await expect(groupAfterReload).toBeVisible();
    await expect(groupAfterReload).toContainText(agentName);
  });
});
