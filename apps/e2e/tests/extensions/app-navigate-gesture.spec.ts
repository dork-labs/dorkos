import { cpSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { appFrame, appPage } from '../../pages/app-frame.js';
import { RightPanelPage } from '../../pages/RightPanelPage';
import { leaveNoUnreadRows } from './inbox-hygiene';

/**
 * An app opens another app's page only from the person's own click or key
 * press in its frame (DOR-3293, Security's Musts of Nov 15).
 *
 * The fixture `hop-fixture`, named "Hop", lists `hello-world` with
 * `navigate: true`. From 16 s after load it keeps focusing its own frame and
 * calling `api.navigate` with no click, logging each answer as a `hop:` line.
 * Its "Open Hello World" button is the honest path. Its right-panel tab,
 * "Hop B", is a second frame with a button that only logs, for the cases where
 * the person clicks one frame while the other tries.
 *
 * READ THE CONSOLE, NEVER THE PAGE, WHILE THE APP IS TRYING. Every Playwright
 * read of a page in Chromium (a locator, a bounding box, an evaluate) goes out
 * with `userGesture: true`, which raises the same activation a real click
 * does, with no input event behind it. No page can do that, and the host has
 * no way to tell it from a click in the frame, so one read at the wrong moment
 * hands the app its open. So the spec finds what it will click first, waits
 * out that activation (Chromium keeps one for 5 s), and from then on only
 * moves the real mouse and keyboard, which raise real input events.
 *
 * The unit tests (`gesture-fence.test.ts`) fake `navigator.userActivation`;
 * only a real browser shows what raises it and what the host sees.
 *
 * Runs on the `chromium-extension-seams` project: it turns `hello-world` on
 * and off, so it shares that project's one worker. Installed the way
 * `approval-inbox.spec.ts` installs its fixture, under a fresh plugin name per
 * run, and approved from the inbox with one click.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_FIXTURE = path.resolve(HERE, '../../fixtures/extensions/hop-fixture');
const EXT_ID = 'hop-fixture';
const HELLO = 'hello-world';
const HOP_URL = new RegExp(`/x/${EXT_ID}$`);
const HELLO_URL = /\/x\/hello-world$/;
/** Longer than Chromium's 5 s transient activation, which a Playwright read raises. */
const ACTIVATION_RUNS_OUT_MS = 6_000;
/** No-click tries that must all be refused after the person acts in DorkOS. */
const TRIES_AFTER = 8;

/** A fresh folder per run: an approval is bound to a copy's path (see approval-inbox.spec.ts). */
const PLUGIN_NAME = `hop-fixture-${process.pid}-${Date.now()}`;
let pluginDir: string | undefined;

/** The `hop:` lines Hop has logged on this page, in order. */
function hopLog(page: Page): string[] {
  const lines: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (text.startsWith('hop: ')) lines.push(text.slice('hop: '.length));
  });
  return lines;
}

