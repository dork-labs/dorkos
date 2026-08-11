import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';

/**
 * The session switcher, in a browser — which is the only place most of it is
 * true.
 *
 * Two of the three defects found while building this surface were invisible to
 * jsdom, and the one jsdom guard written for them did not discriminate: React
 * Testing Library reproduced neither the ref-identity loss across a group move
 * nor the mobile footer that kept its verbs and lost its key glyphs (`Kbd` is
 * `hidden md:inline-flex`, which has no meaning without a stylesheet). So the
 * guard belongs here.
 *
 * **Two legs, for two different reasons.**
 *
 * - The **playground** leg drives `/dev/features`, which seeds its own store
 *   and asks the server for nothing — so it is `@smoke`, and it is where the
 *   structural and responsive contracts live.
 * - The **cockpit** leg drives the real ⌘K path with the real `HttpTransport`
 *   and only the server's ANSWERS stubbed, because two things cannot be seen
 *   without a real session id in the URL and a real POST on the wire: the
 *   current-session tag, and `⇧↵` reaching `forkSession`.
 */

/** The playground page carrying the switcher showcase. */
const SHOWCASE_PATH = '/dev/features';

/** Every session row the switcher draws, whichever group it landed in. */
const ROW = '[data-slot="session-switcher-row"]';

/** Open the showcase's switcher and wait for its rows. */
async function openShowcaseSwitcher(page: Page): Promise<void> {
  await page.goto(SHOWCASE_PATH);
  await page.getByRole('button', { name: /Open code-reviewer sessions/ }).click();
  await expect(page.locator(ROW).first()).toBeVisible();
}

/** The group headings on screen, in DOM order. */
async function groupOrder(page: Page): Promise<string[]> {
  return page
    .locator('h3')
    .filter({ hasText: /^(Live now|Recent|Automated)$/ })
    .allTextContents();
}

