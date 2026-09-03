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
    // `exact` is load-bearing: the sidebar's Agents-section "+" is labelled
    // "New agent" (P2.4), and role-name matching is case-insensitive by
    // default — without it this resolves two buttons and strict mode throws.
    // Case-sensitive matching pins the PAGE's own button, capital A.
    await expect(page.getByRole('button', { name: 'New Agent', exact: true })).toBeVisible();
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

  test('the whole card opens that identity’s profile', async ({ page, basePage, roomsApi }) => {
    const agent = await roomsApi.registerAgent(`E2E Profile ${roomsApi.runId}`, '🪪', '#6366f1');
    await page.goto('/team');
    await basePage.waitForAppReady();

    const agentCard = card(page, agent.name);
    await expect(agentCard).toBeVisible();
    const memberId = await agentCard.getAttribute('data-member-id');

    await agentCard.getByRole('button', { name: `Open ${agent.name}’s profile` }).click();

    // The id on the URL is the assertion, not "a drawer appeared": the drawer
    // reads `?profile=` back against the roster, so a card that handed over an
    // id from any other space would open nothing at all.
    await expect(page).toHaveURL(new RegExp(`[?&]profile=${memberId}`));
    await expect(page.locator('[data-slot="profile"]')).toHaveAttribute(
      'data-member-id',
      memberId!
    );

    // …and it survives a reload, which is what makes a profile shareable.
    await page.reload();
    await basePage.waitForAppReady();
    await expect(page.locator('[data-slot="profile"]')).toHaveAttribute(
      'data-member-id',
      memberId!
    );
  });

  test('the table’s View profile opens the same profile the cards do', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    // One page, one answer (spec `profile-unification` §1.6). The table used to
    // dock the profile in the right panel while the cards beside it opened the
    // sheet — the same page answering "show me this agent" two different ways.
    // The mesh id is the assertion for the same reason it is on the card: the
    // table knows an agent by its DIRECTORY, and a row that handed that over
    // would open a sheet that finds nobody.
    const agent = await roomsApi.registerAgent(`E2E Table ${roomsApi.runId}`, '🧮', '#14b8a6');
    await page.goto(`/team?view=table&q=${encodeURIComponent(agent.name)}`);
    await basePage.waitForAppReady();

    // Scoped to the roster table: the sidebar draws the same agent with the same
    // accessible name (its face is a profile control too), so a page-wide query
    // is ambiguous by design, not by accident.
    await page
      .getByRole('row', { name: new RegExp(agent.name) })
      .getByRole('button', { name: `Open ${agent.name}’s profile` })
      .click();

    await expect(page).toHaveURL(new RegExp(`[?&]profile=${agent.id}`));
    await expect(page.locator('[data-slot="profile"]')).toHaveAttribute('data-member-id', agent.id);
  });

  test('the card’s hit area covers the whole tile, but not its own attribution', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const agent = await roomsApi.registerAgent(`E2E Hit ${roomsApi.runId}`, '🎯', '#ef4444');
    await page.goto('/team');
    await basePage.waitForAppReady();

    const agentCard = card(page, agent.name);
    await expect(agentCard).toBeVisible();
    await agentCard.scrollIntoViewIfNeeded();

    // **A paint-order check, and it belongs HERE and nowhere else.** The card's
    // reach is a `::after` overlay on the name button; the attribution stays
    // pressable because it is `relative` and so paints ABOVE that overlay. Both
    // halves are layout facts — jsdom computes no layout, so a jsdom test
    // passes just as happily with the stacking removed, and the double-fire it
    // is supposed to catch ships. `elementFromPoint` is the honest question:
    // what would a real click at this pixel actually land on?
    const hits = await agentCard.evaluate((node: Element) => {
      const rect = node.getBoundingClientRect();
      const attribution = node.querySelector('button[aria-label^="Show only"]');
      const attrRect = attribution!.getBoundingClientRect();
      const at = (x: number, y: number) =>
        document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label') ?? null;
      return {
        middle: at(rect.left + rect.width / 2, rect.top + rect.height / 2),
        bottomRight: at(rect.right - 12, rect.bottom - 8),
        attribution: at(attrRect.left + attrRect.width / 2, attrRect.top + attrRect.height / 2),
      };
    });

    const profileLabel = `Open ${agent.name}’s profile`;
    expect(hits.middle).toBe(profileLabel);
    expect(hits.bottomRight).toBe(profileLabel);
    // The inner control takes its own press. Red the moment the attribution
    // loses the `relative` that lifts it out from under the overlay.
    expect(hits.attribution).toMatch(/^Show only /);
  });

  test('an agent’s badge wakes when you point at its card', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    // The signature moment, asserted where it actually lives. Two things make
    // this worth a browser test rather than a class-string check:
    //
    // Tailwind v4 emits `rotate:` and `scale:` as their OWN properties, so a
    // test reading `transform` would see `none` while the badge was plainly
    // tilted — and the first version of this fix was measured that way and
    // looked broken when it was not.
    //
    // And the wake is keyed to the CARD, not the disc, because the name
    // button's stretched overlay owns the disc's pixels — the disc never
    // receives `:hover`. That is invisible to jsdom, which has no hit testing,
    // and it is exactly what shipped dead the first time.
    const agent = await roomsApi.registerAgent(`E2E Wake ${roomsApi.runId}`, '🦊', '#8b5cf6');
    await page.goto('/team');
    await basePage.waitForAppReady();

    const agentCard = card(page, agent.name);
    await expect(agentCard).toBeVisible();
    const badge = agentCard.locator('[data-slot="identity-badge"]').first();

    const rotateOf = () => badge.evaluate((node) => getComputedStyle(node).rotate);

    await page.mouse.move(0, 0);
    await expect.poll(rotateOf).toBe('none');

    await agentCard.hover();
    await expect.poll(rotateOf).toBe('-6deg');
    expect(await badge.evaluate((node) => getComputedStyle(node).scale)).toBe('1.1');

    // And it settles back, so the tilt is a response and not a new resting pose.
    await page.mouse.move(0, 0);
    await expect.poll(rotateOf).toBe('none');
  });

  test('Group by owner clusters the roster under a header', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const agent = await roomsApi.registerAgent(`E2E Group ${roomsApi.runId}`, '🐝', '#22c55e');
    await page.goto('/team');
    await basePage.waitForAppReady();
    await expect(card(page, agent.name)).toBeVisible();

    await page.getByRole('button', { name: 'Group by owner' }).click();

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

    // The switch is a tab strip of LINKS now, not buttons — each view is an
    // address, so it can be middle-clicked, copied, and bookmarked.
    const views = page.getByRole('navigation', { name: 'Team views' });

    await views.getByRole('link', { name: 'Table' }).click();
    await expect(page).toHaveURL(/[?&]view=table/);

    await views.getByRole('link', { name: 'Topology' }).click();
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

    // Which of the two it shows depends on how many projects the install has,
    // which depends on what else the run seeded — so accept either, and fail if
    // the view renders neither.
    const needsProjects = page.getByText('You need agents in more than one project');
    const projectList = page.getByRole('heading', { name: 'Projects' });
    await expect(needsProjects.or(projectList).first()).toBeVisible();
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

  test('offers every view, the table included', async ({ page, basePage }) => {
    await page.goto('/team');
    await basePage.waitForAppReady();

    // This test used to assert the opposite, and the inversion is the point.
    // Below `md` the switch was a `<Select>` that deliberately withheld the
    // table — and then had to smuggle it back whenever you were already on it,
    // because a Select whose value matches no item renders blank. The strip
    // scrolls sideways instead, so there is one list at every width: nothing
    // hidden, nothing conditionally un-hidden.
    await expect(page.locator('header').getByRole('combobox')).toHaveCount(0);

    const views = page.getByRole('navigation', { name: 'Team views' });
    for (const name of ['Cards', 'Table', 'Topology', 'Denied', 'Access']) {
      await expect(views.getByRole('link', { name })).toBeVisible();
    }

    // Present is not the same as reachable at 375px: the last tabs start
    // outside the strip's box, so this also proves the scroller gets them
    // under the finger.
    await views.getByRole('link', { name: 'Table' }).click();
    await expect(page).toHaveURL(/[?&]view=table/);
  });

  test('keeps the New Agent action reachable as an icon', async ({ page, basePage }) => {
    await page.goto('/team');
    await basePage.waitForAppReady();

    // The words are dropped below `md` to buy the view names their width, but
    // the bar's only write action keeps its accessible name and stays a target
    // the size of the tabs beside it.
    const newAgent = page.locator('header').getByRole('button', { name: 'New Agent' });
    await expect(newAgent).toBeVisible();
    await expect(newAgent).toHaveText('');

    const box = await newAgent.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(32);
  });
});
