import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
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
 * Source of truth: `useSectionChrome.tsx`, the group branch's `footer` — the
 * one section allowed to render with no rows, because the operator made it.
 */
const EMPTY_GROUP_PLACEHOLDER = /Drag .*here/;

/**
 * What one of the sidebar's geometry tokens resolves to, in pixels.
 *
 * The same reader `sidebar-row-gutter.spec.ts` uses, and for the same reason:
 * `--sidebar-header-x` / `--sidebar-row-x` / `--sidebar-nested-x` are the one
 * place the panel's indents are decided (`specs/sidebar-simplification` D1), so
 * a spec that restated their values would be pinning a copy.
 *
 * @param page - The page under test.
 * @param name - The custom property, e.g. `--sidebar-row-x`.
 */
async function token(page: Page, name: string): Promise<number> {
  const value = await page.evaluate(
    (property) => getComputedStyle(document.documentElement).getPropertyValue(property).trim(),
    name
  );
  expect(value, `${name} is not declared`).not.toBe('');
  return parseFloat(value);
}

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
  // **Serial, because these tests share one `ui.sidebar`.** The config is a
  // single file on a single server, and `fullyParallel` would otherwise put the
  // drag test and the density measurements on concurrent workers writing to it
  // — one test's group create landing in the middle of another's read. Every
  // way that failed looked like a product bug (an agent that never joined its
  // group, a row that vanished mid-measurement) and was neither.
  test.describe.configure({ mode: 'serial' });

  const runId = randomUUID().slice(0, 8);
  const agentName = `E2E Sidebar Agent ${runId}`;
  /**
   * A second agent, on a second runtime.
   *
   * **Grouping is offered by data volume, not by a setting** (BC-32): a cockpit
   * with one agent on one runtime has nothing to organize, so "New group…" is
   * not in its menus at all. Two distinct runtimes is the cheaper of the two
   * bars — the other is eight agents — and it exercises the real rule rather
   * than working around it.
   */
  const secondAgentName = `E2E Sidebar Codex ${runId}`;
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
    await roomsApi.registerAgent(secondAgentName, '🧭', '#0ea5e9', { runtime: 'codex' });

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

  test('measures 272px wide, puts every row on its geometry token, and draws no hairlines', async ({
    page,
    dashboardSidebar,
  }) => {
    // **D1's geometry, measured in a real browser rather than asserted from
    // classes.** The density is the visible half of this redesign: 272px of
    // panel, every row's glyph slot on `--sidebar-row-x` and a section's
    // members exactly one `--sidebar-nested-x` deeper, and separation by tint
    // rather than by a 1px line (spec R1).
    //
    // **Read out of the live document, never restated here.** This used to
    // assert a bare `16`, the number design-decisions §11 fixed before
    // `specs/sidebar-simplification` D1 replaced the three stacked literals
    // with three tokens. A hard-coded number goes green on a build where the
    // token says something else and every row has moved — which is the one
    // failure this test exists to catch.
    const panel = dashboardSidebar.panel;
    await expect(panel).toBeVisible();

    const panelBox = await panel.boundingBox();
    expect(panelBox?.width).toBe(272);

    // **Measured on a CALLER-INDEPENDENT selector.** `[data-sidebar-row]` is
    // stamped by `SidebarRow` itself, so a section that opted out of the
    // primitive contributes no matches at all — the loop would iterate over
    // nothing and the bar would pass on whatever was left. Asking the DOM for
    // "every row control in a sidebar list", however it was built, is what
    // actually catches the opt-out this test claims to catch.
    //
    // The two exclusions are structural, not convenient: a "⋮" is a satellite
    // in the row's own gutter rather than a row, and an `aria-expanded` button
    // in a list is a reveal affordance ("+ 2 automated") rather than a
    // destination.
    const rowControls = dashboardSidebar.rowControls;
    const controlCount = await rowControls.count();

    // Seeded by `beforeEach`, so the floor is a fact rather than a hope: this
    // install has at least the registered agent's row plus the seeded #team
    // channel. A `> 0` floor would have passed on an empty sidebar.
    expect(controlCount).toBeGreaterThanOrEqual(2);
    await expect(dashboardSidebar.agentRow(agentName)).toBeVisible();

    // Not one of them opted out of the shared primitive. This is the comparison
    // the caller-independent selector makes possible: a hand-rolled row raises
    // `controlCount` and leaves `primitiveCount` behind. Named rather than
    // counted, so a failure says which section did it.
    expect(await dashboardSidebar.optedOutRowControls()).toEqual([]);
    expect(await dashboardSidebar.rows.count()).toBe(controlCount);

    // …and every one of them starts on the token its level owes: `row-x` for a
    // top-level row, `row-x + nested-x` for a section's member. Asserted per
    // row against its OWN nesting depth rather than as a set of allowed
    // numbers, so a top-level row that drifted into the nested inset (or the
    // reverse) is still a failure.
    const rowX = await token(page, '--sidebar-row-x');
    const nestedX = await token(page, '--sidebar-nested-x');
    let nestedRows = 0;
    for (let i = 0; i < controlCount; i++) {
      const row = rowControls.nth(i);
      const nested = await row.evaluate(
        (element) =>
          element.closest('[data-sidebar-section]')?.getAttribute('data-sidebar-section') ?? ''
      );
      const isNested = nested.startsWith('group:');
      if (isNested) nestedRows += 1;
      expect(
        await dashboardSidebar.rowInset(row),
        `a row in "${nested || 'the panel'}" is off its geometry token`
      ).toBe(isNested ? rowX + nestedX : rowX);
    }

    // **The nested half of that loop is not allowed to be vacuous.** The test
    // above this one drags an agent into a group, and `mode: 'serial'` is what
    // guarantees it has already run — so there IS a real `SidebarSection`
    // rendered with `isSubsection` on screen. Without this floor, a build that
    // stopped nesting rows entirely would pass the loop by never entering the
    // nested branch, which is precisely the regression `--sidebar-nested-x`
    // exists to prevent.
    expect(
      nestedRows,
      'no nested row was measured — the loop proved nothing about nesting'
    ).toBeGreaterThanOrEqual(1);

    // No `border-b` / `border-t` anywhere in the sidebar tree. The header's
    // underline and the footer's overline are the two that went; the assertion
    // is over the whole panel so a new one cannot creep back in either.
    //
    // **Read from COMPUTED STYLE, not from class names.** A class-name regex
    // has to enumerate every spelling an edge can arrive in — `border-b`,
    // `border-y`, a variant prefix like `data-[state=open]:border-b`, an
    // arbitrary value — and it is blind to a border applied from a stylesheet
    // rather than a utility. The browser has already resolved all of that.
    //
    // What counts is a HAIRLINE, not a border: an element with a visible top or
    // bottom edge and no matching side edges is a rule drawn between two things.
    // One with all four is a frame around one thing — the onboarding card's
    // dashed box, a rename field — which is a shape rather than a separator and
    // was never what R1 retired.
    const hairlines = await panel.evaluate((root) =>
      Array.from(root.querySelectorAll('*'))
        .map((el) => {
          const style = getComputedStyle(el);
          const visible = (side: string) => {
            const width = parseFloat(style.getPropertyValue(`border-${side}-width`));
            const alpha = style.getPropertyValue(`border-${side}-color`).match(/[\d.]+\)$/);
            if (style.getPropertyValue(`border-${side}-style`) === 'none') return false;
            if (!Number.isFinite(width) || width === 0) return false;
            return alpha === null || parseFloat(alpha[0]) > 0;
          };
          const horizontal = ['top', 'bottom'].filter(visible);
          const framed = visible('left') && visible('right');
          return horizontal.length > 0 && !framed
            ? `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} [${horizontal.join(',')}]`
            : null;
        })
        .filter((entry): entry is string => entry !== null)
    );
    expect(hairlines).toEqual([]);
  });

  test('reaches a row’s ⋮ from the keyboard, and reveals it on arrival', async ({
    page,
    dashboardSidebar,
  }) => {
    // WCAG (spec R2): hover-revealed chrome always has a non-pointer path.
    //
    // The path is ArrowRight from the row, not Tab. The "⋮" is a satellite of
    // its row — `useRovingFocus` keeps it out of the tab order so a 60-agent
    // Library is one Tab stop rather than 121 — so Tab is precisely the key
    // that must NOT reach it, and the arrow is the one that must.
    const row = dashboardSidebar.agentRow(agentName);
    await expect(row).toBeVisible();
    const kebab = row.locator('..').getByRole('button', { name: 'Agent actions' });

    await expect(kebab).toHaveCSS('opacity', '0');
    await expect(kebab).toHaveAttribute('tabindex', '-1');

    await row.focus();
    await page.keyboard.press('ArrowRight');

    await expect(kebab).toBeFocused();
    await expect(kebab).toHaveCSS('opacity', '1');

    // And back, so a reader who stepped out to a control steps back in.
    await page.keyboard.press('ArrowLeft');
    await expect(row).toBeFocused();
  });
});
