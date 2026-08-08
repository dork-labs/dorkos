import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../../fixtures';

/**
 * The Team page — everyone on this install, in one roster.
 *
 * This spec was `tests/agents/agents-page.spec.ts`, which drove the fleet page
 * at `/agents`. That page is gone: `/team` replaced it, `/agents` is a redirect,
 * and the fleet table is one of five views the Team page offers rather than the
 * page itself. So this is not the old spec with new selectors — the questions
 * are new ones ("is the person reading this on the roster, and can you tell an
 * agent from a person at a glance?") alongside the old one that survived
 * ("can you still reach every view?").
 *
 * The view switcher marks the active view with a background colour and nothing
 * else — no `aria-current`, no `aria-pressed` — so the URL is the only honest
 * assertion available for "which view am I on".
 */

/** A roster card, addressed by the identity it draws. */
function card(page: Page, name: string) {
  return page.getByRole('main').locator('[data-slot="team-member-card"]', { hasText: name });
}

/** Every card on the page, in render order. */
function cards(page: Page) {
  return page.getByRole('main').locator('[data-slot="team-member-card"]');
}

/**
 * Is this card's disc a circle?
 *
 * The shape IS the fix (spec §W1): a person is a circle, an agent is a filled
 * square with a Bot mark. There is no accessible name that carries it, so the
 * radius class is the assertion — brittle-looking, but it is the actual
 * contract, and a regression that redrew an agent as a person would change
 * exactly this.
 */
async function discIsCircle(cardLocator: Locator): Promise<boolean> {
  const cls = await cardLocator
    .locator('[data-slot="identity-avatar"]')
    .first()
    .getAttribute('class');
  return (cls ?? '').includes('rounded-full');
}

test.describe('Team — the roster @smoke', () => {
  test.beforeEach(async ({ basePage }) => {
    await basePage.goto();
    await basePage.waitForAppReady();
  });

  test('the sidebar reaches the Team page', async ({ page, basePage }) => {
    await basePage.ensureSidebarOpen();
    // The tour anchor kept its `nav-agents` id on purpose — renaming it would
    // strand every tour already in progress — so the nav's testid still reads
    // "agents" while its label says Team.
    await page.getByTestId('nav-agents').click();

    await expect(page).toHaveURL(/\/team/);
    await expect(page.getByRole('button', { name: 'New Agent' })).toBeVisible();
  });

  test('/agents redirects to /team, keeping the view', async ({ page, basePage }) => {
    // The alias exists for addresses this repo does not own: a bookmark, a docs
    // link, the Electron shell's persisted tab list. `?view=list` is the old
    // spelling of the table and has to land on it rather than 404.
    await page.goto('/agents?view=list');
    await basePage.waitForAppReady();

    await expect(page).toHaveURL(/\/team/);
    await expect(page).toHaveURL(/[?&]view=table/);
  });

  test('the operator is on the roster, drawn as a circle', async ({ page, basePage }) => {
    await page.goto('/team');
    await basePage.waitForAppReady();

    // The roster is never empty: the person reading it is on it. Their card is
    // first, and it is a circle.
    const first = cards(page).first();
    await expect(first).toBeVisible();
    await expect(first.getByText('you', { exact: true })).toBeVisible();
    const cls = await first.locator('[data-slot="identity-avatar"]').first().getAttribute('class');
    expect(cls).toContain('rounded-full');
  });

  test('an agent is drawn as a square, with who it belongs to', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const agent = await roomsApi.registerAgent(`E2E Team ${roomsApi.runId}`, '🛰️', '#0ea5e9');

    // Seed first, then load: nothing pushes a mesh registration to an open page.
    await page.goto('/team');
    await basePage.waitForAppReady();

    const agentCard = card(page, agent.name);
    await expect(agentCard).toBeVisible();
    expect(await discIsCircle(agentCard)).toBe(false);
    // The attribution is a control, not a caption — its label says what
    // pressing it does, which is the part the visible "by …" cannot carry.
    await expect(
      agentCard.getByRole('button', { name: /Show only .* and their agents/ })
    ).toBeVisible();
  });

  test('the Agents chip hides the people', async ({ page, basePage, roomsApi }) => {
    const agent = await roomsApi.registerAgent(`E2E Chip ${roomsApi.runId}`, '🧭', '#a855f7');
    await page.goto('/team');
    await basePage.waitForAppReady();
    await expect(card(page, agent.name)).toBeVisible();

    const before = await cards(page).count();
    await page
      .getByRole('group', { name: 'Filter by kind' })
      .getByRole('button', { name: 'Agents' })
      .click();

    await expect(page).toHaveURL(/[?&]kind=agents/);
    // The agent stays; the operator's card goes. Asserting the count dropped as
    // well as the flag being in the URL, so a chip that only wrote a param
    // would still fail here.
    await expect(card(page, agent.name)).toBeVisible();
    await expect(cards(page)).toHaveCount(before - 1);
  });

  test('clicking an attribution filters to that owner', async ({ page, basePage, roomsApi }) => {
    const agent = await roomsApi.registerAgent(`E2E Owner ${roomsApi.runId}`, '🦉', '#f59e0b');
    await page.goto('/team');
    await basePage.waitForAppReady();

    await card(page, agent.name)
      .getByRole('button', { name: /Show only .* and their agents/ })
      .click();

    await expect(page).toHaveURL(/[?&]owner=/);
    await expect(page.getByText(/Showing .* and their agents/)).toBeVisible();
  });

  test('Group: manager clusters the roster under a header', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const agent = await roomsApi.registerAgent(`E2E Group ${roomsApi.runId}`, '🐝', '#22c55e');
    await page.goto('/team');
    await basePage.waitForAppReady();
    await expect(card(page, agent.name)).toBeVisible();

    await page.getByRole('button', { name: 'Group: manager' }).click();

    await expect(page).toHaveURL(/[?&]group=manager/);
    await expect(page.getByRole('main').locator('[data-slot="team-roster-groups"]')).toBeVisible();
    await expect(page.getByRole('main').getByRole('heading', { level: 2 }).first()).toBeVisible();
  });

  test('a filtered roster survives a reload', async ({ page, basePage }) => {
    // The whole point of the controls writing to the URL: a narrowed roster is
    // an address someone can send, and sending it has to work.
    await page.goto('/team?kind=agents&group=manager');
    await basePage.waitForAppReady();
    await page.reload();
    await basePage.waitForAppReady();

    await expect(page).toHaveURL(/[?&]kind=agents/);
    await expect(page).toHaveURL(/[?&]group=manager/);
    await expect(
      page.getByRole('group', { name: 'Filter by kind' }).getByRole('button', { name: 'Agents' })
    ).toHaveAttribute('aria-pressed', 'true');
  });

  test('the view switch reaches the table and the topology', async ({ page, basePage }) => {
    await page.goto('/team');
    await basePage.waitForAppReady();

    await page.locator('header').getByRole('button', { name: 'Table', exact: true }).click();
    await expect(page).toHaveURL(/[?&]view=table/);

    await page.locator('header').getByRole('button', { name: 'Topology', exact: true }).click();
    await expect(page).toHaveURL(/[?&]view=topology/);
  });

  test('the Denied view reports having blocked nothing', async ({ page, basePage }) => {
    await page.goto('/team?view=denied');
    await basePage.waitForAppReady();

    await expect(page.getByText('No blocked paths')).toBeVisible();
    await expect(
      page.getByText(
        'When you deny agent paths during discovery, they appear here. This is a healthy state.'
      )
    ).toBeVisible();
  });

  test('the Access view renders the cross-project access surface', async ({ page, basePage }) => {
    await page.goto('/team?view=access');
    await basePage.waitForAppReady();

    // Which of the two it shows depends on how many namespaces the install has,
    // which depends on what else the run seeded — so accept either, and fail if
    // the view renders neither.
    const needsNamespaces = page.getByText('Cross-project access requires multiple namespaces');
    const namespaceList = page.getByRole('heading', { name: 'Namespaces' });
    await expect(needsNamespaces.or(namespaceList).first()).toBeVisible();
  });
});

