import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { describeViolation, runAxe } from '../../axe';

/**
 * What the a11y sweep below is pointed at: the sidebar panel, and none of the
 * app around it. The same node `DashboardSidebarPage.panel` locates.
 */
const SIDEBAR_PANEL = '[data-slot="sidebar-inner"]';

/**
 * The empty-section placeholder, matched as a PATTERN rather than a literal.
 *
 * The subject here is "this section has nothing in it", not the exact wording.
 * The literal `'Drag agents here'` broke when DOR-581 widened the copy, and that
 * failure sat on `main` for days because neither `test` nor `browser-test` is a
 * required check. A pattern survives the next rewording — DOR-1371 was one —
 * while still asserting the placeholder is the thing on screen.
 *
 * Source of truth: `useSectionChrome.tsx`, the section branch's `footer` — the
 * one section allowed to render with no rows, because the operator made it.
 */
const EMPTY_GROUP_PLACEHOLDER = /Drag .*here/;

/**
 * What one of the sidebar's geometry tokens resolves to, in pixels.
 *
 * The same reader `sidebar-row-gutter.spec.ts` uses, and for the same reason:
 * `--sidebar-header-x` and `--sidebar-row-x` are the one
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
 * section create → drag-into-section → reload persistence, driven by real
 * pointer events against the actual dnd-kit `PointerSensor`.
 *
 * No Claude SDK / API key involved — sidebar organization is pure `ui.sidebar`
 * config plus mesh registration, so this stays a fast `@smoke` test.
 */
