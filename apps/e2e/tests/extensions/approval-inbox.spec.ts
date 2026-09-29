import { cpSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures';

/**
 * An installed extension waiting to run asks in the Activity inbox, and one
 * click there turns it on with no reload (DOR-2517, spec `flow-multiproject`
 * §5.6 "Real browser").
 *
 * The fixture is a plugin carrying one extension, `flow-fixture`, named "Flow",
 * that adds a right-panel tab titled "Flow". It is put where the marketplace
 * installer puts a plugin (`{dorkHome}/plugins/<name>`) and turned on the way
 * the installer turns it on (`POST /api/extensions/:id/enable`), with no
 * network. The data directory is the leg's own throwaway home, which
 * `global-setup.ts` has already refused to run without.
 *
 * Installed here rather than in global setup: a waiting extension shows in the
 * bell on every page, and no other spec should have to reason about it. The
 * plugin is removed again afterwards.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_FIXTURE = path.resolve(HERE, '../../fixtures/extensions/flow-fixture');
const EXT_ID = 'flow-fixture';

/** The leg's data directory, as `GET /api/config` reports it. */
let pluginDir: string | undefined;

test.describe('An extension waiting to run asks in the inbox', () => {
  test.beforeAll(async ({ request }) => {
    const config = (await (await request.get('/api/config')).json()) as { dorkHome?: string };
    expect(config.dorkHome, 'the API leg reports its data directory').toBeTruthy();
    pluginDir = path.join(config.dorkHome as string, 'plugins', EXT_ID);
    cpSync(PLUGIN_FIXTURE, pluginDir, { recursive: true });

    const enabled = await request.post(`/api/extensions/${EXT_ID}/enable`, { data: {} });
    expect(enabled.ok(), await enabled.text()).toBe(true);
  });

  test.afterAll(async ({ request }) => {
    await request.post(`/api/extensions/${EXT_ID}/revoke`, { data: {} });
    await request.post(`/api/extensions/${EXT_ID}/disable`, { data: {} });
    if (pluginDir) rmSync(pluginDir, { recursive: true, force: true });
    await request.post('/api/extensions/reload', { data: {} });
  });

  test('turning it on from the inbox adds its tab with no reload', async ({ page, rightPanel }) => {
    await rightPanel.goto('/tasks');
    // Anything the page does from here on must happen without a navigation.
    const navigations: string[] = [];
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });

    await page.getByTestId('inbox-bell').click();
    await expect(page.getByText('Turn on Flow?')).toBeVisible();
    await expect(
      page.getByText(
        'You installed the flow-fixture plugin. This adds a Flow tab that shows a fixture panel ' +
          'for the browser tests. It runs as you.'
      )
    ).toBeVisible();

    await page.getByRole('button', { name: 'Turn it on' }).click();
    await expect(page.getByText('Turn on Flow?')).toHaveCount(0);

    await page.keyboard.press('Escape');
    await rightPanel.open();
    await expect(rightPanel.header.getByRole('tab', { name: 'Flow' })).toBeVisible({
      timeout: 15_000,
    });
    expect(navigations).toEqual([]);
  });
});
