import { test, expect } from '@playwright/test';
import { BasePage } from '../../pages/BasePage.js';
import { describeViolation, runAxe } from '../../axe.js';
import {
  ALPHA,
  BETA,
  ROOM,
  mockCommunities,
  releaseHeld,
  secret,
  type CommunitySpec,
} from './community-mocks.js';

/**
 * Browser proof for the switcher's keyboard, screen-reader, touch, zoom,
 * reduced-motion and fifty-Community behaviour (DOR-2186; spec
 * `specs/community-switcher-navigation`, task 4.2).
 */

test.describe('switcher accessibility and scale (task 4.2)', () => {
  const GAMMA: CommunitySpec = { ref: 'gamma', label: 'Gamma', access: 'unverified' };
  const DELTA: CommunitySpec = { ref: 'delta', label: 'Delta', status: 'reconnect-required' };
  const LONG: CommunitySpec = {
    ref: 'long',
    label: 'The Very Long Named Neighbourhood Makers and Fixers Collective of the Northern Valley',
  };

  test('a keyboard-only journey: shortcut, arrows, Home/End, typeahead, Enter, Escape', async ({
    page,
  }, testInfo) => {
    const mock = await mockCommunities(page, [ALPHA, BETA, GAMMA, DELTA, LONG]);
    await page.goto('/tasks');
    await new BasePage(page).waitForAppReady();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    // The shortcut works from anywhere, and opens on the selected row.
    await page.keyboard.press('ControlOrMeta+Shift+K');
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    const rows = menu.getByRole('menuitemradio');
    await expect(rows).toHaveCount(6);
    await expect(rows.first()).toBeFocused();
    await expect(rows.first()).toHaveAttribute('aria-checked', 'true');

    // Every row says what it is and what state it is in, in words.
    await expect(menu.getByRole('menuitemradio', { name: /^Alpha/ })).toHaveAccessibleName(
      /Alpha.*1 mention.*1 other unread/
    );
    await expect(menu.getByRole('menuitemradio', { name: /^Gamma/ })).toHaveAccessibleName(
      /offline/i
    );
    await expect(menu.getByRole('menuitemradio', { name: /^Delta/ })).toHaveAccessibleName(
      /Reconnect required/
    );
    await expect(menu.getByRole('menuitemradio', { name: /^The Very Long/ })).toHaveAccessibleName(
      new RegExp(LONG.label)
    );
    // Mention and other activity differ in text, not only colour.
    const alphaRow = menu.getByRole('menuitemradio', { name: /^Alpha/ });
    await expect(alphaRow.getByLabel('1 mention', { exact: true })).toHaveText('@1');
    await expect(alphaRow.getByLabel('1 other unread', { exact: true })).toHaveText('1');

    // Reduced motion stops the theme's colour transition, so axe measures
    // the settled colours rather than a frame halfway between two themes.
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      const axe = await runAxe(page, '[role="menu"]');
      expect(axe.violations.map(describeViolation), scheme).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });

    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitemradio', { name: /^Alpha/ })).toBeFocused();
    // End jumps to the menu's last row, Home back to its first.
    await page.keyboard.press('End');
    await expect
      .poll(() =>
        page.evaluate(() => {
          const items = document.querySelectorAll(
            '[role="menu"] [role^="menuitem"]:not([data-disabled])'
          );
          return document.activeElement === items[items.length - 1];
        })
      )
      .toBe(true);
    await page.keyboard.press('Home');
    await expect(rows.first()).toBeFocused();
    // Typeahead finds a row by its visible label.
    await page.keyboard.type('Bet');
    await expect(menu.getByRole('menuitemradio', { name: /^Beta/ })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`community=beta&id=${ROOM}`));
    await expect(page.getByText(secret('Beta'), { exact: true })).toBeVisible();

    // Escape closes and puts focus back on the trigger.
    await page.keyboard.press('ControlOrMeta+Shift+K');
    await expect(menu.getByRole('menuitemradio', { name: /^Beta/ })).toBeFocused();
    await expect(menu.getByRole('menuitemradio', { name: /^Beta/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(page.getByTestId('sidebar-header-block')).toBeFocused();
    // Nothing of the other Communities was fetched in detail on the way.
    expect(new Set(mock.requests.map((r) => r.ref))).toEqual(new Set(['beta']));
    const shot = testInfo.outputPath('switcher-keyboard-desktop.png');
    await page.keyboard.press('ControlOrMeta+Shift+K');
    await expect(menu).toBeVisible();
    await page.screenshot({ path: shot, animations: 'disabled' });
    await testInfo.attach('switcher-keyboard-desktop.png', {
      path: shot,
      contentType: 'image/png',
    });
  });

  test('the new context’s frame paints before the Community answers, and a failed switch is announced', async ({
    page,
  }) => {
    const mock = await mockCommunities(page, [ALPHA, BETA]);
    await page.goto(`/channels?community=alpha&id=${ROOM}`);
    await new BasePage(page).waitForAppReady();
    await expect(page.getByText(secret('Alpha'), { exact: true })).toBeVisible();

    mock.holdDestination.add('beta');
    await page.getByTestId('sidebar-header-block').focus();
    await page.keyboard.press('ControlOrMeta+Shift+K');
    await expect(page.getByRole('menuitemradio', { name: /^Alpha/ })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitemradio', { name: /^Beta/ })).toBeFocused();
    const started = await page.evaluate(() => performance.now());
    await page.keyboard.press('Enter');
    // While Beta's answer is still held: Beta's label and a safe frame, no Alpha.
    await expect(page.getByTestId('sidebar-header-block')).toHaveAccessibleName('Beta menu');
    const painted = await page.evaluate(
      (from) =>
        new Promise<number>((done) => requestAnimationFrame(() => done(performance.now() - from))),
      started
    );
    expect(mock.held.map((item) => item.kind)).toEqual(['destination']);
    await expect(page.getByText(secret('Alpha'), { exact: true })).toHaveCount(0);
    test
      .info()
      .annotations.push({ type: 'switch-to-labelled-frame-ms', description: painted.toFixed(1) });
    await releaseHeld(mock);
    await expect(page.getByText(secret('Beta'), { exact: true })).toBeVisible();

    // A switch the Community cannot answer leaves the old context in place, and says so.
    mock.failDestination.add('alpha');
    await page.getByTestId('sidebar-header-block').focus();
    await page.keyboard.press('ControlOrMeta+Shift+K');
    await expect(page.getByRole('menuitemradio', { name: /^Beta/ })).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(page.getByRole('menuitemradio', { name: /^Alpha/ })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`community=beta&id=${ROOM}`));
    await expect(page.getByTestId('sidebar-header-block')).toHaveAccessibleName('Beta menu');
    await expect(page.getByText(secret('Beta'), { exact: true })).toBeVisible();
    await expect(page.getByText(/couldn.t open Alpha/i)).toBeVisible();
  });

  test('phone: 44px rows, reduced motion, long labels fit, and choosing a row closes the sheet', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mockCommunities(page, [ALPHA, BETA, GAMMA, DELTA, LONG]);
    await page.goto('/tasks');
    await new BasePage(page).waitForAppReady();
    await page.getByTestId('sidebar-header-block').click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();
    const rows = sheet.getByRole('radio');
    await expect(rows).toHaveCount(6);
    for (const row of await rows.all()) {
      const box = (await row.boundingBox())!;
      expect(box.height, (await row.textContent()) ?? '').toBeGreaterThanOrEqual(44);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }
    // Reduced motion: the sheet does not slide in.
    const moving = await sheet.evaluate((element) => {
      const style = getComputedStyle(element);
      const seconds = (value: string) =>
        Math.max(
          ...value.split(',').map((part) => parseFloat(part) * (part.includes('ms') ? 0.001 : 1))
        );
      return Math.max(seconds(style.transitionDuration), seconds(style.animationDuration));
    });
    expect(moving).toBeLessThanOrEqual(0.01);
    await expect(sheet.getByRole('radio', { name: /^The Very Long/ })).toHaveAccessibleName(
      new RegExp(LONG.label)
    );
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    const shot = testInfo.outputPath('switcher-phone-390.png');
    await page.screenshot({ path: shot, animations: 'disabled' });
    await testInfo.attach('switcher-phone-390.png', { path: shot, contentType: 'image/png' });

    const axe = await runAxe(page, '[role="dialog"]');
    expect(axe.violations.map(describeViolation)).toEqual([]);

    await sheet.getByRole('radio', { name: /^Beta/ }).click();
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`community=beta&id=${ROOM}`));
    await expect(page.getByText(secret('Beta'), { exact: true })).toBeVisible();
  });

  test('at 200% zoom every destination stays reachable without sideways scrolling', async ({
    page,
  }, testInfo) => {
    // 200% browser zoom on a 1280×800 window lays the page out at 640×400 CSS pixels.
    await page.setViewportSize({ width: 640, height: 400 });
    await mockCommunities(page, [ALPHA, BETA, GAMMA, DELTA, LONG]);
    await page.goto('/tasks');
    await new BasePage(page).waitForAppReady();
    await page.getByTestId('sidebar-header-block').click();
    const rows = page.getByRole('dialog').getByRole('radio').or(page.getByRole('menuitemradio'));
    await expect(rows).toHaveCount(6);
    for (const row of await rows.all()) {
      await row.scrollIntoViewIfNeeded();
      await expect(row).toBeInViewport();
    }
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    const shot = testInfo.outputPath('switcher-zoom-200.png');
    await page.screenshot({ path: shot, animations: 'disabled' });
    await testInfo.attach('switcher-zoom-200.png', { path: shot, contentType: 'image/png' });
    await rows.filter({ hasText: 'Beta' }).click();
    await expect(page.getByText(secret('Beta'), { exact: true })).toBeVisible();
  });

  const FIFTY: CommunitySpec[] = Array.from({ length: 50 }, (_, index) => {
    const n = String(index + 1).padStart(2, '0');
    return {
      ref: `c${n}`,
      label: `Community ${n}`,
      ...(index % 7 === 0 ? { unread: 3, mentions: 1 } : {}),
    };
  });

  test('fifty Communities on desktop: fast to open, typeahead reaches any row, only the chosen one loads', async ({
    page,
  }, testInfo) => {
    const mock = await mockCommunities(page, FIFTY);
    await page.goto('/tasks');
    await new BasePage(page).waitForAppReady();
    // The shell alone asks no Community for rooms, history or a stream.
    expect(mock.requests).toEqual([]);

    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      // Time from the key to the first frame with all fifty-one rows in it.
      const timing = { from: 0, painted: 0 };
      (window as unknown as { __openTiming: typeof timing }).__openTiming = timing;
      window.addEventListener('keydown', () => (timing.from ||= performance.now()), {
        capture: true,
      });
      const wait = () =>
        timing.from && document.querySelectorAll('[role="menuitemradio"]').length === 51
          ? (timing.painted = performance.now())
          : requestAnimationFrame(wait);
      requestAnimationFrame(wait);
    });
    await page.keyboard.press('ControlOrMeta+Shift+K');
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __openTiming: { painted: number } }).__openTiming.painted
        )
      )
      .toBeGreaterThan(0);
    const opened = await page.evaluate(() => {
      const timing = (window as unknown as { __openTiming: { from: number; painted: number } })
        .__openTiming;
      return timing.painted - timing.from;
    });
    testInfo.annotations.push({ type: 'open-with-50-ms', description: opened.toFixed(1) });
    expect(opened).toBeLessThan(1_000);
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitemradio')).toHaveCount(51);

    // The last Community is reachable and scrolled into view.
    const last = menu.getByRole('menuitemradio', { name: /^Community 50/ });
    await last.focus();
    await expect(last).toBeInViewport();
    await page.keyboard.press('Home');
    await page.keyboard.type('Community 37');
    const target = menu.getByRole('menuitemradio', { name: /^Community 37/ });
    await expect(target).toBeFocused();
    await expect(target).toBeInViewport();
    const shot = testInfo.outputPath('switcher-fifty-desktop.png');
    await page.screenshot({ path: shot, animations: 'disabled' });
    await testInfo.attach('switcher-fifty-desktop.png', { path: shot, contentType: 'image/png' });
    await page.keyboard.press('Enter');
    await expect(page.getByText(secret('Community 37'), { exact: true })).toBeVisible();
    // Only the chosen Community was asked for detail.
    expect(new Set(mock.requests.map((r) => r.ref))).toEqual(new Set(['c37']));
  });

  test('fifty Communities on a phone: search narrows the sheet and every row is a 44px target', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const mock = await mockCommunities(page, FIFTY);
    await page.goto('/tasks');
    await new BasePage(page).waitForAppReady();
    await page.getByTestId('sidebar-header-block').click();
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByRole('radio')).toHaveCount(51);
    const last = sheet.getByRole('radio', { name: /^Community 50/ });
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    expect((await last.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    // The search box and this DorkOS's own row stay reachable above fifty rows.
    const search = sheet.getByRole('searchbox', { name: 'Find a community' });
    await search.scrollIntoViewIfNeeded();
    await expect(search).toBeInViewport();
    await sheet.getByRole('radio', { name: /team/ }).scrollIntoViewIfNeeded();
    await expect(sheet.getByRole('radio', { name: /team/ })).toBeInViewport();
    await search.fill('37');
    await expect(sheet.getByRole('radio')).toHaveCount(2);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    const shot = testInfo.outputPath('switcher-fifty-390.png');
    await page.screenshot({ path: shot, animations: 'disabled' });
    await testInfo.attach('switcher-fifty-390.png', { path: shot, contentType: 'image/png' });
    await sheet.getByRole('radio', { name: /^Community 37/ }).click();
    await expect(page.getByText(secret('Community 37'), { exact: true })).toBeVisible();
    expect(new Set(mock.requests.map((r) => r.ref))).toEqual(new Set(['c37']));
  });
});
