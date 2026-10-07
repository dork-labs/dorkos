/** Explicit route decisions through the genuine own-session FILE owner and installed HTTP adapter. */
import { test, expect } from '@playwright/test';
import { CanvasChannelManagementSnapshotSchema } from '@dorkos/shared/canvas-channel-schemas';
import { startIsolatedConsumerHost } from '../../fixtures/doc-channel-consumer/server.js';
import { signInOriginalConsumerHost } from '../../fixtures/doc-channel-consumer/browser-bootstrap.js';
import { RightPanelPage } from '../../pages/RightPanelPage.js';

test.use({ trace: 'off', video: 'off' });

test('operator reviews an exact route subject, approves it and revokes it without replaying saved work', async ({
  page,
}) => {
  const host = await startIsolatedConsumerHost('session');
  let failed = false,
    first: unknown;
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      first = cause;
    }
  };
  try {
    const file = await host.openCheckboxFile();
    await page.goto(
      host.origin + '/session?session=' + host.sessionId + '&dir=' + encodeURIComponent(host.root)
    );
    await signInOriginalConsumerHost(page, host);
    const panel = new RightPanelPage(page);
    await panel.ensureTabStripOpen();
    await panel.canvasTab.click();
    await page.getByRole('tab', { name: 'Native checkbox file', exact: true }).click();
    await page.getByRole('button', { name: 'Document events', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Declared route', { exact: true }).selectOption('native-checkbox');
    await dialog
      .getByLabel('Approved event types, comma separated', { exact: true })
      .fill('md.task.toggled');
    const expiry = new Date(Date.now() + 600_000).toISOString();
    await dialog.getByLabel('Route expiry (ISO date with time zone)', { exact: true }).fill(expiry);
    await dialog.getByRole('button', { name: 'Request exact route approval', exact: true }).click();
    const subject = dialog.getByRole('textbox', {
      name: 'Original server route approval subject',
      exact: true,
    });
    await expect(subject).toBeVisible();
    const rawSubject = await subject.inputValue();
    // The native approval detail is DATA. Assertions do not manufacture a target or consume it.
    const actualSubject: unknown = JSON.parse(rawSubject);
    expect(actualSubject).toMatchObject({
      documentId: '(hidden)',
      declarationHash: '(hidden)',
      route: { id: 'native-checkbox', to: 'agent:owner' },
      allowedTypes: ['md.task.toggled'],
      expiresAt: expiry,
    });
    await expect(
      dialog.getByRole('button', { name: 'Approve once and apply exact request', exact: true })
    ).toBeEnabled();
    await dialog
      .getByRole('button', { name: 'Approve once and apply exact request', exact: true })
      .click();
    await expect(subject).toHaveCount(0);
    const response = await page.request.get(
      host.origin + '/api/canvas/docs/' + file.documentId + '/management'
    );
    expect(response.status()).toBe(200);
    const current = CanvasChannelManagementSnapshotSchema.parse(await response.json());
    const grant = current.grants.find(
      (value) =>
        value.routeId === 'native-checkbox' &&
        value.expiresAt === expiry &&
        value.allowedTypes.length === 1 &&
        value.allowedTypes[0] === 'md.task.toggled'
    );
    if (!grant || grant.revokedAt !== null)
      throw new Error('Exact native route approval unavailable');
    expect(grant.destination).toBe('agent:owner');
    expect(current.documentId).toBe(file.documentId);
    const bindingAudit = await host.readOriginalCheckboxPairData();
    expect(bindingAudit.approvalBindings).toContainEqual({
      grantId: grant.grantId,
      documentId: file.documentId,
      routeId: 'native-checkbox',
      exactBinding: true,
    });
    const row = dialog.getByRole('group', { name: 'Route approval ' + grant.grantId, exact: true });
    await row.getByRole('button', { name: 'Revoke route native-checkbox', exact: true }).click();
    await expect(
      row.getByRole('button', { name: 'Revoke route native-checkbox', exact: true })
    ).toBeDisabled();
    const revokedResponse = await page.request.get(
      host.origin + '/api/canvas/docs/' + file.documentId + '/management'
    );
    expect(revokedResponse.status()).toBe(200);
    const revoked = CanvasChannelManagementSnapshotSchema.parse(await revokedResponse.json());
    expect(revoked.grants.find((value) => value.grantId === grant.grantId)?.revokedAt).toEqual(
      expect.any(String)
    );
    const original = await host.readOriginalCheckboxPairData();
    expect(original.baselineRestored).toBe(true);
    expect(original.events).toEqual([]);
    expect(original.privateAdmissions).toBe(0);
    expect(original.admissions).toBe(0);
    expect(original.spend).toBe(0);
  } catch (cause) {
    remember(cause);
  }
  try {
    await page.goto('about:blank');
  } catch (cause) {
    remember(cause);
  }
  try {
    await host.close();
  } catch (cause) {
    remember(cause);
  }
  if (failed) throw first;
});
