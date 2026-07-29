import { test, expect } from '../../fixtures';

/**
 * The fleet surface, which is a page now.
 *
 * This spec was `tests/mesh/mesh-panel.spec.ts` and drove a "Mesh agent
 * discovery" dialog through eight tests. That dialog does not exist: there is no
 * mesh entry in `DIALOG_CONTRIBUTIONS`, no component to render one, and the
 * palette's Agents entry navigates to `/agents`. Discovery moved out too — it is
 * the global "Bring in existing projects" dialog now, not a tab.
 *
 * So this is not the old spec with new selectors; it is the same intent — can
 * you reach the fleet, and do its views render? — rewritten against the surface
 * that replaced it. The four view modes below are the route's own `?view=` enum,
 * which is what makes them worth pinning.
 *
 * The view switcher marks the active view with a background colour and nothing
 * else — no `aria-current`, no `aria-pressed` — so the URL is the only honest
 * assertion available for "which view am I on".
 */
test.describe('Agents — fleet page @smoke', () => {
  test.beforeEach(async ({ basePage }) => {
    await basePage.goto();
    await basePage.waitForAppReady();
  });

  test('the sidebar reaches the agents page', async ({ page, basePage }) => {
    await basePage.ensureSidebarOpen();
    await page.getByTestId('nav-agents').click();

    await expect(page).toHaveURL(/\/agents/);
    await expect(page.getByRole('button', { name: 'New Agent' })).toBeVisible();
  });

  test('a registered agent is listed', async ({ page, basePage, roomsApi }) => {
    const agent = await roomsApi.registerAgent(`E2E Fleet ${roomsApi.runId}`, '🛰️', '#0ea5e9');

    // Seed first, then load: nothing pushes a mesh registration to an open page,
    // and the agent-paths query is cached for 30s.
    await page.goto('/agents');
    await basePage.waitForAppReady();

    // Scoped to the page body: a registered agent also appears in the sidebar
    // roster and in its row's action labels, so an unscoped text match finds
    // several and fails on strictness rather than on the fleet list.
    await expect(page.getByRole('main').getByText(agent.name).first()).toBeVisible();
  });

  test('switches to the topology view', async ({ page, basePage }) => {
    await page.goto('/agents');
    await basePage.waitForAppReady();

    await page.locator('header').getByRole('button', { name: 'Topology', exact: true }).click();
    await expect(page).toHaveURL(/[?&]view=topology/);
  });

  test('the Denied view reports having blocked nothing', async ({ page, basePage }) => {
    await page.goto('/agents?view=denied');
    await basePage.waitForAppReady();

    await expect(page.getByText('No blocked paths')).toBeVisible();
    await expect(
      page.getByText(
        'When you deny agent paths during discovery, they appear here. This is a healthy state.'
      )
    ).toBeVisible();
  });

  test('the Access view renders the cross-project access surface', async ({ page, basePage }) => {
    await page.goto('/agents?view=access');
    await basePage.waitForAppReady();

    // Which of the two it shows depends on how many namespaces the install has,
    // which depends on what else the run seeded — so accept either, and fail if
    // the view renders neither.
    const needsNamespaces = page.getByText('Cross-project access requires multiple namespaces');
    const namespaceList = page.getByRole('heading', { name: 'Namespaces' });
    await expect(needsNamespaces.or(namespaceList).first()).toBeVisible();
  });
});
