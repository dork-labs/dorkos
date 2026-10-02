/** Committed input → serialized runner → real gates → protected adoption → actual trigger, across file restart. */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createDb,
  sessionMessageAcceptanceReceipts,
  sessionMessageQueue,
  type Db,
} from '@dorkos/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { StreamEvent } from '@dorkos/shared/types';
import { batchFixture, NOW, FROM, TO, type BatchFixture } from './batch-fixtures.js';
import { DocChannelAuthorization } from '../authorization.js';
import { DocChannelService } from '../service.js';
import { DocChannelIngest } from '../ingest.js';
import { DocChannelDownstream } from '../downstream/service.js';
import { createDocDownstreamAuthority } from '../downstream/authority.js';
import { createServerPrincipal } from '../../../connectors/principal/server-principal.js';
import { DocBatchDeliveryPump } from '../delivery/pump.js';
import { DocDeliveryRunner } from '../delivery/runner.js';
import { createPrivateDocPumpGates } from '../delivery/private-gates.js';
import { RuntimeRegistry } from '../../../core/runtime-registry.js';
import {
  adoptAcceptedPrivateMessages,
  dispatchMessage,
  isTurnInFlight,
  noteRuntimeTurnClosed,
  resetMessageDispatcher,
} from '../../../session/message-dispatcher.js';
import { setPrivateSessionMessageAcceptanceService } from '../../../session/private-messages/acceptance.js';
import { setMessageQueueStore } from '../../../session/message-queue-store.js';
import { SessionEventStore } from '../../../session/session-event-store.js';
import {
  getOrCreateProjector,
  disposeProjector,
  rekeyProjector,
  setSessionEventStore,
} from '../../../session/session-state-projector.js';
import { onDurableSessionRekey } from '../../../session/turn-identity/durable-rekey.js';
const databases: Db[] = [];
const directories: string[] = [];
const runners: DocDeliveryRunner[] = [];
const detach: (() => void)[] = [];
const release: (() => void)[] = [];
afterEach(async () => {
  for (const stop of detach.splice(0)) stop();
  for (const runner of runners.splice(0)) await runner.stop();
  for (const done of release.splice(0)) done();
  await vi.advanceTimersByTimeAsync(1000);
  resetMessageDispatcher();
  setPrivateSessionMessageAcceptanceService(undefined);
  setMessageQueueStore(undefined);
  disposeProjector('session-1');
  disposeProjector('canonical');
  setSessionEventStore(undefined);
  vi.useRealTimers();
  for (const db of databases.splice(0)) if (db.$client.open) db.$client.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function barrier() {
  let done!: () => void;
  const promise = new Promise<void>((resolve) => {
    done = resolve;
  });
  release.push(done);
  return { promise, done };
}
function authorization(f: BatchFixture, principal = f.actor.principal) {
  return new DocChannelAuthorization(f.db, f.documents, {
    ownsInstallation: (claims) =>
      claims.owner.kind === 'local_install' && claims.owner.installationId === 'installation',
    principalCurrent: (proof) => proof === principal,
    revalidateRuntime: async (proof) => proof === principal,
    roomMembership: () => undefined,
  });
}
function install(f: BatchFixture, fake: FakeAgentRuntime) {
  const registry = new RuntimeRegistry();
  registry.setDb(f.db);
  registry.register(fake);
  setMessageQueueStore(f.queue);
  setPrivateSessionMessageAcceptanceService(f.admission.acceptance);
  const events = new SessionEventStore(f.db);
  setSessionEventStore(events);
  return { registry, events };
}
function runner(
  f: BatchFixture,
  registry: RuntimeRegistry,
  now: () => Date,
  beforeAdopt?: () => void
) {
  const nudges: { sessionId: string; ids: string[]; receipt: unknown; queue: unknown }[] = [];
  const errors: unknown[] = [];
  const pendingNudges: Promise<void>[] = [];
  const pump = new DocBatchDeliveryPump({
    db: f.db,
    store: f.store,
    grants: f.grants,
    admission: f.admission,
    now,
    ...createPrivateDocPumpGates({ grants: f.grants, runtimes: registry, now }),
    markWaitingWarning: (id, generation, at, tx) =>
      f.store.markWaitingWarning(id, generation, at, tx),
    nudge(sessionId, receiptIds) {
      expect(f.db.$client.inTransaction).toBe(false);
      nudges.push({
        sessionId,
        ids: [...receiptIds],
        receipt: f.db.select().from(sessionMessageAcceptanceReceipts).all(),
        queue: f.db.select().from(sessionMessageQueue).all(),
      });
      beforeAdopt?.();
      pendingNudges.push(
        Promise.all([
          registry.resolveForSession(sessionId),
          registry.getSessionAgentPath(sessionId),
        ])
          .then(([runtime, cwd]) => {
            if (!cwd) throw new Error('No canonical bound path');
            adoptAcceptedPrivateMessages({
              sessionId,
              cwd,
              runtime,
              projector: getOrCreateProjector(sessionId, cwd, { persist: 'history' }),
              privateReceiptSelection: {
                sourceKind: 'document_event_batch',
                receiptIds: [...receiptIds],
              },
            });
          })
          .catch((error: unknown) => {
            errors.push(error);
          })
      );
      return undefined;
    },
  });
  const service = new DocDeliveryRunner({
    pump,
    now,
    onError: (error) => {
      errors.push(error);
    },
  });
  runners.push(service);
  return { service, nudges, errors, flush: async () => Promise.all(pendingNudges) };
}
it('waits without admission while busy, rekeys and restarts, then dispatches one original generation and separately acknowledges it', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  const now = () => new Date();
  const directory = mkdtempSync(join(tmpdir(), 'doc-runner-delivery-'));
  directories.push(directory);
  const file = join(directory, 'state.db');
  const f = batchFixture(file, null, undefined, 'boot-1', 'claude-code', now);
  databases.push(f.db);
  const initial = new FakeAgentRuntime('claude-code');
  initial.getInternalSessionId.mockReturnValue(undefined);
  const firstTurn = barrier();
  initial.withScenarios([
    async function* (): AsyncGenerator<StreamEvent> {
      await firstTurn.promise;
      yield { type: 'done', data: {} };
    },
  ]);
  const boot = install(f, initial);
  const currentRuntime = boot.registry.get('claude-code');
  dispatchMessage({
    sessionId: 'session-1',
    clientId: 'person',
    content: 'Initial person turn',
    cwd: '/agents/one',
    runtime: currentRuntime,
    projector: getOrCreateProjector('session-1', '/agents/one', { persist: 'history' }),
  });
  await vi.advanceTimersByTimeAsync(1);
  expect(initial.sendMessage).toHaveBeenCalledTimes(1);
  expect(isTurnInFlight('session-1', currentRuntime)).toBe(true);
  const channel = new DocChannelService(f.documents, f.store, authorization(f), {
    ingest: new DocChannelIngest(f.store, now),
    grants: f.grants,
  });
  const beforeRunner = runner(f, boot.registry, now);
  detach.push(channel.onCommittedInput(() => beforeRunner.service.wake()));
  beforeRunner.service.start();
  const eventId = randomUUID();
  const recorded = await channel.ingestEvent(
    f.documentId,
    { v: 1, id: eventId, type: 'task.comment', payload: { text: 'PRIVATE-RUNNER-MARKER' } },
    f.actor
  );
  expect(recorded.receipt.status).toBe('recorded');
  const originalBatch = f.store.getBatch(f.batchId())!;
  const originalInput = f.store.getEvent(f.documentId, eventId)!;
  const originalGrant = f.store.getGrant(f.grantId)!;
  await vi.advanceTimersByTimeAsync(1200);
  expect(f.store.getBatch(originalBatch.batchId)).toMatchObject({
    status: 'waiting',
    errorCode: 'target_busy',
    generation: originalBatch.generation,
    inputEventIds: [eventId],
  });
  expect(f.db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual([]);
  expect(f.db.select().from(sessionMessageQueue).all()).toEqual([]);
  expect(beforeRunner.nudges).toEqual([]);
  expect(initial.sendMessage).toHaveBeenCalledTimes(1);
  const stopMove = onDurableSessionRekey((from, to) => {
    f.documents.rekeyScope(`session:${from}`, `session:${to}`);
  });
  detach.push(stopMove);
  rekeyProjector('session-1', 'canonical');
  expect(f.store.getBatch(originalBatch.batchId)).toMatchObject({
    scope: TO,
    generation: originalBatch.generation,
  });
  expect(f.store.getGrant(f.grantId)!.approvalEvidence).toEqual(originalGrant.approvalEvidence);
  await beforeRunner.service.stop();
  stopMove();
  firstTurn.done();
  await vi.advanceTimersByTimeAsync(1000);
  expect(beforeRunner.errors).toEqual([]);
  resetMessageDispatcher();
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
  // This is the real boot boundary, before the new runner or any protected adoption.
  expect(reboot.admission.initializeBoot()).toBe(0);
  expect(reboot.documents.lifecycle.resolveScope(FROM)).toBe(TO);
  const runtime = new FakeAgentRuntime('claude-code');
  runtime.getInternalSessionId.mockReturnValue(undefined);
  runtime.isSegmentPending.mockReturnValue(true);
  const docTurn = barrier();
  runtime.withScenarios([
    async function* (): AsyncGenerator<StreamEvent> {
      await docTurn.promise;
      yield { type: 'done', data: {} };
    },
  ]);
  const nextBoot = install(reboot, runtime);
  const afterRunner = runner(reboot, nextBoot.registry, now);
  afterRunner.service.start();
  await vi.advanceTimersByTimeAsync(61000);
  expect(runtime.sendMessage).not.toHaveBeenCalled();
  expect(reboot.store.getBatch(originalBatch.batchId)).toMatchObject({
    status: 'waiting',
    errorCode: 'pending_segment',
  });
  expect(db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual([]);
  runtime.isSegmentPending.mockReturnValue(false);
  afterRunner.service.wake();
  await vi.advanceTimersByTimeAsync(61000);
  await afterRunner.flush();
  expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
  const receipt = db.select().from(sessionMessageAcceptanceReceipts).all()[0]!;
  expect(receipt).toMatchObject({
    state: 'turn_started',
    sourceKind: 'document_event_batch',
    sourceId: originalBatch.batchId,
    sourceGeneration: originalBatch.generation,
    sessionId: 'canonical',
    originRuntime: 'claude-code',
    originAgentPath: '/agents/one',
  });
  expect(afterRunner.nudges).toHaveLength(1);
  expect(afterRunner.nudges[0]!.ids).toEqual([receipt.id]);
  expect(reboot.admission.acceptance.sender(receipt)).toBe(`relay.doc.${f.documentId}`);
  expect(afterRunner.nudges[0]!.queue).toEqual([
    expect.objectContaining({
      id: receipt.queueMessageId,
      sessionId: 'canonical',
      content: '[Document update: 1 action]',
      clientId: 'system:document_event_batch',
    }),
  ]);
  expect(JSON.stringify(afterRunner.nudges)).not.toContain('PRIVATE-RUNNER-MARKER');
  expect(runtime.sendMessage.mock.calls[0]).toEqual([
    'canonical',
    '[Document update: 1 action]',
    expect.objectContaining({
      cwd: '/agents/one',
      additionalContext: expect.arrayContaining([
        expect.objectContaining({
          kind: 'doc_events',
          data: expect.objectContaining({
            documentId: f.documentId,
            scope: TO,
            batchId: originalBatch.batchId,
            routeId: 'route',
            events: [
              expect.objectContaining({
                id: eventId,
                docSeq: originalInput.docSeq,
                payload: { text: 'PRIVATE-RUNNER-MARKER' },
              }),
            ],
          }),
        }),
      ]),
    }),
  ]);
  docTurn.done();
  await vi.advanceTimersByTimeAsync(1000);
  expect(db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual([
    expect.objectContaining({
      id: receipt.id,
      state: 'settled',
      settleOutcome: 'completed',
      sourceGeneration: originalBatch.generation,
    }),
  ]);
  expect(reboot.store.getBatch(originalBatch.batchId)).toMatchObject({
    status: 'turn_done',
    generation: originalBatch.generation,
    inputEventIds: [eventId],
    admissionReceiptId: receipt.id,
  });
  expect(reboot.store.getEvent(f.documentId, eventId)).toMatchObject({
    eventId,
    docSeq: originalInput.docSeq,
    envelopeHash: originalInput.envelopeHash,
    payload: originalInput.payload,
  });
  expect(reboot.store.listDeliveries(f.documentId, eventId)[0]!.ackOutcome).toBeNull();
  const turnStarts = nextBoot.events
    .readAll('canonical')
    .filter((event) => event.type === 'turn_start');
  expect(turnStarts).toHaveLength(2); // One initial person turn plus exactly one document turn.
  expect(receipt.turnStartSeq).toBe(turnStarts[1]!.seq);
  expect(reboot.store.getBatch(originalBatch.batchId)!.turnId).toBe(
    `projected:${receipt.id}:${receipt.turnStartSeq}`
  );
  const claims = reboot.actor.principal.claims;
  if (claims.kind !== 'runtime') throw new Error('Expected verified runtime fixture');
  const principal = createServerPrincipal({
    ...claims,
    kind: 'runtime',
    canonicalSessionId: 'canonical',
  });
  const actor = { surface: 'capability' as const, principal };
  const downstream = new DocChannelDownstream(
    reboot.store,
    createDocDownstreamAuthority(reboot.store, authorization(reboot, principal), reboot.grants, {
      principalCurrent: (proof) => proof === principal,
      ownsInstallation: (claims) =>
        claims.owner.kind === 'local_install' && claims.owner.installationId === 'installation',
      resolveScope: (scope) => reboot.documents.lifecycle.resolveScope(scope),
      revalidateRuntime: async (proof) => proof === principal,
    }),
    now
  );
  const ackId = randomUUID();
  await downstream.send(
    {
      documentId: f.documentId,
      eventId: ackId,
      type: 'app.ack',
      payload: {
        batchId: originalBatch.batchId,
        routeId: 'route',
        eventIds: [eventId],
        outcome: 'handled',
      },
    },
    actor
  );
  expect(reboot.store.listDeliveries(f.documentId, eventId)[0]!).toMatchObject({
    status: 'turn_done',
    ackOutcome: 'handled',
    ackEvidence: { generation: originalBatch.generation, grantId: f.grantId },
  });
  await vi.advanceTimersByTimeAsync(120000);
  expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
  expect(afterRunner.errors).toEqual([]);
  expect(db.select().from(sessionMessageAcceptanceReceipts).all()).toHaveLength(1);
});

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
