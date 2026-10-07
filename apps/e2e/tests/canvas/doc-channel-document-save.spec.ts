/** Original ordinary FILE save, retained retry, native FIRST and failed completion. */
import { createHash } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { WriteFileRequestSchema, type WriteFileRequest } from '@dorkos/shared/schemas';
import {
  CanvasChannelEventReceiptSchema,
  CanvasChannelManagementSnapshotSchema,
} from '@dorkos/shared/canvas-channel-schemas';
import { startIsolatedConsumerHost } from '../../fixtures/doc-channel-consumer/server.js';
import { signInOriginalConsumerHost } from '../../fixtures/doc-channel-consumer/browser-bootstrap.js';
import { RightPanelPage } from '../../pages/RightPanelPage.js';

// Exact approval subjects are excluded from retained browser media.
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

test('ordinary autosave retains one native saved operation across lost response and refuses a failed completion', async ({
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
  const work = new Set<Promise<void>>();
  const requests: WriteFileRequest[] = [];
  const replies: {
    status: number;
    effect?: unknown;
    receipt?: ReturnType<typeof CanvasChannelEventReceiptSchema.parse>;
  }[] = [];
  const retained: { first?: WriteFileRequest; second?: WriteFileRequest } = {};
  const saveUrl = host.origin + '/api/files/content';
  let mode: 'noop' | 'lost' | 'duplicate' | 'failure' | 'conflict' = 'noop';
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  try {
    const opened = await host.openDocumentSaveFile();
    if (typeof opened.documentId !== 'string' || !opened.documentId)
      throw new Error('Original saved FILE unavailable');
    const documentId = opened.documentId;
    await page.goto(
      host.origin + '/session?session=' + host.sessionId + '&dir=' + encodeURIComponent(host.root)
    );
    await signInOriginalConsumerHost(page, host);
    const panel = new RightPanelPage(page);
    await panel.ensureTabStripOpen();
    await panel.canvasTab.click();
    await page.getByRole('tab', { name: 'Native ordinary save file', exact: true }).click();
    await page.getByRole('button', { name: 'Document events', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Document events', exact: true });
    await expect(
      dialog.getByText('native-saved: doc.saved → agent:owner (immediate)', { exact: true })
    ).toBeVisible();
    await dialog.getByLabel('Declared route', { exact: true }).selectOption('native-saved');
    await dialog
      .getByLabel('Approved event types, comma separated', { exact: true })
      .fill('doc.saved');
    const expiry = new Date(Date.now() + 600_000).toISOString();
    await dialog.getByLabel('Route expiry (ISO date with time zone)', { exact: true }).fill(expiry);
    await dialog.getByRole('button', { name: 'Request exact route approval', exact: true }).click();
    const subject = dialog.getByRole('textbox', {
      name: 'Original server route approval subject',
      exact: true,
    });
    await expect(subject).toBeVisible();
    expect(JSON.parse(await subject.inputValue())).toMatchObject({
      documentId: '(hidden)',
      declarationHash: '(hidden)',
      route: { id: 'native-saved', to: 'agent:owner' },
      allowedTypes: ['doc.saved'],
      expiresAt: expiry,
    });
    await dialog
      .getByRole('button', { name: 'Approve once and apply exact request', exact: true })
      .click();
    await expect(subject).toHaveCount(0);
    const response = await page.request.get(
      host.origin + '/api/canvas/docs/' + documentId + '/management'
    );
    expect(response.ok()).toBe(true);
    const management = CanvasChannelManagementSnapshotSchema.parse(await response.json());
    const grant = management.grants.find(
      (row) => row.routeId === 'native-saved' && row.expiresAt === expiry
    );
    if (!grant) throw new Error('Original saved route approval unavailable');
    expect(grant).toMatchObject({
      destination: 'agent:owner',
      allowedTypes: ['doc.saved'],
      revokedAt: null,
    });
    await dialog.getByRole('button', { name: 'Close document controls', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const baseline = await host.readOriginalSavedData();
    expect(management.documentId).toBe(documentId);
    expect(baseline.approvalBindings).toContainEqual({
      grantId: grant.grantId,
      documentId,
      routeId: 'native-saved',
      exactBinding: true,
    });
    expect(baseline).toMatchObject({
      documentId,
      events: [],
      deliveries: [],
      admissions: [],
      scenarioStarts: 0,
    });
    expect(baseline.fileHash).toBe(baseline.baselineHash);
    await page.route(saveUrl, (route) => {
      const pending = (async () => {
        try {
          const currentMode = mode;
          const request = WriteFileRequestSchema.parse(route.request().postDataJSON());
          if (!request.documentSave) throw new Error('Original native save identity missing');
          expect(request.documentSave.documentId).toBe(documentId);
          expect(request.documentSave.expectedGeneration).toBe(management.generation);
          if (currentMode === 'lost') retained.first = request;
          if (currentMode === 'duplicate') expect(request).toEqual(retained.first);
          if (currentMode === 'failure') retained.second = request;
          if (currentMode === 'conflict') expect(request).toEqual(retained.second);
          const original = await route.fetch();
          const body: unknown = await original.json();
          if (!body || typeof body !== 'object') throw new Error('Original save response missing');
          const effect = 'effect' in body ? body.effect : undefined;
          const receipt =
            'documentReceipt' in body
              ? CanvasChannelEventReceiptSchema.parse(body.documentReceipt)
              : undefined;
          if (currentMode === 'noop') {
            expect(original.status()).toBe(200);
            expect(effect).toBe('no_op');
            expect(receipt).toBeUndefined();
          }
          if (currentMode === 'lost') {
            expect(original.status()).toBe(200);
            expect(effect).toBe('changed');
            expect(receipt?.receipt).toMatchObject({
              id: request.documentSave.eventId,
              status: 'recorded',
            });
          }
          if (currentMode === 'duplicate') {
            expect(original.status()).toBe(200);
            expect(effect).toBe('no_op');
            expect(receipt?.receipt).toMatchObject({
              id: request.documentSave.eventId,
              status: 'duplicate',
            });
          }
          if (currentMode === 'failure') {
            expect(original.status()).toBe(500);
            expect(receipt).toBeUndefined();
          }
          if (currentMode === 'conflict') {
            expect(original.status()).toBe(409);
            expect(receipt).toBeUndefined();
          }
          requests.push(request);
          replies.push({ status: original.status(), effect, receipt });
          if (currentMode === 'lost') await route.abort();
          else await route.fulfill({ response: original });
        } catch (cause) {
          remember(cause);
          try {
            await route.abort();
          } catch (cleanupCause) {
            remember(cleanupCause);
          }
        }
      })();
      work.add(pending);
      void pending.then(
        () => work.delete(pending),
        (cause) => {
          remember(cause);
          work.delete(pending);
        }
      );
      return pending;
    });
    await page.getByRole('button', { name: 'Edit file', exact: true }).click();
    await page.getByRole('button', { name: 'Finish editing', exact: true }).click();
    await expect.poll(() => replies.length).toBe(1);
    expect((await host.readOriginalSavedData()).events).toEqual([]);
    await page.getByRole('button', { name: 'Edit file', exact: true }).click();
    const editor = page.locator('.dorkos-markdown .ProseMirror').last();
    const mounted = await editor.elementHandle();
    if (!mounted) throw new Error('Original saved editor unavailable');
    mode = 'lost';
    await editor.click();
    await editor.press('ControlOrMeta+A');
    await editor.press('Backspace');
    await page.keyboard.insertText('Confirmed original ordinary autosave');
    await expect.poll(() => replies.length).toBe(2);
    const retry = page.getByRole('button', { name: 'Retry original save', exact: true });
    await expect(retry).toBeEnabled();
    const saved = await host.readOriginalSavedData();
    if (!retained.first?.documentSave)
      throw new Error('Original committed save request unavailable');
    expect(saved.fileHash).toBe(hash(retained.first.content));
    expect(saved.events).toHaveLength(1);
    expect(saved.events[0]).toMatchObject({
      eventId: retained.first.documentSave.eventId,
      payload: { previousFileHash: baseline.fileHash, fileHash: saved.fileHash },
    });
    expect(saved.deliveries).toHaveLength(1);
    expect(saved.deliveries[0]).toMatchObject({
      eventId: saved.events[0].eventId,
      routeId: 'native-saved',
      grantId: grant.grantId,
      status: 'pending',
    });
    expect(saved.admissions).toEqual([]);
    expect(saved.scenarioStarts).toBe(0);
    mode = 'duplicate';
    await retry.click();
    await expect.poll(() => replies.length).toBe(3);
    await expect(retry).toHaveCount(0);
    expect((await host.readOriginalSavedData()).events).toEqual(saved.events);
    expect(await host.pumpOriginalSavedDocument()).toEqual({ pumped: true });
    await expect
      .poll(async () => {
        const data = await host.readOriginalSavedData();
        return (
          data.admissions.length === 1 &&
          data.admissions[0].turnStartSeq !== null &&
          data.scenarioStarts === 1
        );
      })
      .toBe(true);
    const started = await host.readOriginalSavedData();
    expect(started.events).toEqual(saved.events);
    expect(started.admissions[0].batchId).toBe(started.deliveries[0].batchId);
    expect(started.admissions[0].turnStartSeq).toBeGreaterThan(0);
    expect(await host.armOriginalSavedInsertFailure()).toEqual({ armed: true });
    mode = 'failure';
    await editor.click();
    await editor.press('ControlOrMeta+A');
    await editor.press('Backspace');
    await page.keyboard.insertText('Persisted ordinary save with refused native completion');
    await expect.poll(() => replies.length).toBe(4);
    await expect(retry).toBeEnabled();
    if (!retained.second?.documentSave) throw new Error('Original failed save request unavailable');
    expect(retained.second.documentSave.eventId).not.toBe(retained.first.documentSave.eventId);
    const refused = await host.readOriginalSavedData();
    expect(refused.fileHash).toBe(hash(retained.second.content));
    expect(refused.events).toEqual(saved.events);
    expect(refused.scenarioStarts).toBe(1);
    expect(refused.admissions).toHaveLength(1);
    mode = 'conflict';
    await retry.click();
    await expect.poll(() => replies.length).toBe(5);
    const afterConflict = await host.readOriginalSavedData();
    expect(afterConflict.fileHash).toBe(refused.fileHash);
    expect(afterConflict.events).toEqual(saved.events);
    expect(afterConflict.deliveries).toHaveLength(1);
    expect(afterConflict.admissions).toHaveLength(1);
    expect(afterConflict.scenarioStarts).toBe(1);
    expect(await mounted.evaluate((node) => node.isConnected)).toBe(true);
    expect(requests).toHaveLength(5);
  } catch (cause) {
    remember(cause);
  }
  try {
    await page.unroute(saveUrl);
  } catch (cause) {
    remember(cause);
  }
  await Promise.allSettled([...work]);
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
