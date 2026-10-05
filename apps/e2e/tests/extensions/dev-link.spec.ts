import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures';

/**
 * Run a plugin from a folder, see it badged, and switch back (DOR-2696, spec
 * `marketplace-dev-link`, "E2E").
 *
 * The person links a folder through the Installed toolbar's "Link a folder"
 * dialog, sees the "Dev link" tag and the folder's path on the Installed row
 * and on the extension it carries in Settings → Extensions, then unlinks it.
 *
 * Runs on the cockpit leg (`chromium`). Linking is a file operation, not a
 * turn, so no runtime is involved and nothing is billed. That leg is scoped to
 * the checkout (`DORKOS_BOUNDARY`), and a folder outside the boundary is
 * refused, so the throwaway folder lives in the checkout's gitignored `.temp/`
 * rather than the system temp directory. The leg's data directory is its own
 * throwaway home, so the link and its approvals never touch a real install.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../..');

/**
 * A fresh package name per run: a retry (CI runs one) must not find the first
 * attempt's link, and two runs on one machine must not share a slot.
 */
const PACKAGE = `dev-link-e2e-${process.pid}-${Date.now()}`;
/** The extension the package carries, so Settings → Extensions has a card for it. */
const EXT_ID = `dev-link-e2e-ext-${process.pid}`;

/** The folder this run links, created in `beforeAll`. */
let folder = '';

/**
 * Write a minimal plugin: a DorkOS manifest, a Claude Code plugin manifest,
 * and one extension that registers nothing.
 */
function writePlugin(dir: string): void {
  mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  mkdirSync(path.join(dir, '.dork', 'extensions', EXT_ID), { recursive: true });
  writeFileSync(
    path.join(dir, '.dork', 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: PACKAGE,
      version: '0.1.0',
      type: 'plugin',
      description: 'Browser-test fixture for dev links.',
    })
  );
  writeFileSync(
    path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: PACKAGE, version: '0.1.0', description: 'Dev link fixture' })
  );
  writeFileSync(
    path.join(dir, '.dork', 'extensions', EXT_ID, 'extension.json'),
    JSON.stringify({
      id: EXT_ID,
      name: 'Dev Link Fixture',
      version: '0.1.0',
      description: 'Browser-test fixture carried by a dev-linked plugin.',
    })
  );
  writeFileSync(
    path.join(dir, '.dork', 'extensions', EXT_ID, 'index.ts'),
    '/** Registers nothing: the card is what the test reads. */\nexport function activate(): void {}\n'
  );
}

test.describe('Run a package from a folder', () => {
  test.beforeAll(() => {
    const dir = path.join(REPO_ROOT, '.temp', 'e2e-dev-link', PACKAGE);
    writePlugin(dir);
    // The server refuses a path that is not its own real path, so the test
    // types exactly what the folder resolves to.
    folder = realpathSync(dir);
  });

  test.afterAll(async ({ request }) => {
    // If the test stopped between linking and unlinking, unlink here so the
    // leg's later specs never see this package. A 404 means it is already gone.
    await request.post(`/api/marketplace/dev-links/${PACKAGE}/unlink`, {
      data: { scope: 'global' },
    });
    if (folder) rmSync(folder, { recursive: true, force: true });
    await request.post('/api/extensions/reload', { data: {} });
  });

  test('links through the dialog, shows the badge in both places, and unlinks', async ({
    page,
    settingsPage,
  }) => {
    await page.goto('/marketplace?view=installed');

    await page.getByRole('button', { name: 'Link a folder' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Folder').fill(folder);
    await dialog.getByLabel('Folder').press('Tab');

    await expect(dialog.getByText(/^Run .+ from this folder\?$/)).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      dialog.getByText('Edits here run in DorkOS right away, without asking.')
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Link folder' }).click();
    await expect(dialog).toBeHidden();

    // The Installed row: the tag, and the folder on its own line.
    const row = page.getByRole('listitem').filter({ hasText: folder });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByText('Dev link', { exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: /^Uninstall/ })).toHaveCount(0);

    // Settings → Extensions: the extension the folder carries says so too.
    // Discovery runs after the link returns, so allow for the list to catch up.
    await settingsPage.open();
    await settingsPage.switchTab('Extensions');
    await expect(settingsPage.dialog.getByTestId(`extension-dev-link-${EXT_ID}`)).toContainText(
      folder,
      { timeout: 45_000 }
    );
    await settingsPage.close();

    // Unlink from the row. Nothing was installed before, so it is removed.
    await row.getByRole('button', { name: /^Unlink / }).click();
    const confirm = page.getByRole('dialog');
    await expect(confirm.getByText(/is removed\. Your folder is not touched\.$/)).toBeVisible();
    await confirm.getByRole('button', { name: 'Unlink', exact: true }).click();
    await expect(row).toHaveCount(0, { timeout: 15_000 });
  });
});
