import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../../fixtures';

/**
 * Settings → This computer → Terminal command (DOR-3105), in the Dev Playground's
 * showcase of its five states. No server and no seed: each state is drawn from a
 * made-up desktop bridge, which is what makes this a `@smoke` test.
 *
 * It is how the designer's light, dark and 390px shots are taken: in CI, attached
 * to the run, never on a person's Mac. And at 390 it holds the row to the
 * design rules: every button at least 44px tall, the action under the words, and
 * nothing wider than its card.
 */
const SHOWCASE_PATH = '/dev/settings#terminal-command';

/** The one line every state copies, in every shell (designer, Nov 13). */
const ALIAS_LINE = "alias dorkos='~/.local/bin/dorkos'";

/** The first navigation to `/dev` faults in the whole playground; a ceiling, not a delay. */
const PLAYGROUND_COLD_START_MS = 90_000;

async function openShowcase(page: Page) {
  await page.goto(SHOWCASE_PATH);
  const section = page.locator('section#terminal-command');
  // States 1 and 5 both start "not installed", so this line shows twice: wait for the first.
  await expect(
    section.getByText('Use dorkos from Terminal.', { exact: false }).first()
  ).toBeVisible({ timeout: PLAYGROUND_COLD_START_MS });
  // Another showcase on this page draws an account's colour picker open. On a phone it
  // is a sheet over the whole page, which would dim the shot.
  if ((await page.getByRole('dialog').count()) > 0) {
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  await section.scrollIntoViewIfNeeded();
  return section;
}

/**
 * Choose the theme before the page loads, through the app's own saved choice. At 390 the
 * playground's theme buttons sit in a sidebar that is folded away, so they can't be clicked.
 */
async function chooseTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.addInitScript((value) => localStorage.setItem('dorkos-theme', value), theme);
}

/** Wait until the document actually wears the theme, so the shot belongs to it. */
async function expectTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
    .toBe(theme === 'dark');
}

/** Every state's 390 rules: thumb-sized buttons, the action under the words, nothing out of its card. */
async function measureAt390(root: Locator) {
  return root.evaluate((el) => {
    const cards = [...el.querySelectorAll('[data-slot="field-card"]')];
    const buttons = cards.flatMap((card) =>
      [...card.querySelectorAll('button')].map((b) => ({
        text: b.textContent ?? '',
        height: b.getBoundingClientRect().height,
      }))
    );
    const overflow = cards.flatMap((card) => {
      const box = card.getBoundingClientRect();
      return [...card.querySelectorAll('button, code')]
        .filter((child) => child.getBoundingClientRect().right > box.right + 0.5)
        .map((child) => child.textContent ?? '');
    });
    // The row's own action (the first button in its field) starts below its label.
    const notStacked = [...el.querySelectorAll('[data-slot="field"]')].flatMap((field) => {
      const label = field.querySelector('[data-slot="field-label"]');
      const action = field.querySelector(':scope > button');
      if (!label || !action) return [];
      return action.getBoundingClientRect().top >= label.getBoundingClientRect().bottom
        ? []
        : [action.textContent ?? ''];
    });
    // A word in a sentence never splits: `dorkos` draws as one box.
    const splitWords = [...el.querySelectorAll('code')]
      .filter((code) => code.textContent === 'dorkos' && code.getClientRects().length > 1)
      .map((code) => code.textContent ?? '');
    return { buttons, overflow, notStacked, splitWords };
  });
}

test.describe('Terminal command showcase @smoke', () => {
  test.describe.configure({ timeout: 150_000 });

  for (const [label, viewport] of [
    ['desktop', { width: 1280, height: 2400 }],
    ['390', { width: 390, height: 3200 }],
  ] as const) {
    for (const theme of ['light', 'dark'] as const) {
      test(`draws every state, ${label}, ${theme}`, async ({ page, context }, testInfo) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await page.setViewportSize(viewport);
        await chooseTheme(page, theme);
        const section = await openShowcase(page);
        await expectTheme(page, theme);

        for (const words of [
          'Installed at',
          'Installed, but Terminal can’t find it yet.',
          'Terminal finds another',
          'The Terminal command comes with the Mac app.',
        ])
          await expect(section.getByText(words, { exact: false }).first()).toBeVisible();

        // Every state that offers a line copies exactly the one line, whatever the shell.
        for (const state of ['not-found', 'shadowed', 'shadowed-long']) {
          const row = section.getByTestId(`terminal-command-state-${state}`);
          await page.evaluate(() => navigator.clipboard.writeText(''));
          await row.getByRole('button', { name: 'Copy' }).click();
          await expect
            .poll(() => page.evaluate(() => navigator.clipboard.readText()))
            .toBe(ALIAS_LINE);
        }

        // State 5: Install fails, so the shot shows the reason and Try again.
        const failed = section.getByTestId('terminal-command-state-failed');
        await failed.getByRole('button', { name: 'Install' }).click();
        await expect(failed.getByText('Couldn’t install:', { exact: false })).toBeVisible();
        await expect(failed.getByRole('button', { name: 'Try again' })).toBeVisible();

        // "Copied" reads for a moment after Copy; the shot shows the resting row.
        await expect(section.getByRole('button', { name: 'Copied' })).toHaveCount(0);

        await testInfo.attach(`terminal-command-${label}-${theme}.png`, {
          body: await section.screenshot(),
          contentType: 'image/png',
        });

        if (label !== '390') return;
        const measured = await measureAt390(section);
        // Only the row's own buttons (Install, Remove, Try again, Copy), never the
        // playground's chrome around each demo; and there must be some to measure.
        expect(measured.buttons.length).toBeGreaterThan(4);
        expect(measured.buttons.filter((b) => b.height < 44)).toEqual([]);
        expect(measured.overflow).toEqual([]);
        expect(measured.notStacked).toEqual([]);
        expect(measured.splitWords).toEqual([]);
      });
    }
  }

  // The real tab in the real Settings, at 390. The tab shows only in the desktop app, so
  // the page gets a made-up desktop bridge that serves the app from its own address.
  test('the real Settings tab, 390', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chooseTheme(page, 'light');
    await page.addInitScript((line) => {
      const status = {
        state: 'not-found',
        path: '~/.local/bin/dorkos',
        shellFile: '~/.zshrc',
        line,
      };
      (window as unknown as { electronAPI: unknown }).electronAPI = {
        getServerPort: () => Number(window.location.port),
        terminalCommand: {
          status: async () => ({ ok: true, status }),
          install: async () => ({ ok: true, status }),
          remove: async () => ({ ok: true, status: { state: 'not-installed' } }),
        },
      };
    }, ALIAS_LINE);
    await page.goto('/?settings=terminal-command');
    const dialog = page.getByTestId('settings-dialog');
    await expect(
      dialog.getByText('Installed, but Terminal can’t find it yet.', { exact: false })
    ).toBeVisible({ timeout: PLAYGROUND_COLD_START_MS });
    await expect(dialog.locator('code', { hasText: ALIAS_LINE })).toHaveText(ALIAS_LINE);

    await testInfo.attach('terminal-command-settings-390-light.png', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });

    const measured = await measureAt390(dialog);
    expect(measured.buttons.filter((b) => b.height < 44)).toEqual([]);
    expect(measured.overflow).toEqual([]);
    expect(measured.splitWords).toEqual([]);
  });
});
