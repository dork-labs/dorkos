import type { Page } from '@playwright/test';

/**
 * Open one of the cockpit's dialogs the way a person does: through the command
 * palette.
 *
 * The dialogs used to be opened here with
 * `page.evaluate(() => document.querySelector('button[aria-label="…"]')?.click())`.
 * Two things were wrong with that. The labels had not existed in the client for
 * a long time — and the `?.` turned every one of those misses into a silent
 * no-op followed by a 30s wait for a dialog nobody had asked to open, so a dead
 * selector reported itself as a timeout and read like flake. A real locator
 * fails saying what it could not find. It still waits out its timeout — what
 * changed is the diagnosis, not the speed: "waiting for
 * getByRole('option', { name: 'Tasks Scheduler' })" points at the missing
 * control, where the old failure pointed at a dialog that was never asked to
 * open.
 *
 * The palette is the one opener all of them share. Settings also has a sidebar
 * footer button, but it is only reachable while the sidebar is expanded, and
 * Tasks and Relay have no in-DOM button at all — their other entry points are
 * attention rows on Home, whose accessible names change with the state they are
 * reporting.
 *
 * The name is TYPED, never hunted for in the untyped list. Before anyone types,
 * ⌘K is only Continue / Recent / New (`design-decisions.md` §15) — Settings,
 * Tasks Scheduler and Connections are not rows on that first screen and never
 * will be again. They come back on the first keystroke, which is exactly what
 * this does and exactly what a person now does.
 *
 * @param page - The page to drive.
 * @param item - Exact palette entry to pick, e.g. `Tasks Scheduler`. Doubles as
 *   the query typed to bring it back, so it must be the label as rendered.
 */
export async function openFromCommandPalette(page: Page, item: string): Promise<void> {
  await page.getByRole('button', { name: 'Open command palette' }).click();
  // By test id, not by placeholder: the placeholder is user-facing copy that has
  // already changed twice, and a `getByPlaceholder` that matches nothing waits
  // out its timeout instead of naming what is missing.
  const search = page.getByTestId('command-palette-input');
  await search.waitFor({ state: 'visible' });
  await search.fill(item);
  await page.getByRole('option', { name: item, exact: true }).first().click();
}
