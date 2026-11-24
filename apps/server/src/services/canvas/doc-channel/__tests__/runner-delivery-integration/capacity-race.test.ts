/** Committed input → serialized runner → real gates → protected adoption → actual trigger, across file restart. */
import {
  databases,
  directories,
  detach,
  release,
  barrier,
  authorization,
  install,
  runner,
} from './harness.js';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createDb, sessionMessageAcceptanceReceipts, sessionMessageQueue } from '@dorkos/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { StreamEvent } from '@dorkos/shared/types';
import { batchFixture, NOW, TO } from '../batch-fixtures.js';
import { DocChannelService } from '../../service.js';
import { DocChannelIngest } from '../../ingest.js';
import {
  dispatchMessage,
  noteRuntimeTurnClosed,
  resetMessageDispatcher,
} from '../../../../session/message-dispatcher.js';
import {
  getOrCreateProjector,
  disposeProjector,
  rekeyProjector,
  setSessionEventStore,
} from '../../../../session/session-state-projector.js';
import { onDurableSessionRekey } from '../../../../session/turn-identity/durable-rekey.js';

it('preserves an accepted receipt across a real capacity race, canonical move, file restart and later release', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  const now = () => new Date();
  const directory = mkdtempSync(join(tmpdir(), 'doc-runner-accepted-'));
  directories.push(directory);
  const file = join(directory, 'state.db');
  const f = batchFixture(file, null, undefined, 'boot-1', 'claude-code', now);
  databases.push(f.db);
  const runtime = new FakeAgentRuntime('claude-code');
  runtime.getInternalSessionId.mockReturnValue(undefined);
  const person = barrier();
  runtime.withScenarios([
    async function* (): AsyncGenerator<StreamEvent> {
      await person.promise;
      yield { type: 'done', data: {} };
    },
  ]);
  const boot = install(f, runtime);
  let raced = false;
  const originalRunner = runner(f, boot.registry, now, () => {
    if (raced) return;
    raced = true;
    // Capacity became busy after the pump's atomic admission gate, before async protected adoption.
    dispatchMessage({
      sessionId: 'session-1',
      clientId: 'person',
      content: 'Person won capacity race',
      cwd: '/agents/one',
      runtime: boot.registry.get('claude-code'),
      projector: getOrCreateProjector('session-1', '/agents/one', { persist: 'history' }),
    });
  });
  const channel = new DocChannelService(f.documents, f.store, authorization(f), {
    ingest: new DocChannelIngest(f.store, now),
    grants: f.grants,
  });
  detach.push(channel.onCommittedInput(() => originalRunner.service.wake()));
  originalRunner.service.start();
  const eventId = randomUUID();
  await channel.ingestEvent(
    f.documentId,
    { v: 1, id: eventId, type: 'task.comment', payload: { text: 'PRESERVED-RECEIPT-MARKER' } },
    f.actor
  );
  const batch = f.store.getBatch(f.batchId())!;
  const input = f.store.getEvent(f.documentId, eventId)!;
  await vi.advanceTimersByTimeAsync(1200);
  await originalRunner.flush();
  expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
  const originalReceipt = f.db.select().from(sessionMessageAcceptanceReceipts).all()[0]!;
  const queue = f.db.select().from(sessionMessageQueue).all()[0]!;
  expect(originalReceipt).toMatchObject({
    state: 'accepted',
    sourceId: batch.batchId,
    sourceGeneration: batch.generation,
    dispatchAttemptId: null,
  });
  expect(f.store.getBatch(batch.batchId)!.status).toBe('accepted');
  expect(queue).toMatchObject({
    id: originalReceipt.queueMessageId,
    content: '[Document update: 1 action]',
  });
  const removeMove = onDurableSessionRekey((from, to) => {
    f.documents.rekeyScope(`session:${from}`, `session:${to}`);
  });
  detach.push(removeMove);
  rekeyProjector('session-1', 'canonical');
  const moved = f.db.select().from(sessionMessageAcceptanceReceipts).all()[0]!;
  expect(moved).toMatchObject({
    id: originalReceipt.id,
    sourceId: originalReceipt.sourceId,
    sourceGeneration: originalReceipt.sourceGeneration,
    queueMessageId: originalReceipt.queueMessageId,
    sessionId: 'canonical',
    originAgentPath: originalReceipt.originAgentPath,
    originRuntime: originalReceipt.originRuntime,
    state: 'accepted',
  });
  expect(moved.originAuthorityDigest).not.toBe(originalReceipt.originAuthorityDigest);
  expect(f.db.select().from(sessionMessageQueue).all()).toEqual([
    { ...queue, sessionId: 'canonical' },
  ]);
  await originalRunner.service.stop();
  removeMove();
  // Process disposal removes the pending in-memory adoption before the person's turn finishes.
  resetMessageDispatcher();
  person.done();
  await vi.advanceTimersByTimeAsync(1000);
  expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
  disposeProjector('session-1');
  disposeProjector('canonical');
  setSessionEventStore(undefined);
  f.db.$client.close();
  const db = createDb(file);
  databases.push(db);
  const reboot = batchFixture(
    file,
    null,
    { db, documentId: f.documentId, grantId: f.grantId },
    'boot-2',
    'claude-code',
    now
  );
  expect(reboot.admission.initializeBoot()).toBe(0);
  expect(db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual([moved]);
  const restoredRuntime = new FakeAgentRuntime('claude-code');
  restoredRuntime.getInternalSessionId.mockReturnValue(undefined);
  restoredRuntime.isSegmentPending.mockReturnValue(true);
  const document = barrier();
  restoredRuntime.withScenarios([
    async function* (): AsyncGenerator<StreamEvent> {
      await document.promise;
      yield { type: 'done', data: {} };
    },
  ]);
  const nextBoot = install(reboot, restoredRuntime);
  const recovery = runner(reboot, nextBoot.registry, now);
  recovery.service.start();
  await vi.advanceTimersByTimeAsync(61000);
  await recovery.flush();
  expect(restoredRuntime.sendMessage).not.toHaveBeenCalled();
  expect(db.select().from(sessionMessageAcceptanceReceipts).all()[0]!).toMatchObject({
    id: originalReceipt.id,
    state: 'accepted',
    dispatchAttemptId: null,
  });
  expect(recovery.nudges.flatMap((wake) => wake.ids)).toEqual([originalReceipt.id]);
  restoredRuntime.isSegmentPending.mockReturnValue(false);
  noteRuntimeTurnClosed('canonical');
  await vi.advanceTimersByTimeAsync(1000);
  expect(restoredRuntime.sendMessage).toHaveBeenCalledTimes(1);
  expect(db.select().from(sessionMessageAcceptanceReceipts).all()[0]!).toMatchObject({
    id: originalReceipt.id,
    state: 'turn_started',
    sourceId: batch.batchId,
    sourceGeneration: batch.generation,
  });
  expect(restoredRuntime.sendMessage.mock.calls[0]![0]).toBe('canonical');
  expect(restoredRuntime.sendMessage.mock.calls[0]![2]!.additionalContext).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'doc_events',
        data: expect.objectContaining({
          scope: TO,
          batchId: batch.batchId,
          events: [
            expect.objectContaining({ id: eventId, docSeq: input.docSeq, payload: input.payload }),
          ],
        }),
      }),
    ])
  );
  document.done();
  await vi.advanceTimersByTimeAsync(121000);
  expect(restoredRuntime.sendMessage).toHaveBeenCalledTimes(1);
  expect(db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual([
    expect.objectContaining({
      id: originalReceipt.id,
      state: 'settled',
      settleOutcome: 'completed',
      sourceGeneration: batch.generation,
    }),
  ]);
  expect(reboot.store.getBatch(batch.batchId)).toMatchObject({
    generation: batch.generation,
    admissionReceiptId: originalReceipt.id,
    status: 'turn_done',
  });
  expect(reboot.store.listDeliveries(f.documentId, eventId)[0]!.ackOutcome).toBeNull();
  expect(
    nextBoot.events.readAll('canonical').filter((event) => event.type === 'turn_start')
  ).toHaveLength(2);
  expect(originalRunner.errors).toEqual([]);
  expect(recovery.errors).toEqual([]);
});
