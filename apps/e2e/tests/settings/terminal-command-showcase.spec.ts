import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';

/**
 * Settings → This computer → Terminal command (DOR-3105), in the Dev Playground's
 * showcase of its five states. No server and no seed: each state is drawn from a
 * made-up desktop bridge, which is what makes this a `@smoke` test.
 *
 * It is how the designer's light, dark and 390px shots are taken: in CI, attached
 * to the run, never on a person's Mac. And at 390 it holds the row to the
 * design rules: every button at least 44px tall, and nothing wider than its card.
 */
const SHOWCASE_PATH = '/dev/settings#terminal-command';

/** The first navigation to `/dev` faults in the whole playground; a ceiling, not a delay. */
const PLAYGROUND_COLD_START_MS = 90_000;

async function openShowcase(page: Page) {
  await page.goto(SHOWCASE_PATH);
  const section = page.locator('section#terminal-command');
  await expect(section.getByText('Use dorkos from Terminal.', { exact: false })).toBeVisible({
    timeout: PLAYGROUND_COLD_START_MS,
  });
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

test.describe('Terminal command showcase @smoke', () => {
  test.describe.configure({ timeout: 150_000 });

  for (const [label, viewport] of [
    ['desktop', { width: 1280, height: 2400 }],
    ['390', { width: 390, height: 3200 }],
  ] as const) {
    for (const theme of ['light', 'dark'] as const) {
      test(`draws every state, ${label}, ${theme}`, async ({ page }, testInfo) => {
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

        await testInfo.attach(`terminal-command-${label}-${theme}.png`, {
          body: await section.screenshot(),
          contentType: 'image/png',
        });

        if (label !== '390') return;
        // Design rules at 390: a thumb-sized target for every button, and no control
        // or line running out of its card.
        const measured = await section.evaluate((root) => {
          const buttons = [...root.querySelectorAll('button')].map((b) => {
            const r = b.getBoundingClientRect();
            return { text: b.textContent ?? '', height: r.height };
          });
          const cards = [...root.querySelectorAll('[data-slot="field-card"]')];
          const overflow = cards.flatMap((card) => {
            const box = card.getBoundingClientRect();
            return [...card.querySelectorAll('button, code')]
              .filter((el) => el.getBoundingClientRect().right > box.right + 0.5)
              .map((el) => el.textContent ?? '');
          });
          return { buttons, overflow };
        });
        expect(measured.buttons.filter((b) => b.height < 44)).toEqual([]);
        expect(measured.overflow).toEqual([]);
      });
    }
  }
});
