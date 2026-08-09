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
 * @param page - The page to drive.
 * @param item - Exact palette entry to pick, e.g. `Tasks Scheduler`.
 */
export async function openFromCommandPalette(page: Page, item: string): Promise<void> {
  await page.getByRole('button', { name: 'Open command palette' }).click();
  await page.getByRole('option', { name: item, exact: true }).first().click();
}