test.describe('session switcher @smoke', () => {
  test('groups an agent’s sessions Live now / Recent / Automated, with Automated collapsed', async ({
    page,
  }) => {
    await openShowcaseSwitcher(page);

    expect(await groupOrder(page)).toEqual(['Live now', 'Recent', 'Automated']);

    // Three concurrent turns are three rows. BC-35 is explicit that they are
    // never rolled up, so the absence of a summary is asserted alongside the
    // presence of the rows it would have replaced.
    const liveRows = page.locator('section[aria-label="Live now"]').locator(ROW);
    await expect(liveRows).toHaveCount(3);
    await expect(page.locator('section[aria-label="Live now"]')).not.toContainText('3 sessions');

    // Each live row carries its own verb, off the activity fan-out.
    await expect(liveRows.nth(0)).toContainText('Editing RoomRow.tsx');
    await expect(liveRows.nth(1)).toContainText('Reading CHANGELOG.md');

    // Recent rows carry outcomes instead.
    await expect(page.locator('section[aria-label="Recent"]').locator(ROW)).toHaveCount(2);
    await expect(page.locator('section[aria-label="Recent"]')).toContainText(
      'Settled on a two-tier submit flow'
    );

    // Automated is collapsed: the reveal is there, its rows are not.
    const reveal = page.locator('section[aria-label="Automated"] button').first();
    await expect(reveal).toHaveText('+ 2 automated');
    await expect(reveal).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('section[aria-label="Automated"]').locator(ROW)).toHaveCount(0);

    await reveal.click();
    await expect(page.locator('section[aria-label="Automated"]').locator(ROW)).toHaveCount(2);
  });

  test('is a dialog on the desktop and a bottom sheet on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openShowcaseSwitcher(page);
    await expect(page.locator('[role="dialog"]')).toBeVisible();
    await expect(page.locator('[data-vaul-drawer]')).toHaveCount(0);
    // The key legend belongs to the surface that has keys.
    await expect(page.locator('footer')).toContainText('↵ continue');
    await expect(page.getByRole('button', { name: 'New session' })).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await openShowcaseSwitcher(page);
    const sheet = page.locator('[data-vaul-drawer]');
    await expect(sheet).toBeVisible();
    // A bottom sheet, not a centred box: flush to the bottom edge, full width.
    //
    // Measured in VIEWPORT coordinates, not through `boundingBox()`. The sheet
    // is `position: fixed` while the playground page behind it scrolls, and
    // Playwright's box is document-relative — so on a scrolled page it reports
    // the sheet hundreds of pixels below the fold and the assertion fails on a
    // surface that is sitting exactly where it should. `getBoundingClientRect`
    // is already viewport-relative, which is the frame this claim is about.
    //
    // Polled because vaul animates in: the resting position is the contract,
    // not whichever frame the assertion happened to catch.
    await expect
      .poll(async () =>
        sheet.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return {
            bottomGap: Math.round(window.innerHeight - rect.bottom),
            widthGap: Math.round(window.innerWidth - rect.width),
          };
        })
      )
      .toEqual({ bottomGap: 0, widthGap: 0 });

    // The legend named keys a phone does not have; it is replaced, not hidden.
    await expect(page.locator('footer')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'New session' })).toBeVisible();
    // Still the same three groups underneath.
    expect(await groupOrder(page)).toEqual(['Live now', 'Recent', 'Automated']);
  });

  test('each footer key does what the footer says it does', async ({ page }) => {
    const lastAction = page.locator('[data-slot="switcher-last-action"]');

    // `↵` continues the FOCUSED row — the second, so "the focused one" can never
    // be confused with "the first one".
    await openShowcaseSwitcher(page);
    await page.locator(ROW).nth(1).focus();
    await page.keyboard.press('Enter');
    await expect(lastAction).toHaveText('continue sw-live-2');

    // `⌘↵` starts a new session instead of continuing the focused one. Without
    // the keydown interception the browser would activate the button too, so
    // this failing means the modifier was swallowed.
    await openShowcaseSwitcher(page);
    await page.locator(ROW).nth(1).focus();
    await page.keyboard.press('Meta+Enter');
    await expect(lastAction).toHaveText('new session');
  });

  test('opens from the agent row’s "N live" chip, and the chip clears the row’s text', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(SHOWCASE_PATH);

    const chip = page.getByRole('button', { name: /live sessions — open the session switcher/ });
    await expect(chip.first()).toBeVisible();
    await expect(chip.first()).toContainText('3 live');

    // The chip is a satellite of the row, never a button inside one.
    const nested = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button[aria-label*="session switcher"]')).some(
        (b) => b.parentElement?.closest('button') !== null
      )
    );
    expect(nested).toBe(false);

    // It sits over the space the trailing slot reserved, not over the name.
    // `sidebar-row.tsx` writes `pr-7` and then `px-2`, and tailwind-merge keeps
    // the second — so a chip positioned against the SOURCE gutter lands 20px
    // left of its reservation and paints over the truncated agent name.
    const geometry = await page.evaluate(() => {
      const button = document.querySelector<HTMLElement>('button[aria-label*="session switcher"]')!;
      const row = button
        .closest('li')!
        .querySelector<HTMLElement>('[data-slot="agent-list-item"]')!;
      const title = row.querySelector<HTMLElement>('[data-testid], span')!;
      return {
        rowRight: row.getBoundingClientRect().right,
        rowPaddingRight: getComputedStyle(row).paddingRight,
        chipLeft: button.getBoundingClientRect().left,
        chipRight: button.getBoundingClientRect().right,
        titleRight: title.getBoundingClientRect().right,
      };
    });
    // The chip's right edge sits exactly one row-padding in from the row's edge.
    const padding = Number.parseFloat(geometry.rowPaddingRight);
    expect(Math.round(geometry.rowRight - geometry.chipRight)).toBe(Math.round(padding));
    // And it never overlaps the row's own text.
    expect(geometry.chipLeft).toBeGreaterThanOrEqual(geometry.titleRight - 1);

    await chip.first().click();
    await expect(page.locator(ROW).first()).toBeVisible();
    expect(await groupOrder(page)).toEqual(['Live now', 'Recent', 'Automated']);
  });
});

/**
 * The cockpit leg: the real palette, the real transport, stubbed answers.
 *
 * Not `@smoke` — it drives the app rather than a playground page.
 */
