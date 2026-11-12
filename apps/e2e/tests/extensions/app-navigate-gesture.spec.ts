import { cpSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures';
import { appFrame, appPage } from '../../pages/app-frame.js';
import { leaveNoUnreadRows } from './inbox-hygiene';

/**
 * An app opens another app's page only from a real click in its own frame
 * (DOR-3293, Security's Must on #3657, and its Should 1 focus case).
 *
 * The fixture `hop-fixture`, named "Hop", lists `hello-world` with
 * `navigate: true`. When its page loads, it puts focus on its own frame with
 * `window.focus()` and calls `api.navigate` with no click: the browser raises
 * no user activation for that, so DorkOS must answer `no-gesture` and stay
 * put. Its "Open Hello World" button is a real click, which DorkOS honours.
 *
 * The unit tests fake `navigator.userActivation`; only a real browser can show
 * that a frame focusing itself raises none. It runs in CI only (no Chromium on
 * the machine it was written on), on the `chromium-extension-seams` project:
 * it turns `hello-world` on and off, so it shares that project's one worker.
 *
 * Installed the way `approval-inbox.spec.ts` installs its fixture, under a
 * fresh plugin name per run, and approved from the inbox with one click.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_FIXTURE = path.resolve(HERE, '../../fixtures/extensions/hop-fixture');
const EXT_ID = 'hop-fixture';
const HELLO = 'hello-world';

/** A fresh folder per run: an approval is bound to a copy's path (see approval-inbox.spec.ts). */
const PLUGIN_NAME = `hop-fixture-${process.pid}-${Date.now()}`;
let pluginDir: string | undefined;

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

  test('refuses an open after the app focuses its own frame with no click', async ({ page }) => {
    // Approve Hop from the inbox: the one yes this app needs.
    await page.goto('/');
    await page.getByTestId('inbox-bell').click();
    await expect(page.getByText('Hop wants to run on this computer.')).toBeVisible();
    await page.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(page.getByText('Hop wants to run on this computer.')).toHaveCount(0);

    // A fresh load: nothing the person did before carries any activation here.
    await page.goto(`/x/${EXT_ID}`);
    const hop = appFrame(appPage(page), 'Hop');
    await expect(hop.getByTestId('hop-on-load')).toHaveText('refused: no-gesture', {
      timeout: 15_000,
    });
    await expect(page).toHaveURL(new RegExp(`/x/${EXT_ID}$`));
    // Recorded, not asserted: whether the browser let the frame take focus at all.
    test.info().annotations.push({
      type: 'focus after window.focus()',
      description: String(await page.evaluate(() => document.activeElement?.tagName)),
    });
  });

  test('opens Hello World’s page from a real click in the app', async ({ page }) => {
    await page.goto(`/x/${EXT_ID}`);
    const hop = appFrame(appPage(page), 'Hop');
    await hop.getByRole('button', { name: 'Open Hello World' }).click();
    await expect(page).toHaveURL(/\/x\/hello-world$/, { timeout: 15_000 });
  });
});