test.describe('Team — on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('draws one column and keeps the chips on one line', async ({ page, basePage, roomsApi }) => {
    const agent = await roomsApi.registerAgent(`E2E Phone ${roomsApi.runId}`, '📱', '#38bdf8');
    await page.goto('/team');
    await basePage.waitForAppReady();
    await expect(card(page, agent.name)).toBeVisible();

    const boxes = await cards(page).evaluateAll((nodes: Element[]) =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        return { x: Math.round(rect.x), y: Math.round(rect.y) };
      })
    );
    expect(boxes.length).toBeGreaterThan(1);
    // One column: every card starts at the same x, and no two share a y.
    expect(new Set(boxes.map((box) => box.x)).size).toBe(1);
    expect(new Set(boxes.map((box) => box.y)).size).toBe(boxes.length);

    // The chip row scrolls sideways rather than wrapping — a wrapped row is
    // three lines of chrome above two cards, so the chips stay on one line.
    const chipTops = await page
      .getByRole('group', { name: 'Filter by kind' })
      .getByRole('button')
      .evaluateAll((nodes: Element[]) =>
        nodes.map((node) => Math.round(node.getBoundingClientRect().y))
      );
    expect(chipTops.length).toBe(3);
    expect(new Set(chipTops).size).toBe(1);
  });

  test('does not offer the table', async ({ page, basePage }) => {
    await page.goto('/team');
    await basePage.waitForAppReady();

    // Below `md` the switch is a Select, and the table is deliberately not in
    // it: six columns at 375px is a scroll bar wearing a table.
    await page.locator('header').getByRole('combobox').click();
    await expect(page.getByRole('option', { name: 'Cards' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Topology' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Table' })).toHaveCount(0);
  });
});
