import type { Locator, Page } from '@playwright/test';

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
 * getByRole('option', { name: 'Scheduled tasks' })" points at the missing
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
 * Scheduled tasks and Connections are not rows on that first screen and never
 * will be again. They come back on the first keystroke, which is exactly what
 * this does and exactly what a person now does.
 *
 * @param page - The page to drive.
 * @param item - Exact palette entry to pick, e.g. `Scheduled tasks`. Doubles as
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

/** The parts of the palette a spec drives, all scoped to its cmdk root. */
export interface CommandPalette {
  /** The cmdk root — every other locator hangs off it. */
  root: Locator;
  /** The search field. By test id, never by placeholder: see {@link openFromCommandPalette}. */
  input: Locator;
  /** The rows, as the accessibility tree sees them — what Down walks and Enter acts on. */
  options: Locator;
  /**
   * The scope chip, when one is up (design-decisions §15).
   *
   * By test id rather than by the agent's name: the chip draws that name, so a
   * name-based locator would also match the row the chip was made from and the
   * two are different assertions.
   */
  chip: Locator;
  /**
   * Every "Archived" mark on screen — a closed channel or a conversation that
   * left Today at 4am (P3 AC-5).
   *
   * By test id rather than by the word: "Archived" can appear in a room's own
   * title, and a locator that matched one would report the label on a row that
   * never carried it.
   */
  archivedMarks: Locator;
}

/**
 * Every part of the command palette, once it is open.
 *
 * Not exported: `openCommandPalette` is how a spec gets one, because a palette
 * nobody opened has no rows and every locator on it would wait out its timeout.
 *
 * @param page - The page the palette is on.
 */
function commandPalette(page: Page): CommandPalette {
  const root = page.locator('[cmdk-root]');
  return {
    root,
    input: page.getByTestId('command-palette-input'),
    options: root.getByRole('option'),
    chip: page.getByTestId('palette-scope-chip'),
    archivedMarks: root.getByTestId('palette-archived-mark'),
  };
}

/**
 * Open the palette with the shortcut a person uses, and wait for it.
 *
 * @param page - The page to drive.
 */
export async function openCommandPalette(page: Page): Promise<CommandPalette> {
  await page.keyboard.press('ControlOrMeta+k');
  const palette = commandPalette(page);
  await palette.input.waitFor({ state: 'visible' });
  return palette;
}

/**
 * Scope the palette to a thing, the way a person does: type enough of its name,
 * put the highlight on it, press Tab.
 *
 * The highlight is moved with `ArrowDown` from the top rather than by hovering,
 * because hover and keyboard selection are two different code paths in cmdk and
 * only one of them is what a keyboard user gets. It walks down until the row it
 * was asked for is the selected one, so it cannot silently scope to whatever
 * happened to be first.
 *
 * @param palette - The open palette.
 * @param query - What to type to bring the row up, prefix included (`@dork`, `#ship`).
 * @param rowText - Text that identifies the row to scope to.
 * @param maxRows - How far down the list to look before giving up.
 */
export async function scopePaletteTo(
  palette: CommandPalette,
  query: string,
  rowText: string,
  maxRows = 12
): Promise<void> {
  await palette.input.fill(query);
  const target = palette.options.filter({ hasText: rowText }).first();
  await target.waitFor({ state: 'visible' });

  for (let step = 0; step < maxRows; step += 1) {
    if ((await target.getAttribute('data-selected')) === 'true') break;
    await palette.input.press('ArrowDown');
  }
  if ((await target.getAttribute('data-selected')) !== 'true') {
    throw new Error(`could not put the highlight on a row containing "${rowText}"`);
  }
  await palette.input.press('Tab');
  await palette.chip.waitFor({ state: 'visible' });
}
