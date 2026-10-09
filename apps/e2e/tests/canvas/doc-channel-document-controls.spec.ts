/** Genuine authenticated own-session document controls; credentials never enter trace/video. */
import { test, expect } from '@playwright/test';
import {
  CanvasChannelReplayResponseSchema,
  type CanvasChannelReplayResponse,
  CanvasChannelManagementSnapshotSchema,
} from '@dorkos/shared/canvas-channel-schemas';
import { startIsolatedConsumerHost } from '../../fixtures/doc-channel-consumer/server.js';
import { signInOriginalConsumerHost } from '../../fixtures/doc-channel-consumer/browser-bootstrap.js';
import { RightPanelPage } from '../../pages/RightPanelPage.js';

// A timeout can interrupt cleanup while the one-time credential is revealed.
// Manual pre-credential visual captures below remain enabled.
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

/** Preserve every channel field while admitting only fully audited native presence transitions. */
function auditOriginalPresenceOnlyReplay(
  before: CanvasChannelReplayResponse,
  after: CanvasChannelReplayResponse,
  documentId: string
): void {
  const {
    events: beforeEvents,
    receipts: beforeReceipts,
    highWatermark: beforeHigh,
    ...beforeStable
  } = before;
  const {
    events: afterEvents,
    receipts: afterReceipts,
    highWatermark: afterHigh,
    ...afterStable
  } = after;
  expect(afterStable).toEqual(beforeStable);
  expect(afterEvents.slice(0, beforeEvents.length)).toEqual(beforeEvents);
  expect(afterReceipts.slice(0, beforeReceipts.length)).toEqual(beforeReceipts);
  expect(afterEvents.length).toBeLessThanOrEqual(32);
  expect(afterHigh - beforeHigh).toBe(afterEvents.length - beforeEvents.length);
  expect(afterReceipts).toHaveLength(afterEvents.length);
  let views = 0,
    publishedViews = 0,
    sequence = 0;
  const ids = new Set<string>();
  for (const [index, frame] of afterEvents.entries()) {
    expect(frame.documentId).toBe(documentId);
    expect(frame.scope).toBe(after.scope);
    if (frame.incarnation !== undefined) expect(frame.incarnation).toEqual(after.incarnation);
    expect(frame.docSeq).toBe(sequence + 1);
    expect(ids.has(frame.event.id)).toBe(false);
    ids.add(frame.event.id);
    sequence = frame.docSeq;
    const { type, payload, direction } = frame.event;
    expect(['host.opened', 'host.closed', 'doc.viewers', 'host.focus']).toContain(type);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw new Error('Original controls presence payload unavailable');
    if (type === 'host.focus') {
      expect(direction).toBe('upstream');
      expect(Object.keys(payload)).toEqual(['focused']);
      expect(typeof payload.focused).toBe('boolean');
    } else if (type === 'doc.viewers') {
      expect(direction).toBe('system');
      expect(Object.keys(payload)).toEqual(['views']);
      expect(payload.views).toBe(views);
      expect(views).not.toBe(publishedViews);
      publishedViews = views;
    } else {
      expect(direction).toBe('system');
      expect(Object.keys(payload)).toEqual(['mounts']);
      const mounts = payload.mounts;
      if (typeof mounts !== 'number' || !Number.isSafeInteger(mounts) || mounts < 1)
        throw new Error('Original controls presence mount count unavailable');
      if (type === 'host.opened') expect(mounts).toBe(1);
      views += type === 'host.opened' ? mounts : -mounts;
      expect(views).toBeGreaterThanOrEqual(0);
    }
    expect(afterReceipts[index]).toEqual({
      receipt: { id: frame.event.id, status: 'recorded', docSeq: frame.docSeq },
      deliveries: [],
      payloadAvailable: true,
    });
  }
  expect(sequence).toBe(afterHigh);
  expect(views).toBe(publishedViews);
}