/** Wait, without reading the page, until Hop has logged `count` lines matching `pattern`. */
async function waitForLines(lines: string[], pattern: RegExp, count = 1): Promise<void> {
  await expect
    .poll(() => lines.filter((line) => pattern.test(line)).length, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(count);
}

/** The no-click tries Hop has logged so far. */
function tries(lines: string[]): string[] {
  return lines.filter((line) => line.startsWith('try '));
}

/**
 * The middle of what a locator finds, as page coordinates. Capped short: a
 * locator that keeps looking keeps reading the page, and each read raises a
 * fresh activation, so a missing element must fail fast rather than hand Hop
 * its open.
 */
async function middleOf(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox({ timeout: 5_000 });
  expect(box, 'the thing to click is on screen').not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

/** Open Hop's page and wait for it to say it is up, reading nothing on it. */
async function openHop(page: Page): Promise<string[]> {
  const lines = hopLog(page);
  await page.goto(`/x/${EXT_ID}`);
  await waitForLines(lines, /^ready$/);
  return lines;
}

/**
 * Let the no-click tries start, click once in DorkOS itself with the real mouse,
 * and check every try after that click is refused and the page never moves.
 */
async function clickInDorkosWhileHopTries(
  page: Page,
  lines: string[],
  at: { x: number; y: number }
): Promise<void> {
  await waitForLines(lines, /^try \d+ /, 2);
  await page.mouse.click(at.x, at.y);
  const before = tries(lines).length;
  await waitForLines(lines, /^try \d+ /, before + TRIES_AFTER);
  expect(tries(lines).every((line) => line.endsWith('refused: no-gesture'))).toBe(true);
  expect(page.url()).toMatch(HOP_URL);
}

/** Show Hop's second view, the "Hop B" right-panel tab, and find its button. */
async function showHopB(page: Page): Promise<{ x: number; y: number }> {
  await new RightPanelPage(page).selectView('Hop B');
  return middleOf(
    appFrame(page.locator('#right-panel-content'), 'Hop').getByRole('button', {
      name: 'Hop B button',
    })
  );
}

test.describe('Opening another app’s page needs a click in the app', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ request }) => {
    const config = (await (await request.get('/api/config')).json()) as { dorkHome?: string };
    expect(config.dorkHome, 'the API leg reports its data directory').toBeTruthy();
    pluginDir = path.join(config.dorkHome as string, 'plugins', PLUGIN_NAME);
    cpSync(PLUGIN_FIXTURE, pluginDir, { recursive: true });
    for (const id of [HELLO, EXT_ID]) {
      const enabled = await request.post(`/api/extensions/${id}/enable`, { data: {} });
      expect(enabled.ok(), `enable ${id}: ${await enabled.text()}`).toBe(true);
    }
  });

  test.afterAll(async ({ request }) => {
    await leaveNoUnreadRows(request, (row) => row.kind === 'extension.approval');
    for (const id of [EXT_ID, HELLO]) {
      await request.post(`/api/extensions/${id}/disable`, { data: {} });
    }
    if (pluginDir) rmSync(pluginDir, { recursive: true, force: true });
    await request.post('/api/extensions/reload', { data: {} });
  });

  test('(a) refuses every try with no click at all', async ({ page }) => {
    test.setTimeout(90_000);
    // Approve Hop from the inbox: the one yes this app needs.
    await page.goto('/');
    await page.getByTestId('inbox-bell').click();
    await expect(page.getByText('Hop wants to run on this computer.')).toBeVisible();
    await page.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(page.getByText('Hop wants to run on this computer.')).toHaveCount(0);

    // A fresh load: nothing done before carries any activation here.
    const lines = await openHop(page);
    await waitForLines(lines, /^try \d+ /, TRIES_AFTER);
    expect(tries(lines).every((line) => line.endsWith('refused: no-gesture'))).toBe(true);
    expect(page.url()).toMatch(HOP_URL);
  });

  test('(b) refuses every try after a click on a DorkOS button', async ({ page }) => {
    test.setTimeout(90_000);
    const lines = await openHop(page);
    // A focusable button in DorkOS's own header. (The inbox bell shows only while
    // something waits, and nothing does here.)
    const button = await middleOf(page.getByRole('button', { name: 'Control Center' }));
    await clickInDorkosWhileHopTries(page, lines, button);
  });

  test('(c) refuses every try after a click on DorkOS text, focus left in the app', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const lines = await openHop(page);
    // The page title: text the host draws, which takes no focus, so focus stays in Hop's frame.
    const title = await middleOf(page.getByRole('main').getByText('Hop', { exact: true }).first());
    await clickInDorkosWhileHopTries(page, lines, title);
  });

  test('(d) opens Hello World’s page from a real click in the app', async ({ page }) => {
    test.setTimeout(60_000);
    const lines = await openHop(page);
    const button = await middleOf(
      appFrame(appPage(page), 'Hop').getByRole('button', { name: 'Open Hello World' })
    );
    await page.waitForTimeout(ACTIVATION_RUNS_OUT_MS);
    await page.mouse.click(button.x, button.y);
    await expect.poll(() => page.url(), { timeout: 15_000 }).toMatch(HELLO_URL);
    // The button opened it, not a no-click try: none had started.
    expect(lines).toContain('button pressed');
    expect(tries(lines)).toEqual([]);
  });

  test('(e) opens Hello World’s page from Enter pressed in the app', async ({ page }) => {
    test.setTimeout(60_000);
    const lines = await openHop(page);
    await appFrame(appPage(page), 'Hop')
      .getByRole('button', { name: 'Open Hello World' })
      .focus({ timeout: 5_000 });
    await page.waitForTimeout(ACTIVATION_RUNS_OUT_MS);
    // A key pressed in the frame never reaches the host's keydown listener.
    await page.keyboard.press('Enter');
    await expect.poll(() => page.url(), { timeout: 15_000 }).toMatch(HELLO_URL);
    // The button opened it, not a no-click try: none had started.
    expect(lines).toContain('button pressed');
    expect(tries(lines)).toEqual([]);
  });

  test('(f) refuses every try while the person clicks the app’s other frame', async ({ page }) => {
    test.setTimeout(90_000);
    const lines = await openHop(page);
    const hopB = await showHopB(page);
    // Hop's page keeps focusing itself from here; the person clicks Hop B.
    await waitForLines(lines, /^try \d+ /, 2);
    await page.mouse.click(hopB.x, hopB.y);
    await waitForLines(lines, /^b pressed$/);
    const before = tries(lines).length;
    await waitForLines(lines, /^try \d+ /, before + TRIES_AFTER);
    expect(tries(lines).every((line) => line.endsWith('refused: no-gesture'))).toBe(true);
    expect(page.url()).toMatch(HOP_URL);
  });
});
