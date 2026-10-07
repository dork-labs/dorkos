/** Explicit reviewed replay over the original native owning-session FILE source. */
import { test, expect } from '@playwright/test';
import {
  CanvasChannelManagementSnapshotSchema,
  CanvasChannelBatchReplayRequestSchema,
  CanvasChannelBatchReplayResultSchema,
  type CanvasChannelBatchReplayRequest,
} from '@dorkos/shared/canvas-channel-schemas';
import { startIsolatedConsumerHost } from '../../fixtures/doc-channel-consumer/server.js';
import { signInOriginalConsumerHost } from '../../fixtures/doc-channel-consumer/browser-bootstrap.js';
import { RightPanelPage } from '../../pages/RightPanelPage.js';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

test('operator reviews genuine expired input, retries the same replay operation and separately enters one native session turn', async ({
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
  const responseWork = new Set<Promise<void>>();
  let intercepted = false;
  const retained: {
    request?: CanvasChannelBatchReplayRequest;
    nextBatchId?: string;
    nextGeneration?: string;
  } = {};
  let replayUrl: string | undefined;
  try {
    const opened = await host.openReviewedReplayFile();
    if (typeof opened.documentId !== 'string' || !opened.documentId)
      throw new Error('Original reviewed FILE unavailable');
    const documentId = opened.documentId;
    replayUrl = host.origin + '/api/canvas/docs/' + documentId + '/manage/replay';
    await page.goto(
      host.origin + '/session?session=' + host.sessionId + '&dir=' + encodeURIComponent(host.root)
    );
    await signInOriginalConsumerHost(page, host);
    const panel = new RightPanelPage(page);
    await panel.ensureTabStripOpen();
    await panel.canvasTab.click();
    await page.getByRole('tab', { name: 'Native reviewed source', exact: true }).click();
    await page.getByRole('button', { name: 'Document events', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Document events', exact: true });
    await dialog.getByLabel('Declared route', { exact: true }).selectOption('native-reviewed');
    await dialog
      .getByLabel('Approved event types, comma separated', { exact: true })
      .fill('task.changed');
    const expiry = new Date(Date.now() + 48 * 3600_000).toISOString();
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
      route: {
        id: 'native-reviewed',
        to: 'agent:owner',
        turn: { mode: 'coalesce', windowMs: 1000, maxBatch: 2 },
      },
      allowedTypes: ['task.changed'],
      expiresAt: expiry,
    });
    await dialog
      .getByRole('button', { name: 'Approve once and apply exact request', exact: true })
      .click();
    await expect(subject).toHaveCount(0);
    const approvedResponse = await page.request.get(
      host.origin + '/api/canvas/docs/' + documentId + '/management'
    );
    expect(approvedResponse.status()).toBe(200);
    const approved = CanvasChannelManagementSnapshotSchema.parse(await approvedResponse.json());
    const grant = approved.grants.find(
      (row) => row.routeId === 'native-reviewed' && row.expiresAt === expiry
    );
    if (!grant || grant.revokedAt !== null)
      throw new Error('Original reviewed route approval unavailable');
    expect(grant).toMatchObject({ allowedTypes: ['task.changed'], destination: 'agent:owner' });
    await host.expireOriginalReviewedReplay();
    const expired = await host.readOriginalReviewedReplayData();
    expect(expired).toMatchObject({
      documentId,
      baselineUnchanged: true,
      receipts: [],
      scenarioStarts: 0,
    });
    expect(expired.events).toHaveLength(1);
    expect(expired.batches).toHaveLength(1);
    expect(expired.deliveries).toHaveLength(1);
    const old = expired.batches[0];
    expect(old).toMatchObject({
      routeId: 'native-reviewed',
      grantId: grant.grantId,
      status: 'expired',
      admissionReceiptId: null,
      turnId: null,
      roomAdmissionId: null,
      errorCode: 'manual_replay_required',
      inputEventIds: [expired.inputId],
    });
    expect(expired.deliveries[0]).toMatchObject({
      eventId: expired.inputId,
      batchId: old.batchId,
      status: 'expired',
    });
    await dialog.getByRole('button', { name: 'Close document controls', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Document events', exact: true }).click();
    const review = dialog.getByRole('region', { name: 'Explicit work review', exact: true });
    await review.getByLabel('Expired batch', { exact: true }).selectOption(old.batchId);
    await review
      .getByLabel('Current approval for replay', { exact: true })
      .selectOption(grant.grantId);
    const replayButton = review.getByRole('button', {
      name: 'Replay reviewed expired work',
      exact: true,
    });
    await expect(replayButton).toBeDisabled();
    await review
      .getByRole('checkbox', {
        name: 'I reviewed this saved batch and its selected approval and want one new generation.',
        exact: true,
      })
      .check();
    await page.route(replayUrl, (route) => {
      const work = (async () => {
        try {
          const request = CanvasChannelBatchReplayRequestSchema.parse(
            route.request().postDataJSON()
          );
          expect(request).toMatchObject({
            documentId,
            expectedGeneration: approved.generation,
            batchId: old.batchId,
            expectedBatchGeneration: old.generation,
            grantId: grant.grantId,
          });
          if (retained.request) expect(request).toEqual(retained.request);
          else retained.request = request;
          const response = await route.fetch();
          expect(response.status()).toBe(200);
          const result = CanvasChannelBatchReplayResultSchema.parse(await response.json());
          expect(result).toMatchObject({
            documentId,
            eventId: request.eventId,
            previousBatchId: old.batchId,
          });
          if (!intercepted) {
            intercepted = true;
            retained.nextBatchId = result.batchId;
            retained.nextGeneration = result.generation;
            expect(result.status).toBe('pending');
            await route.abort();
          } else {
            expect(result).toMatchObject({
              status: 'duplicate',
              batchId: retained.nextBatchId,
              generation: retained.nextGeneration,
            });
            await route.fulfill({ response });
          }
        } catch (cause) {
          remember(cause);
          throw cause;
        }
      })();
      responseWork.add(work);
      void work.catch(remember).finally(() => responseWork.delete(work));
    });
    await replayButton.click();
    const retry = review.getByRole('button', {
      name: 'Retry original replay operation',
      exact: true,
    });
    await expect(retry).toBeEnabled();
    await retry.click();
    await expect(
      review.getByText(
        'The original replay operation was already recorded. No second replay was created.',
        { exact: true }
      )
    ).toBeVisible();
    await expect.poll(() => responseWork.size).toBe(0);
    if (failed) throw first;
    const replayed = await host.readOriginalReviewedReplayData();
    expect(replayed.events).toEqual(expired.events);
    expect(replayed.batches).toHaveLength(2);
    expect(replayed.receipts).toEqual([]);
    expect(replayed.scenarioStarts).toBe(0);
    expect(replayed.batches.find((row) => row.batchId === old.batchId)?.errorCode).toBe(
      'manual_replay_consumed'
    );
    const next = replayed.batches.find((row) => row.batchId === retained.nextBatchId);
    expect(next).toMatchObject({
      generation: retained.nextGeneration,
      inputEventIds: [expired.inputId],
      status: 'pending',
      admissionReceiptId: null,
      turnId: null,
      roomAdmissionId: null,
      grantId: grant.grantId,
    });
    expect(next?.generation).not.toBe(old.generation);
    await host.pumpOriginalReviewedReplay();
    await expect
      .poll(async () => (await host.readOriginalReviewedReplayData()).scenarioStarts)
      .toBe(1);
    const started = await host.readOriginalReviewedReplayData();
    expect(started.baselineUnchanged).toBe(true);
    expect(started.events).toEqual(expired.events);
    expect(started.batches).toHaveLength(2);
    expect(started.receipts).toHaveLength(1);
    expect(started.receipts[0]).toMatchObject({
      sourceId: retained.nextBatchId,
      sourceGeneration: retained.nextGeneration,
    });
    expect(started.receipts[0].turnStartSeq).toEqual(expect.any(Number));
    expect(started.deliveries).toHaveLength(1);
    expect(started.deliveries[0]).toMatchObject({
      eventId: expired.inputId,
      batchId: retained.nextBatchId,
    });
    // FIRST is separate from replay acceptance and does not claim handled/ACK.
    expect(started.scenarioStarts).toBe(1);
  } catch (cause) {
    remember(cause);
  }
  if (replayUrl) {
    try {
      await page.unroute(replayUrl);
    } catch (cause) {
      remember(cause);
    }
  }
  const pageRetirement = page.goto('about:blank').catch(remember);
  const hostRetirement = host.close().catch(remember);
  await Promise.allSettled([pageRetirement, hostRetirement, ...responseWork]);
  if (failed) throw first;
});
