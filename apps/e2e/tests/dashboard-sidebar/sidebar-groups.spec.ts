import { randomUUID } from 'node:crypto';
import { test, expect } from '../../fixtures';

/**
 * The empty-group placeholder, matched as a PATTERN rather than a literal.
 *
 * The subject here is "this group has nothing in it", not the exact wording.
 * The literal `'Drag agents here'` broke when DOR-581 widened the copy to
 * "Drag agents, channels, or conversations here", and that failure sat on
 * `main` for days because neither `test` nor `browser-test` is a required
 * check. A pattern survives the next thing that becomes droppable, while still
 * asserting the placeholder is the thing on screen.
 *
 * Source of truth: `SidebarGroupSection.tsx`, the `items.length === 0` branch.
 */
const EMPTY_GROUP_PLACEHOLDER = /Drag .*here/;

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
  /** The path the server canonicalized on registration — what `items` stores. */
  let agentProjectPath: string;

  // Seeded through `roomsApi` rather than by hand: it registers the agent under
  // a directory the run owns and deletes that directory again in teardown. The
  // hand-rolled version put it under `~/.dork-e2e-fixtures` and only ever
  // unregistered it, which removes `<path>/.dork` and leaves the directory —
  // one more orphan in the operator's home per run, forever.
  test.beforeEach(async ({ roomsApi, basePage, dashboardSidebar }) => {
    const agent = await roomsApi.registerAgent(agentName, '🧩', '#8b5cf6');
    agentProjectPath = agent.projectPath;

    await basePage.goto();
    await basePage.waitForAppReady();
    await basePage.ensureSidebarOpen();
    await expect(dashboardSidebar.agentRow(agentName)).toBeVisible();
  });

  test.afterEach(async ({ request }) => {
    // Drop the group over the API rather than by clicking its "…" menu. Groups
    // live in `ui.sidebar.groups`, so removing one is a config write — and
    // driving that through a hover-revealed menu inside a list that crossfades
    // made teardown the least reliable part of this spec: it failed on a strict
    // match against the two mounted copies of a row mid-animation, and again by
    // timing out on the menu item after the test itself had already passed.
    // Teardown should not be able to fail a test whose assertions all held.
    // The agent is `roomsApi`'s to put away.
    const res = await request.get('/api/config');
    if (!res.ok()) return;
    const config = (await res.json()) as {
      ui: { sidebar: { groups: { name: string }[] } };
    };
    const groups = config.ui.sidebar.groups.filter((g) => g.name !== groupName);
    if (groups.length === config.ui.sidebar.groups.length) return;
    await request.patch('/api/config', { data: { ui: { sidebar: { groups } } } }).catch(() => {});
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
    await expect(group).toContainText(EMPTY_GROUP_PLACEHOLDER);

    await dashboardSidebar.dragAgentIntoGroup(agentName, groupName);

    // DOM: the agent row now renders inside the group's own member list.
    await expect(group).toContainText(agentName);
    await expect(group).not.toContainText(EMPTY_GROUP_PLACEHOLDER);

    // Server: the drop persisted the whole `ui.sidebar` section (PATCH
    // /api/config), independent of DOM re-render timing.
    const configRes = await request.get('/api/config');
    const config = await configRes.json();
    const persistedGroup = config.ui.sidebar.groups.find(
      (g: { name: string }) => g.name === groupName
    );
    expect(persistedGroup).toBeDefined();
    // The exact stored membership, not just its length: one agent item
    // reference naming the agent that was dragged (sidebar-groups, DOR-579).
    expect(persistedGroup.items).toEqual([{ kind: 'agent', path: agentProjectPath }]);

    // Reload — the actual persistence-across-reload proof.
    await page.reload();
    await basePage.waitForAppReady();
    await basePage.ensureSidebarOpen();

    const groupAfterReload = dashboardSidebar.groupContainer(groupName);
    await expect(groupAfterReload).toBeVisible();
    await expect(groupAfterReload).toContainText(agentName);
  });

  test('measures 272px wide, insets every row by 16px, and draws no hairlines', async ({
    page,
    dashboardSidebar,
  }) => {
    // **P1 AC-5, measured in a real browser rather than asserted from classes.**
    // The density is the visible half of this redesign: 272px of panel, one
    // 16px inset paid in two places instead of 30px stacked up in three, and
    // separation by tint rather than by a 1px line (spec R1).
    const panel = dashboardSidebar.panel;
    await expect(panel).toBeVisible();

    const panelBox = await panel.boundingBox();
    expect(panelBox?.width).toBe(272);

    // Every row, not a sampled one: the inset is a property of the shared row
    // primitive, so a section that opted out of it is exactly the regression
    // this catches.
    const rows = dashboardSidebar.rows;
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThan(0);
    for (let i = 0; i < rowCount; i++) {
      expect(await dashboardSidebar.rowInset(rows.nth(i))).toBe(16);
    }

    // No `border-b` / `border-t` anywhere in the sidebar tree. The header's
    // underline and the footer's overline are the two that went; the assertion
    // is over the whole panel so a new one cannot creep back in either.
    //
    // Matched on whole class TOKENS rather than as a substring: `border-border`
    // contains the letters "border-b" and is a colour, not an edge — a substring
    // selector would fail on the onboarding card's dashed frame, which is a
    // shape rather than a separator.
    const hairlines = await panel.evaluateAll((roots) =>
      roots.flatMap((root) =>
        Array.from(root.querySelectorAll('*'))
          .filter((el) =>
            Array.from(el.classList).some((token) => /^border-[bt](-|$)/.test(token))
          )
          .map((el) => el.className)
      )
    );
    expect(hairlines).toEqual([]);
  });

  test('reveals a row’s ⋮ to the keyboard, not only to the pointer', async ({
    page,
    dashboardSidebar,
  }) => {
    // WCAG (spec R2): hover-revealed chrome always has a non-pointer path.
    // Focus the trigger directly — `focus-visible` answers a programmatic focus
    // that follows keyboard input, which is what a Tab into the row is.
    const row = dashboardSidebar.agentRow(agentName);
    await expect(row).toBeVisible();
    const kebab = row.locator('..').getByRole('button', { name: 'Agent actions' });

    await expect(kebab).toHaveCSS('opacity', '0');
    await kebab.evaluate((element: HTMLElement) => element.focus());
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(kebab).toHaveCSS('opacity', '1');
  });
});
