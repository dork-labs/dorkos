import type { Page, Route } from '@playwright/test';
import { test, expect } from '../../fixtures';

/**
 * Settings → Backups (DOR-4253) in a real browser: the total and every copy,
 * Move and Remove only on older copies, and nothing removed without the
 * confirm. The list is made-up data served by route interception, so no file
 * on the test server is touched; the server's own guards are covered by
 * `apps/server/src/routes/__tests__/config-backups.test.ts`.
 */

const MB = 1024 * 1024;
const OLDER = 'dork-20260901-daily.db';

/** The made-up list, before and after a removal. */
function backupList(withOlder: boolean) {
  const copies = [
    {
      name: 'dork-auto-20261119-daily.db',
      kind: 'daily',
      managed: true,
      sizeBytes: 12 * MB,
      createdAt: '2026-11-19T00:00:00.000Z',
      busy: false,
    },
    ...(withOlder
      ? [
          {
            name: OLDER,
            kind: 'daily',
            managed: false,
            sizeBytes: 40 * MB,
            createdAt: '2026-09-01T00:00:00.000Z',
            busy: false,
          },
        ]
      : []),
  ];
  return {
    folder: '/home/demo/.dork/backups',
    copies,
    totalBytes: copies.reduce((sum, copy) => sum + copy.sizeBytes, 0),
  };
}

/** Serve the list and record every Remove the page asks for. */
async function serveBackups(page: Page) {
  const removed: string[] = [];
  await page.route('**/api/config/backups', (route: Route) =>
    route.fulfill({ json: backupList(removed.length === 0) })
  );
  await page.route(`**/api/config/backups/${OLDER}`, (route: Route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    removed.push(OLDER);
    return route.fulfill({ json: { success: true } });
  });
  return removed;
}

test.describe('Settings → Backups', () => {
  test.beforeEach(async ({ basePage }) => {
    await basePage.goto();
    await basePage.waitForAppReady();
  });

  test('lists every copy with the total, and offers actions only on older ones', async ({
    page,
    settingsPage,
  }) => {
    await serveBackups(page);
    await settingsPage.open();
    await settingsPage.switchTab('Backups');

    const panel = settingsPage.activePanel;
    await expect(panel.getByTestId('backups-total')).toHaveText(
      'Backups use 52 MB on this computer.'
    );
    const rows = panel.getByRole('list', { name: 'Backups' }).getByRole('listitem');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Kept by DorkOS');
    await expect(rows.nth(1)).toContainText('Older copy');
    await expect(panel.getByRole('button', { name: `Remove ${OLDER}` })).toBeVisible();
    await expect(panel.getByRole('button', { name: `Move ${OLDER}` })).toBeVisible();
    await expect(panel.getByRole('button', { name: /dork-auto-20261119-daily\.db/ })).toHaveCount(
      0
    );
  });

  test('removes an older copy only after the confirm', async ({ page, settingsPage }) => {
    const removed = await serveBackups(page);
    await settingsPage.open();
    await settingsPage.switchTab('Backups');

    await settingsPage.activePanel.getByRole('button', { name: `Remove ${OLDER}` }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Remove this backup?' });
    await expect(confirm).toBeVisible();
    expect(removed).toEqual([]);

    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();
    expect(removed).toEqual([]);

    await settingsPage.activePanel.getByRole('button', { name: `Remove ${OLDER}` }).click();
    await page.getByRole('button', { name: 'Remove backup' }).click();
    await expect.poll(() => removed).toEqual([OLDER]);
    await expect(settingsPage.activePanel.getByTestId('backups-total')).toHaveText(
      'Backups use 12 MB on this computer.'
    );
  });
});
