import { expect, test, type APIRequestContext } from '@playwright/test';
import { describeViolation, runAxe, settleAnimations } from '../../axe.js';
import {
  actAsPersonInPage,
  ensureTestOwner,
  removeTestOwner,
  type TestOwner,
} from '../../fixtures/person-step-up.js';

const SERVER = 'made-up-server';

/** The owner the one test with a "Confirm it's you" registers, and removes again. */
const OWNER: TestOwner = {
  email: 'mcp-servers-owner@example.test',
  password: 'made-up-owner-password',
  name: 'Made Up Owner',
};

/** Remove what an earlier test or retry left, so the list starts empty. */
async function removeServer(request: APIRequestContext, apiUrl: string) {
  await request.delete(`${apiUrl}/api/mcp-servers/${SERVER}`);
}

/**
 * Connections → MCP servers on this leg's real server, which has no owner yet, so the person at
 * this computer goes on with no "Confirm it's you". One test registers an owner to walk that sheet,
 * since no other browser test opens it, and removes the owner before it ends: an owner is
 * server-global.
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
      const lock = dialog.getByRole('button', { name: 'Hide this value' });
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

    test('an owner cancels "Confirm it\'s you", nothing is added, then confirms', async ({
      page,
      request,
    }) => {
      try {
        await ensureTestOwner(request, apiUrl, OWNER);
        await actAsPersonInPage(page, apiUrl, OWNER.password);
        await page.goto('/connections?tab=mcp');

        await page.getByRole('button', { name: 'Add server' }).click();
        const dialog = page.getByRole('dialog', { name: 'Add a server' });
        await dialog.getByLabel('Name', { exact: true }).fill(SERVER);
        await dialog.getByLabel('Command', { exact: true }).fill('npx');
        const args = dialog.getByLabel('Arguments');
        await args.fill('-y made-up-mcp@1.2.3 --token=made-up-canary');
        await args.blur();
        const secretWarning = dialog.getByText('This looks like a secret.', { exact: false });
        await expect(secretWarning).toHaveClass(/text-status-warning-fg/);
        await args.fill('-y made-up-mcp@1.2.3');
        await args.blur();
        await expect(secretWarning).toBeHidden();

        await dialog.getByRole('button', { name: 'Add a variable' }).click();
        await dialog.getByLabel('Name of variable 1').fill('MADE_UP_TOKEN');
        await dialog.getByLabel('Value of MADE_UP_TOKEN').fill('made-up-value');
        await dialog.getByRole('button', { name: 'Add a variable' }).click();
        await dialog.getByLabel('Name of variable 2').fill('NODE_OPTIONS');
        await dialog.getByLabel('Value of NODE_OPTIONS').fill('--max-old-space-size=512');
        await dialog.getByRole('button', { name: 'Add', exact: true }).click();

        const sheet = page.getByRole('alertdialog', { name: 'Confirm it’s you' });
        await expect(sheet).toContainText(`Add ${SERVER} (made-up-mcp@1.2.3) for all your agents.`);
        await expect(sheet).toContainText('Settings: NODE_OPTIONS');
        await expect(sheet).toContainText('Kept secret: MADE_UP_TOKEN');
        await expect(sheet).not.toContainText('made-up-value');
        await expect(sheet.getByText('NODE_OPTIONS changes what the program loads.')).toHaveClass(
          /text-status-warning-fg/
        );

        // The footer every "Confirm it's you" shares: normal size, on the right, Confirm last.
        const cancel = sheet.getByRole('button', { name: 'Cancel' });
        const confirm = sheet.getByRole('button', { name: 'Confirm', exact: true });
        const password = sheet.getByLabel('DorkOS password');
        await expect(password).toBeEnabled();
        await settleAnimations(page);
        const [sheetBox, cancelBox, confirmBox] = await Promise.all([
          sheet.boundingBox(),
          cancel.boundingBox(),
          confirm.boundingBox(),
        ]);
        expect(confirmBox!.x).toBeGreaterThan(cancelBox!.x);
        expect(confirmBox!.x + confirmBox!.width).toBeGreaterThan(
          sheetBox!.x + sheetBox!.width * 0.8
        );
        expect(confirmBox!.width).toBeLessThan(sheetBox!.width / 2);
        const { violations } = await runAxe(page, '[role="alertdialog"]');
        expect(violations.map(describeViolation)).toEqual([]);

        // A cancel adds nothing and keeps what was typed.
        await cancel.click();
        await expect(sheet).toBeHidden();
        await expect(dialog.getByText('Not confirmed. Nothing changed.')).toBeVisible();
        await expect(dialog.getByLabel('Value of MADE_UP_TOKEN')).toHaveValue('made-up-value');
        const row = page.getByTestId(`mcp-server-row-${SERVER}`);
        await expect(row).toHaveCount(0);

        await dialog.getByRole('button', { name: 'Add', exact: true }).click();
        await sheet.getByLabel('DorkOS password').fill(OWNER.password);
        await sheet.getByRole('button', { name: 'Confirm', exact: true }).click();
        await expect(sheet).toBeHidden();
        await expect(dialog).toBeHidden();
        await expect(row).toContainText('All agents');
      } finally {
        // Before the hook's delete, which an owner would otherwise refuse.
        removeTestOwner(apiUrl, OWNER.email);
      }
    });
  });
}
