import { expect, test, type APIRequestContext } from '@playwright/test';
import { describeViolation, runAxe, settleAnimations } from '../../axe.js';

const SERVER = 'made-up-server';

/** Remove what an earlier test or retry left, so the list starts empty. */
async function removeServer(request: APIRequestContext, apiUrl: string) {
  await request.delete(`${apiUrl}/api/mcp-servers/${SERVER}`);
}

/**
 * Connections → MCP servers on this leg's real server, which has no owner yet, so the person at
 * this computer goes on with no "Confirm it's you". The hold itself is covered by the server's
 * own tests and the unit tests of the window's `fetch`.
 *
 * @param harness - The leg's API address.
 */
export function registerMcpServerTests({ apiUrl }: { apiUrl: string }) {
  test.describe('Connections — MCP servers', () => {
    test.beforeEach(({ request }) => removeServer(request, apiUrl));
    test.afterEach(({ request }) => removeServer(request, apiUrl));

    test('a person adds a server, turns it off and on, and removes it', async ({
      page,
      request,
    }) => {
      await page.goto('/connections');
      await page.getByRole('radio', { name: 'MCP servers' }).click();
      await expect(page).toHaveURL(/tab=mcp/);
      await expect(page.getByText(/^No servers yet/)).toBeVisible();

      await page.getByRole('button', { name: 'Add server' }).click();
      const dialog = page.getByRole('dialog', { name: 'Add a server' });
      await dialog.getByLabel('Name', { exact: true }).fill(SERVER);
      await dialog.getByLabel('Command', { exact: true }).fill('npx');
      await dialog.getByLabel('Arguments').fill('-y made-up-mcp@1.2.3');
      await dialog.getByRole('button', { name: 'Add a variable' }).click();
      await dialog.getByLabel('Name of variable 1').fill('MADE_UP_TOKEN');
      const lock = dialog.getByRole('button', { name: 'Only you' });
      await expect(lock).toHaveAttribute('aria-pressed', 'true');
      await expect(lock).toHaveAttribute('aria-disabled', 'true');
      await dialog.getByLabel('Value of MADE_UP_TOKEN').fill('made-up-value');
      await settleAnimations(page);
      const { violations } = await runAxe(page, '[role="dialog"]');
      expect(violations.map(describeViolation)).toEqual([]);
      await dialog.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(dialog).toBeHidden();

      const row = page.getByTestId(`mcp-server-row-${SERVER}`);
      await expect(row).toContainText('All agents');
      const listed = await (await request.get(`${apiUrl}/api/mcp-servers`)).text();
      expect(listed).not.toContain('made-up-value');

      const toggle = row.getByRole('switch');
      await expect(toggle).toBeChecked();
      await toggle.click();
      await expect(toggle).not.toBeChecked();
      await expect(row).toContainText('Off');
      await toggle.click();
      await expect(toggle).toBeChecked();

      await row.getByRole('button', { name: new RegExp(SERVER) }).click();
      const sheet = page.getByRole('dialog', { name: SERVER });
      await expect(sheet).toContainText('MADE_UP_TOKEN=••••••••');
      await sheet.getByRole('button', { name: 'Remove server' }).click();
      const ask = page.getByRole('alertdialog');
      await expect(ask.getByRole('button', { name: 'Cancel' })).toBeFocused();
      await ask.getByRole('button', { name: 'Remove', exact: true }).click();
      await expect(row).toBeHidden();
      await expect(page.getByText(/^No servers yet/)).toBeVisible();
    });
  });
}