test('document controls display exact approvals and mint, clear and revoke a scoped credential', async ({
  page,
}, testInfo) => {
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
    if (typeof file.documentId !== 'string' || !file.documentId)
      throw new Error('Original checkbox document ID unavailable');
    const fileDocumentId = file.documentId;
    const widget = await host.openBoundWidget();
    await page.goto(
      host.origin + '/session?session=' + host.sessionId + '&dir=' + encodeURIComponent(host.root)
    );
    await signInOriginalConsumerHost(page, host);
    const panel = new RightPanelPage(page);
    await panel.ensureTabStripOpen();
    await panel.canvasTab.click();
    await page.getByRole('tab', { name: 'Native checkbox file', exact: true }).click();
    const beforeResponse = await page.request.get(
      host.origin + '/api/canvas/docs/' + fileDocumentId + '/management'
    );
    expect(beforeResponse.status()).toBe(200);
    const before = CanvasChannelManagementSnapshotSchema.parse(await beforeResponse.json());
    const grant = before.grants.find((value) => value.routeId === 'native-checkbox');
    if (!grant || !grant.expiresAt || grant.revokedAt !== null)
      throw new Error('Original live FILE approval unavailable');
    const beforeChannel = await page.request.get(
      host.origin + '/api/canvas/docs/' + fileDocumentId + '/channel'
    );
    expect(beforeChannel.status()).toBe(200);
    const beforeData = CanvasChannelReplayResponseSchema.parse(await beforeChannel.json());
    const button = page.getByRole('button', { name: 'Document events', exact: true });
    await button.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Document events', exact: true });
    await expect(dialog.getByText('Document: Native checkbox file', { exact: true })).toBeVisible();
    await expect(
      dialog.getByText('native-checkbox: md.* → agent:owner (coalesce)', { exact: true })
    ).toBeVisible();
    expect(grant.destination).toBe('agent:owner');
    const grantLabel =
      'native-checkbox: ' +
      grant.allowedTypes.join(', ') +
      ' → ' +
      grant.destination +
      '; Expires ' +
      grant.expiresAt;
    await expect(dialog.getByText(grantLabel, { exact: true })).toBeVisible();
    // Capture only pre-credential controls; native secrets are never in these artifacts.
    await page.screenshot({
      path: testInfo.outputPath('document-controls-before-token.png'),
      animations: 'disabled',
    });
    const viewport = page.viewportSize();
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveClass(/(?:^|\s)dark(?:\s|$)/);
    await page.screenshot({
      path: testInfo.outputPath('document-controls-system-dark.png'),
      animations: 'disabled',
    });
    // A viewport change may retire the parent Canvas mount. Exercise each actual
    // responsive controls mount through its own user open/close interaction.
    await dialog.getByRole('button', { name: 'Close document controls', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await button.click();
    await expect(dialog.getByText('Document: Native checkbox file', { exact: true })).toBeVisible();
    await expect(dialog.getByLabel('Exact event types, comma separated')).toBeVisible();
    await expect(dialog.getByText(grantLabel, { exact: true })).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Close document controls', exact: true })
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('document-controls-mobile.png'),
      animations: 'disabled',
    });
    await dialog.getByRole('button', { name: 'Close document controls', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    if (viewport) await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme: 'light' });
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(dialog.getByText('Document: Native checkbox file', { exact: true })).toBeVisible();
    await expect(dialog.getByLabel('Exact event types, comma separated')).toHaveValue('');
    await expect(dialog.getByText(grantLabel, { exact: true })).toBeVisible();
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    const choose = async () => {
      await dialog.getByLabel('Exact event types, comma separated').fill('md.task.toggled');
      await dialog.getByLabel('Expiry (ISO date with time zone)', { exact: true }).fill(expiresAt);
      await dialog.getByLabel('upstream', { exact: true }).check();
      await dialog.getByLabel('replay', { exact: true }).check();
      await dialog.getByLabel('stream', { exact: true }).check();
      await dialog.getByLabel(grantLabel, { exact: true }).check();
    };
    await choose();
    await dialog.getByRole('button', { name: 'Create token', exact: true }).click();
    const revealed = dialog.getByRole('textbox', { name: 'New standalone token', exact: true });
    await expect(revealed).toBeVisible();
    const credential = await revealed.inputValue();
    expect(/^dct_[A-Za-z0-9_-]{43}$/.test(credential)).toBe(true);
    const readStandaloneStatus = () =>
      page.evaluate(
        async ({ documentId, credential }) => {
          const response = await fetch('/api/canvas/token/docs/' + documentId + '/channel', {
            credentials: 'omit',
            headers: { Authorization: 'Bearer ' + credential },
          });
          return response.status;
        },
        { documentId: fileDocumentId, credential }
      );
    expect(await readStandaloneStatus()).toBe(200);
    // Only booleans leave this credential comparison; failed assertions cannot print it.
    expect(
      await page.evaluate((secret) => {
        const stored = [...Object.values(localStorage), ...Object.values(sessionStorage)].join('');
        return !location.href.includes(secret) && !stored.includes(secret);
      }, credential)
    ).toBe(true);
    const metadataResponse = await page.request.get(
      host.origin + '/api/canvas/docs/' + fileDocumentId + '/management'
    );
    expect(metadataResponse.status()).toBe(200);
    const metadataRaw: unknown = await metadataResponse.json();
    expect(JSON.stringify(metadataRaw).includes(credential)).toBe(false);
    const metadata = CanvasChannelManagementSnapshotSchema.parse(metadataRaw);
    const created = metadata.tokens.find((value) => value.expiresAt === expiresAt);
    if (!created) throw new Error('Original minted token metadata unavailable');
    expect(created.allowedTypes).toEqual(['md.task.toggled']);
    expect(created.directions).toEqual(['upstream']);
    expect(created.permissions).toEqual(['replay', 'stream']);
    await page.keyboard.press('Escape');
    await expect(revealed).toHaveCount(0);
    await button.click();
    await expect(dialog.getByRole('textbox', { name: 'New standalone token' })).toHaveCount(0);
    // Closing and changing documents must not revive a previous credential or scope.
    await dialog.getByRole('button', { name: 'Close document controls', exact: true }).click();
    await page.getByRole('tab', { name: 'Native bound widget', exact: true }).click();
    await button.click();
    await expect(dialog.getByText('Document: Native bound widget', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'New standalone token' })).toHaveCount(0);
    await expect(dialog.getByLabel('Exact event types, comma separated')).toHaveValue('');
    await dialog.getByRole('button', { name: 'Close document controls', exact: true }).click();
    await page.getByRole('tab', { name: 'Native checkbox file', exact: true }).click();
    await button.click();
    const tokenLine = dialog.getByText(
      created.tokenId + ': md.task.toggled; Expires ' + expiresAt,
      { exact: false }
    );
    await tokenLine.getByRole('button', { name: 'Revoke token', exact: true }).click();
    await expect(
      dialog.getByText(created.tokenId + ': md.task.toggled; Revoked', { exact: false })
    ).toBeVisible();
    expect(await readStandaloneStatus()).toBe(401);
    await dialog.getByRole('button', { name: 'Close document controls', exact: true }).click();
    const afterChannel = await page.request.get(
      host.origin + '/api/canvas/docs/' + fileDocumentId + '/channel'
    );
    expect(afterChannel.status()).toBe(200);
    auditOriginalPresenceOnlyReplay(
      beforeData,
      CanvasChannelReplayResponseSchema.parse(await afterChannel.json()),
      fileDocumentId
    );
    const widgetChannel = await page.request.get(
      host.origin + '/api/canvas/docs/' + widget.documentId + '/channel'
    );
    expect(widgetChannel.status()).toBe(200);
    expect(JSON.stringify(await widgetChannel.json()).includes(credential)).toBe(false);
    const fileData = await host.readOriginalCheckboxPairData();
    expect(fileData.baselineRestored).toBe(true);
    expect(fileData.events).toEqual([]);
    expect(fileData.privateAdmissions).toBe(0);
    expect(fileData.admissions).toBe(0);
    expect(fileData.spend).toBe(0);
  } catch (cause) {
    remember(cause);
  }
  // Always remove a revealed credential before Playwright captures failure artifacts.
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