test.describe('Dashboard Sidebar — Sections @smoke', () => {
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
   * Making a section by hand is offered to everybody now (D3), so this is no
   * longer what unlocks the menu. It stays because the SMART presets are still
   * gated on two runtimes or eight agents, and because a second agent is what
   * makes "the one that was dragged" a real distinction rather than a tautology.
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

    // …and it sits on the SAME x as a row in Channels. Sections are peers now
    // (D3), so the panel is two levels — one header x, one row x — and a
    // member's row is not indented at all. **Asserted HERE, in the one test
    // guaranteed to have a member**, against the real `SidebarSection` rather
    // than the Dev Playground's hand-written padding: a copy that happens to
    // agree is what let a contrast defect hide from its own gate once already.
    const rowX = await token(page, '--sidebar-row-x');
    const memberInset = await dashboardSidebar.rowInset(
      group.locator('[data-sidebar-row]').filter({ hasText: agentName }).first()
    );
    const topLevelInset = await dashboardSidebar.rowInset(
      dashboardSidebar.panel.locator('[data-sidebar-section="channels"] [data-sidebar-row]').first()
    );
    expect(memberInset, 'a section’s member is off the row token').toBe(rowX);
    expect(memberInset, 'a section’s member is indented from a top-level row').toBe(topLevelInset);

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

  test('takes a CHANNEL into a section, and files it there', async ({
    request,
    roomsApi,
    basePage,
    dashboardSidebar,
  }) => {
    // A section has held rooms since DOR-581 and looked agent-only the whole
    // time; D3 is what says otherwise on screen, so the browser suite has to
    // drag one.
    const slug = `e2e-sec-${runId}`;
    await roomsApi.createChannel(slug);
    await basePage.goto();
    await basePage.waitForAppReady();
    await basePage.ensureSidebarOpen();

    await dashboardSidebar.createGroup(groupName);
    const group = dashboardSidebar.groupContainer(groupName);
    await expect(group).toBeVisible();

    // **Scoped to Channels, not to the panel.** The same room also draws a row
    // in Today once anything happens in it, and a Today row is not a drag source
    // (R3) — a press on that copy arms nothing and the drop reports "never came
    // to rest", which reads as a DnD regression and is not one.
    const channels = dashboardSidebar.panel.locator('[data-sidebar-section="channels"]');
    const channel = channels.locator('[data-sidebar-row]').filter({ hasText: slug });
    await expect(channel).toBeVisible();
    await dashboardSidebar.dragRowIntoGroup(channel, groupName);

    await expect(group).toContainText(slug);
    await expect(group).not.toContainText(EMPTY_GROUP_PLACEHOLDER);

    // …and it left Channels rather than being drawn in both places: a section's
    // members leave their home list, which is the membership rule the sidebar
    // has always had.
    await expect(channels.locator('[data-sidebar-row]').filter({ hasText: slug })).toHaveCount(0);

    // The stored membership, independent of DOM timing: one ROOM reference.
    const config = (await (await request.get('/api/config')).json()) as {
      ui: { sidebar: { groups: { name: string; items: { kind: string }[] }[] } };
    };
    const persisted = config.ui.sidebar.groups.find((g) => g.name === groupName);
    expect(persisted?.items.map((item) => item.kind)).toEqual(['room']);
  });

  test('lands "New section…" from a ROOM row above the first section', async ({
    page,
    roomsApi,
    basePage,
    dashboardSidebar,
  }) => {
    // Defect #9: the name field mounted under Agents wherever the flow was
    // started from, so asking for a section from a channel put a focused text
    // box below thirty agent rows, off the bottom of a 272px panel. It mounts at
    // the top of Library now, which is one predictable place (D3).
    const slug = `e2e-menu-${runId}`;
    await roomsApi.createChannel(slug);
    await basePage.goto();
    await basePage.waitForAppReady();
    await basePage.ensureSidebarOpen();

    await dashboardSidebar.createGroup(groupName);
    // Scoped to the LIBRARY zone: Getting started is a section too, and it sits
    // at the top of the panel on a day-one install.
    const firstSection = dashboardSidebar.panel
      .locator('[data-sidebar-zone="library"] [data-sidebar-section]')
      .first();
    await expect(firstSection).toHaveAttribute('data-sidebar-section', /^group:/);

    const channel = dashboardSidebar.panel
      .locator('[data-sidebar-section="channels"] [data-sidebar-row]')
      .filter({ hasText: slug });
    await expect(channel).toBeVisible();

    // **The RIGHT-CLICK path, on purpose.** The two menus are one node list, so
    // this looks like a detail — and it is the path that was broken for a
    // release: Radix restores focus as it closes, the name field mounted and
    // blur-cancelled itself in the same frame, and the item read as inert while
    // the "⋮" beside it worked (DOR-1371). Only a browser can see that. The
    // submenu is opened with the keyboard rather than a hover, which has its own
    // delay and races.
    await channel.click({ button: 'right' });
    const moveTo = page.getByRole('menuitem', { name: 'Move to section' });
    await moveTo.waitFor({ state: 'visible' });
    await moveTo.press('ArrowRight');
    await page.getByRole('menuitem', { name: 'New section…' }).click();

    const input = page.getByRole('textbox', { name: 'New section name' });
    await expect(input).toBeFocused();
    // Still there a beat later: the defect was a field that existed for less
    // than one frame, which an immediate assertion could have caught by luck.
    await page.waitForTimeout(400);
    await expect(input).toBeFocused();

    // Above the first section, measured rather than assumed: the field's box
    // starts before the first section header's does.
    const inputBox = await input.boundingBox();
    const headerBox = await dashboardSidebar.groupHeader(groupName).boundingBox();
    expect(inputBox!.y).toBeLessThan(headerBox!.y);

    await input.press('Escape');
  });

  test('measures 272px wide, puts every row on its geometry token, and draws no hairlines', async ({
    page,
    dashboardSidebar,
  }) => {
    // **D1's geometry, measured in a real browser rather than asserted from
    // classes.** The density is the visible half of this redesign: 272px of
    // panel, every row's glyph slot on `--sidebar-row-x` whatever section it is
    // in, and separation by tint rather than by a 1px line (spec R1).
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

    // …and every one of them starts on `--sidebar-row-x`. One number, because
    // there is one row level: a section's members are rows of a peer section
    // rather than of a nested one (D3), so nothing in the panel is indented.
    const rowX = await token(page, '--sidebar-row-x');

    // **Every row read in ONE page evaluation, not a round trip each.** A
    // per-row `nth(i).evaluate()` loop re-resolves the locator against a live
    // sidebar that is still settling queries, so a list that shortens between
    // the count and the eighth row leaves Playwright waiting 30s for an index
    // that no longer exists — which is exactly how this timed out. One
    // `evaluateAll` also makes the measurement atomic: every row is read from
    // the same frame, so the set cannot be half old and half new.
    const measured = await rowControls.evaluateAll(
      (nodes, panelLeft) =>
        nodes.map((node) => {
          const box = node.getBoundingClientRect();
          const padding = parseFloat(getComputedStyle(node).paddingLeft);
          return {
            section:
              node.closest('[data-sidebar-section]')?.getAttribute('data-sidebar-section') ?? '',
            // The row's CONTENT-box left, which is where a reader sees the row
            // start — the same arithmetic `DashboardSidebarPage.rowInset` uses.
            inset: Math.round(box.left + padding - panelLeft),
          };
        }),
      panelBox!.x
    );
    expect(measured.length).toBe(controlCount);

    for (const row of measured) {
      expect(row.inset, `a row in "${row.section || 'the panel'}" is off its geometry token`).toBe(
        rowX
      );
    }

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

  test('nests no interactive control inside another, drag layer and all', async ({
    page,
    dashboardSidebar,
  }) => {
    // DOR-1418. dnd-kit defaults a draggable to `role="button"`, and the sidebar
    // makes whole ROWS draggable — so every agent row, every channel row and
    // (since sections became draggable top-level) every section header carried a
    // `button` wrapped around the real `<button>` inside it. axe called that
    // `nested-interactive`, twenty-one times on a working panel, and a screen
    // reader announces a control nested inside another unreliably or not at all.
    //
    // **Asserted against the REAL panel, not the Dev Playground.** The showcase
    // page draws rows without a `DndContext`, so the drag layer is off there and
    // its axe sweep could never have seen this. Here the layer is live, which is
    // the only place the wrapper exists at all.
    //
    // A group is created first because a user-made section is what makes a
    // section HEADER a drag source; the rows are draggable either way.
    await dashboardSidebar.createGroup(groupName);
    await expect(dashboardSidebar.groupContainer(groupName)).toBeVisible();
    await expect(dashboardSidebar.agentRow(agentName)).toBeVisible();

    // **The role, read off every drag root directly.** Measured on the broken
    // build, this seeded panel held five drag roots and every one of them wore
    // `role="button"`. The role is the single thing the fix changed, so it is
    // asserted as itself rather than only through what axe infers from it —
    // a direct reading cannot go undecided, and it names the offending count in
    // its own failure message. axe below is then the independent second opinion
    // on the same panel: it, not this, is what says the nesting is really gone.
    const dragRoots = page.locator(`${SIDEBAR_PANEL} [aria-roledescription="sortable"]`);
    const roles = await dragRoots.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('role'))
    );
    expect(
      roles.length,
      'the drag layer put no sortable root in the panel, so nothing below proves anything'
    ).toBeGreaterThan(0);
    expect(
      [...new Set(roles)].sort(),
      `${roles.length} sortable drag roots in the panel, and at least one wears a role other than the container role`
    ).toEqual(['group']);

    // One rule, not the whole default set: this spec asks one question about one
    // widget, and the page-wide sweep the showcase spec runs is what answers the
    // rest.
    const results = await runAxe(page, SIDEBAR_PANEL, ['nested-interactive']);
    // **Violations AND `incomplete` together.** "axe could not decide" is not a
    // pass, and a rule that goes undecided is exactly how a defect hides from
    // the gate written to catch it (the same lesson the showcase spec's
    // `color-contrast` allowlist is built on).
    expect(
      [...results.violations, ...results.incomplete].map(describeViolation),
      'the sidebar nests interactive controls — see DOR-1418, the drag root must not wear a widget role'
    ).toEqual([]);
    // The rule has to have actually run: axe reports an empty `violations` for a
    // context it never evaluated just as happily as for a clean one.
    expect(
      results.passes.map((pass) => pass.id),
      'axe did not evaluate nested-interactive on the sidebar at all, so the empty violation list means nothing'
    ).toContain('nested-interactive');
  });
});