test.describe('session switcher, from ⌘K', () => {
  const AGENT_SESSIONS = [
    sessionFixture('11111111-1111-4111-8111-111111111111', 'Dashboard overhaul'),
    sessionFixture('22222222-2222-4222-8222-222222222222', 'Release notes draft'),
  ];

  /** A session row as the list endpoint would return it. */
  function sessionFixture(id: string, title: string, cwd = '') {
    return {
      id,
      title,
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      updatedAt: new Date(Date.now() - 300_000).toISOString(),
      permissionMode: 'default',
      runtime: 'claude-code',
      cwd,
    };
  }

  test('opens from the agent sub-menu, tags the open session, and forks with ⇧↵', async ({
    page,
    roomsApi,
    basePage,
  }) => {
    // Seeded rather than borrowed. Reading "whatever agent the cockpit booted
    // with" made this test SKIP itself on a clean install, and a skipped test
    // guards nothing — which is the whole failure mode this file exists to
    // avoid. `roomsApi` registers under a directory the run owns and removes it
    // in teardown.
    const agentName = `E2E Switcher ${Date.now()}`;
    const agent = await roomsApi.registerAgent(agentName, '🔭', '#6366f1');
    const agentPath = agent.projectPath;

    const sessions = AGENT_SESSIONS.map((s) => ({ ...s, cwd: agentPath }));
    const forkPosts: string[] = [];

    await page.route('**/api/sessions**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === 'POST' && url.pathname.endsWith('/fork')) {
        forkPosts.push(url.pathname);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(sessionFixture('99999999-9999-4999-8999-999999999999', 'Fork')),
        });
        return;
      }
      if (request.method() === 'GET' && /\/api\/sessions$/.test(url.pathname)) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ sessions }),
        });
        return;
      }
      await route.continue();
    });

    // Land ON the second session, so the "current" tag has something to mark.
    await page.goto(`/session?session=${sessions[1].id}&dir=${encodeURIComponent(agentPath)}`);
    // The shell has to be mounted before ⌘K means anything — pressing the
    // shortcut at a page that is still booting types into nothing.
    await basePage.waitForAppReady();

    // By test id, not the placeholder: that string is user-facing copy, and a
    // `getByPlaceholder` that matches nothing times out instead of saying what
    // it could not find.
    await page.keyboard.press('ControlOrMeta+k');
    const paletteInput = page.getByTestId('command-palette-input');
    await expect(paletteInput).toBeVisible();
    await paletteInput.fill(agentName);
    await expect(page.locator('[cmdk-item]').first()).toBeVisible();
    await page.keyboard.press('Enter');

    const browse = page.locator('[cmdk-item]', { hasText: 'Browse sessions' });
    await expect(browse).toBeVisible();
    await browse.click();

    // The switcher outlives the palette that opened it.
    await expect(page.locator(ROW).first()).toBeVisible();
    await expect(page.locator('[cmdk-item]')).toHaveCount(0);

    // Exactly one row is tagged, and it is the one that is open.
    const tag = page.locator('[data-slot="session-switcher-current"]');
    await expect(tag).toHaveCount(1);
    await expect(page.locator(ROW).filter({ has: tag })).toContainText('Release notes draft');

    // `⇧↵` forks the FOCUSED row and lands in the fork, not the original.
    await page.locator(ROW).first().focus();
    await page.keyboard.press('Shift+Enter');
    await expect.poll(() => forkPosts).toEqual([`/api/sessions/${sessions[0].id}/fork`]);
    await expect
      .poll(() => new URL(page.url()).searchParams.get('session'))
      .toBe('99999999-9999-4999-8999-999999999999');
  });
  test('clicking the agent row opens the conversation, not the room-triggered run (BC-34)', async ({
    page,
    roomsApi,
    basePage,
    dashboardSidebar,
  }) => {
    const agentName = `E2E BC34 ${Date.now()}`;
    const agent = await roomsApi.registerAgent(agentName, '🍊', '#f59e0b');

    // The reported shape: `@`-mentioning an agent in a channel leaves a
    // room-origin run as the NEWEST session in its directory. Clicking the row
    // used to land there — inside a conversation BC-19 then keeps out of Today.
    const roomRun = {
      ...sessionFixture('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Room run', agent.projectPath),
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
      origin: 'room',
      originLabel: '#team',
    };
    const conversation = {
      ...sessionFixture(
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'Our conversation',
        agent.projectPath
      ),
      updatedAt: new Date(Date.now() - 1_800_000).toISOString(),
    };

    await page.route('**/api/sessions**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === 'GET' && /\/api\/sessions$/.test(url.pathname)) {
        // Newest first, exactly as the server returns it.
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ sessions: [roomRun, conversation] }),
        });
        return;
      }
      await route.continue();
    });

    await basePage.goto();
    await basePage.waitForAppReady();
    await basePage.ensureSidebarOpen();

    const row = dashboardSidebar.agentRow(agentName);
    await expect(row).toBeVisible();
    await row.click();

    // The older HUMAN conversation, not the newer room run.
    await expect.poll(() => new URL(page.url()).searchParams.get('session')).toBe(conversation.id);
  });
});
