/** Explicit denial through the genuine own-session FILE owner and original approval adapter. */
import { test, expect } from '@playwright/test';
import { CanvasChannelManagementSnapshotSchema } from '@dorkos/shared/canvas-channel-schemas';
import { startIsolatedConsumerHost } from '../../fixtures/doc-channel-consumer/server.js';
import { signInOriginalConsumerHost } from '../../fixtures/doc-channel-consumer/browser-bootstrap.js';
import { RightPanelPage } from '../../pages/RightPanelPage.js';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

test('operator denies an exact route approval without issuing a grant or replaying saved work', async ({
  page,
}) => {
  const host = await startIsolatedConsumerHost('session');
  let failed = false;
  let first: unknown;
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
    const beforeResponse = await page.request.get(
      host.origin + '/api/canvas/docs/' + file.documentId + '/management'
    );
    expect(beforeResponse.status()).toBe(200);
    const before = CanvasChannelManagementSnapshotSchema.parse(await beforeResponse.json());
    expect(before.documentId).toBe(file.documentId);
    expect(before.grantsTruncated).toBe(false);
    const originalBefore = await host.readOriginalCheckboxPairData();

    await page.getByRole('button', { name: 'Document events', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Document events', exact: true });
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
    // Secret redaction remains intact; the actual native audit independently binds the document.
    const actualSubject: unknown = JSON.parse(await subject.inputValue());
    expect(actualSubject).toMatchObject({
      documentId: '(hidden)',
      declarationHash: '(hidden)',
      route: { id: 'native-checkbox', to: 'agent:owner' },
      allowedTypes: ['md.task.toggled'],
      expiresAt: expiry,
    });
    await dialog.getByRole('button', { name: 'Deny route approval', exact: true }).click();
    await expect(subject).toHaveCount(0);
    await expect(
      dialog.getByText('Approval denied. Existing grants are unchanged.', { exact: true })
    ).toBeVisible();
    const afterResponse = await page.request.get(
      host.origin + '/api/canvas/docs/' + file.documentId + '/management'
    );
    expect(afterResponse.status()).toBe(200);
    const after = CanvasChannelManagementSnapshotSchema.parse(await afterResponse.json());
    expect(after.documentId).toBe(file.documentId);
    expect(after.generation).toBe(before.generation);
    expect(after.grantsTruncated).toBe(false);
    expect(after.grants).toEqual(before.grants);
    const original = await host.readOriginalCheckboxPairData();
    expect(original.approvalBindings).toEqual(originalBefore.approvalBindings);
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
