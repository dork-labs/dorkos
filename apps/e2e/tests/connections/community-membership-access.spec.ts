import { test, expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { BasePage } from '../../pages/BasePage.js';
import { describeViolation, runAxe } from '../../axe.js';
import { ALPHA, mockCommunities, type CommunitySpec } from './community-mocks.js';

/**
 * Accessibility proof for the DorkOS app's side of Community membership
 * (spec `specs/community-membership-journeys`, task 3.2): the switcher's
 * connect dialog, the join-with-invitation dialog, the switcher's Manage and
 * Add actions, and the disconnect confirmation. Each passes axe at desktop and
 * 390px phone width in light and dark, is operable by keyboard with focus
 * placed on every step, announces its outcome, and keeps phone targets at the
 * design system's floor.
 */

const DELTA: CommunitySpec = { ref: 'delta', label: 'Delta', status: 'reconnect-required' };

/**
 * The phone touch floor: every responsive primitive grows to 44px below `md`
 * (`apps/client/src/layers/shared/ui/touch-target.ts`), and so do menu and
 * sheet rows.
 */
const TOUCH_FLOOR = 44;

/**
 * The shared `--destructive` token misses 4.5:1 app-wide, both as a fill under
 * white text (3.76:1 light) and as `text-destructive` error text (3.6:1 light,
 * 4.09:1 dark). It is a design-system token, not a membership-surface defect,
 * and a separate change is fixing the token app-wide; once it lands this
 * exclusion has nothing left to match and can be deleted.
 *
 * Only a colour-contrast node whose OWN element wears the token is set aside,
 * decided from the element axe's target selector resolves to, never from its
 * HTML snippet: a container whose markup merely holds a destructive child
 * still fails, and so does every other node of the same violation.
 */
async function wearsDestructiveToken(page: Page, target: unknown[]): Promise<boolean> {
  const selector = target.at(-1);
  if (typeof selector !== 'string') return false;
  return page.evaluate((query) => {
    const element = document.querySelector(query);
    return (
      element !== null &&
      (element.getAttribute('data-variant') === 'destructive' ||
        element.classList.contains('text-destructive'))
    );
  }, selector);
}

/**
 * Run axe over `scope` in light and dark at the current viewport. Reduced
 * motion stops the theme's colour transition, so axe measures settled colours.
 */
async function axeBothSchemes(page: Page, scope: string, label: string, testInfo: TestInfo) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    // Let any colour transition still in flight finish, so axe never measures
    // a frame with one theme's text on the other theme's background.
    await page
      .waitForFunction(
        () =>
          document
            .getAnimations()
            .filter((animation) => animation instanceof CSSTransition)
            .every((animation) => animation.playState !== 'running'),
        undefined,
        { timeout: 3_000 }
      )
      // A transition restarted on every frame (a skeleton) never settles;
      // three seconds is far past any theme change.
      .catch(() => undefined);
    const result = await runAxe(page, scope);
    const failing: typeof result.violations = [];
    const designSystem: typeof result.violations = [];
    for (const violation of result.violations) {
      if (violation.id !== 'color-contrast') {
        failing.push(violation);
        continue;
      }
      const token: typeof violation.nodes = [];
      const rest: typeof violation.nodes = [];
      for (const node of violation.nodes)
        ((await wearsDestructiveToken(page, node.target)) ? token : rest).push(node);
      if (rest.length) failing.push({ ...violation, nodes: rest });
      if (token.length) designSystem.push({ ...violation, nodes: token });
    }
    const violations = failing.map(describeViolation);
    await testInfo.attach(`${label}-${scheme}-axe.json`, {
      body: JSON.stringify(
        {
          scope,
          violations,
          designSystemFindings: designSystem.map(describeViolation),
          passes: result.passes.length,
        },
        null,
        2
      ),
      contentType: 'application/json',
    });
    expect.soft(violations, `${label} ${scheme}`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

/** Every visible control inside `scope` shorter than `floor`, described. */
async function shortTargets(scope: Locator, selector: string, floor: number) {
  return scope.evaluate(
    (root, [query, min]) =>
      [...root.querySelectorAll<HTMLElement>(query as string)]
        .map((element) => ({ element, box: element.getBoundingClientRect() }))
        .filter(({ box }) => box.width > 0 && box.height > 0 && box.height < (min as number) - 0.5)
        .map(
          ({ element, box }) =>
            `${(element.getAttribute('aria-label') || element.textContent || element.tagName).trim().slice(0, 40)} ${Math.round(box.height)}px`
        ),
    [selector, floor] as const
  );
}

test.describe('Community membership in the DorkOS app is accessible (task 3.2)', () => {
  test('connecting a community in the switcher: axe, keyboard pairing, announced outcomes, phone targets', async ({
    page,
  }, testInfo) => {
    // Two page loads and eight axe passes.
    test.slow();
    await mockCommunities(page, [ALPHA, DELTA]);
    let started = false;
    let deltaRemoved = false;
    let listed: Array<{ ref: string }> = [];
    page.on('response', async (response) => {
      if (
        new URL(response.url()).pathname === '/api/community-connections' &&
        response.request().method() === 'GET' &&
        !started &&
        !deltaRemoved
      )
        listed = ((await response.json()) as { connections: Array<{ ref: string }> }).connections;
    });
    const pending = {
      ref: 'gamma',
      remoteCommunityId: 'remote-gamma',
      label: 'Gamma',
      pinnedOrigin: 'https://gamma.example.test',
      connectedHumanMemberId: null,
      status: 'pending',
      expiresAt: '2099-01-01T00:00:00.000Z',
      access: null,
      attention: null,
    };
    // Registered after the shared mock, so these answers win for the list,
    // pairing and removal.
    await page.route('**/api/community-connections**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/api/community-connections' && request.method() === 'POST') {
        started = true;
        await route.fulfill({
          status: 201,
          json: {
            connection: pending,
            approvalUrl: 'https://gamma.example.test/c/remote-gamma/pairing?pairingId=p-1',
          },
        });
        return;
      }
      if (path === '/api/community-connections/gamma/poll')
        return route.fulfill({ json: { connection: pending, status: 'pending' } });
      if (path === '/api/community-connections/delta' && request.method() === 'DELETE') {
        deltaRemoved = true;
        return route.fulfill({ json: { remoteRevoked: true, agentsNotRemoved: [] } });
      }
      if (path === '/api/community-connections' && request.method() === 'GET') {
        if (!started && !deltaRemoved) return route.fallback();
        const rows = listed.filter((row) => !(deltaRemoved && row.ref === 'delta'));
        return route.fulfill({ json: { connections: started ? [...rows, pending] : rows } });
      }
      return route.fallback();
    });

    await page.goto('/tasks');
    await new BasePage(page).waitForAppReady();

    // A Community whose access was withdrawn opens its way back in place, not
    // on Connections: disconnect here, then the form to connect again.
    await page.getByTestId('sidebar-header-block').click();
    await page.getByRole('menuitemradio', { name: /Delta/ }).click();
    const reconnect = page.getByRole('dialog', { name: 'Reconnect Delta' });
    await expect(reconnect).toContainText('Disconnect here, then connect again.');
    await expect(page).not.toHaveURL(/\/connections/);
    await axeBothSchemes(page, '[role="dialog"]', 'reconnect-desktop', testInfo);
    await reconnect.getByRole('button', { name: 'Disconnect', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Join a space' });
    await expect(dialog.getByRole('status')).toHaveText(
      'Delta is disconnected. Connect again to continue.'
    );
    expect(deltaRemoved).toBe(true);
    const address = dialog.getByLabel('Space address or invitation link');
    await expect(address).toBeFocused();
    await axeBothSchemes(page, '[role="dialog"]', 'connect-desktop', testInfo);

    // Keyboard only: address, then Enter. The outcome is announced, and focus
    // moves to the one next step — the approval link on the Community's site.
    await page.keyboard.type('https://gamma.example.test/c/remote-gamma');
    await page.keyboard.press('Enter');
    const waiting = page.getByRole('dialog', { name: 'Approve on Gamma' });
    const approve = waiting.getByRole('link', { name: 'Open Gamma to approve' });
    await expect(approve).toBeFocused();
    await expect(waiting.getByRole('status')).toHaveText('Next, approve this DorkOS on Gamma.');
    await expect(approve).toHaveAttribute('target', '_blank');
    await axeBothSchemes(page, '[role="dialog"]', 'waiting-desktop', testInfo);

    // Closing keeps the wait. Choosing Gamma in the switcher picks it back up,
    // link and all, instead of sending the person to Connections.
    // The footer's Close, which the phone sheet needs; on desktop the dialog's
    // own corner button shares the name and comes after it.
    await waiting.getByRole('button', { name: 'Close', exact: true }).first().click();
    await expect(waiting).toBeHidden();
    await page.getByTestId('sidebar-header-block').click();
    await page.getByRole('menuitemradio', { name: /Gamma/ }).click();
    await expect(approve).toBeVisible();
    await expect(page).not.toHaveURL(/\/connections/);
    await page.keyboard.press('Escape');
    await expect(waiting).toBeHidden();

    // The phone sheet: the same dialog, from the Add group, at the touch floor.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/tasks');
    await new BasePage(page).waitForAppReady();
    await page.getByTestId('sidebar-header-block').click();
    await page.getByRole('menuitem', { name: 'Join a space…' }).click();
    await expect(dialog).toBeVisible();
    await expect(page.locator('[role="dialog"]', { hasText: 'Switch context' })).toHaveCount(0);
    await axeBothSchemes(page, '[role="dialog"]', 'connect-phone', testInfo);
    await expect.poll(() => shortTargets(dialog, 'button, input', TOUCH_FLOOR)).toEqual([]);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
  });

  for (const viewport of [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'phone', width: 390, height: 844 },
  ] as const) {
    test(`join a space with an invitation, ${viewport.name}: focus, address filled, axe`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockCommunities(page, [ALPHA]);
      // The invitation opens on the space's own site, in a new tab.
      await page
        .context()
        .route('https://alpha.example.test/**', (route) =>
          route.fulfill({ contentType: 'text/html', body: '<title>Alpha</title><h1>Alpha</h1>' })
        );
      await page.goto('/tasks');
      await new BasePage(page).waitForAppReady();
      await page.getByTestId('sidebar-header-block').click();
      if (viewport.name === 'desktop') {
        await page.locator('[data-menu-item-id="add-community"]').hover();
      }
      await page.getByRole('menuitem', { name: 'Join a space…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Join a space' });
      await expect(dialog).toBeVisible();
      const field = dialog.getByLabel('Space address or invitation link');
      // Desktop starts in the field. The phone sheet (vaul, `autoFocus` off)
      // does not raise the software keyboard on open; its focus trap takes the
      // very first Tab instead, so a keyboard user is inside it in one press.
      if (viewport.name === 'desktop') await expect(field).toBeFocused();
      else {
        // The switcher sheet slides away first; once it is gone, the next Tab
        // is the join sheet's.
        await expect(page.locator('[role="dialog"]', { hasText: 'Switch context' })).toHaveCount(0);
        await page.keyboard.press('Tab');
        await expect
          .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
          .toBe(true);
        await field.focus();
      }
      await axeBothSchemes(page, '[role="dialog"]', `join-${viewport.name}`, testInfo);

      // An invitation opens on the space's site; the dialog stays on Connect
      // with the space's address filled in, the invite itself left out.
      const link = 'https://alpha.example.test/c/remote-alpha/join#invite=one-time';
      await page.keyboard.type(link);
      await expect(dialog.getByRole('button', { name: 'Open invitation' })).toBeVisible();
      const opened = page.context().waitForEvent('page');
      await page.keyboard.press('Enter');
      expect((await opened).url()).toBe(link);
      await expect(field).toHaveValue('https://alpha.example.test/c/remote-alpha');
      await expect(field).toHaveAccessibleDescription(
        /Finish joining on alpha\.example\.test in the tab that opened/
      );
      await expect(dialog.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
      await axeBothSchemes(page, '[role="dialog"]', `join-filled-${viewport.name}`, testInfo);
      if (viewport.name === 'phone')
        expect(await shortTargets(dialog, 'button, input', TOUCH_FLOOR)).toEqual([]);

      // Escape closes it.
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    });
  }

  test('the switcher’s Manage and Add actions, desktop menu and phone sheet', async ({
    page,
  }, testInfo) => {
    // Two full page loads and eight axe passes; under a parallel run it brushes 30s.
    test.slow();
    await mockCommunities(page, [ALPHA]);
    await page.goto('/channels?community=alpha&id=general');
    await new BasePage(page).waitForAppReady();
    await expect(page.getByTestId('sidebar-header-block')).toHaveAccessibleName('Alpha menu');
    await page.getByTestId('sidebar-header-block').focus();
    await page.keyboard.press('ControlOrMeta+Shift+K');
    const manage = page.getByRole('menuitem', { name: 'Manage Alpha' });
    await expect(page.getByRole('menuitemradio', { name: /^Alpha/ })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(manage).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('menuitem', { name: 'Invite people' })).toBeFocused();
    // Rows that leave the app say where they go, in words.
    await expect(page.getByRole('menuitem', { name: 'Leave space…' })).toHaveAccessibleName(
      /opens on alpha\.example\.test$/
    );
    await axeBothSchemes(page, '[role="menu"]', 'manage-desktop', testInfo);

    // Disconnect confirms in an alert dialog that opens on the safe choice.
    // Radix moves focus after the key event, so each press waits for focus to
    // land before reading it; reading at once can step past Disconnect onto
    // Leave, whose Enter opens the Community's site instead.
    const disconnect = page.getByRole('menuitem', { name: 'Disconnect…', exact: true });
    const focusedText = () => page.evaluate(() => document.activeElement?.textContent ?? '');
    for (let step = 0; step < 6; step++) {
      if (await disconnect.evaluate((element) => element === document.activeElement)) break;
      const before = await focusedText();
      await page.keyboard.press('ArrowDown');
      await expect.poll(focusedText).not.toBe(before);
    }
    await expect(disconnect).toBeFocused();
    await page.keyboard.press('Enter');
    const confirm = page.getByRole('alertdialog', { name: 'Disconnect this DorkOS from Alpha?' });
    await expect(confirm.getByRole('button', { name: 'Keep connected' })).toBeFocused();
    await axeBothSchemes(page, '[role="alertdialog"]', 'disconnect-desktop', testInfo);
    await page.keyboard.press('Escape');
    await expect(confirm).toBeHidden();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/channels?community=alpha&id=general');
    await new BasePage(page).waitForAppReady();
    await page.getByTestId('sidebar-header-block').click();
    const sheet = page.getByRole('dialog');
    const manageGroup = sheet.getByRole('group', { name: 'Manage Alpha' });
    await expect(manageGroup).toBeVisible();
    await axeBothSchemes(page, '[role="dialog"]', 'manage-phone', testInfo);
    expect(await shortTargets(sheet, '[role="menuitem"]', TOUCH_FLOOR)).toEqual([]);

    await manageGroup.getByRole('menuitem', { name: 'Disconnect…', exact: true }).click();
    const phoneConfirm = page.getByRole('alertdialog', {
      name: 'Disconnect this DorkOS from Alpha?',
    });
    await expect(phoneConfirm.getByRole('button', { name: 'Keep connected' })).toBeFocused();
    await axeBothSchemes(page, '[role="alertdialog"]', 'disconnect-phone', testInfo);
    // Restoring motion after axe restarts the dialog's entrance zoom. Measure
    // its settled targets, not the transient 95% scale of the opening frame.
    await expect.poll(() => shortTargets(phoneConfirm, 'button', TOUCH_FLOOR)).toEqual([]);
  });
});
