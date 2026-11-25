/** Committed input → serialized runner → real gates → protected adoption → actual trigger, across file restart. */
import {
  databases,
  directories,
  detach,
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
import { batchFixture, NOW, FROM, TO } from '../batch-fixtures.js';
import { DocChannelService } from '../../service.js';
import { DocChannelIngest } from '../../ingest.js';
import { DocChannelDownstream } from '../../downstream/service.js';
import { createDocDownstreamAuthority } from '../../downstream/authority.js';
import { createServerPrincipal } from '../../../../connectors/principal/server-principal.js';
import {
  dispatchMessage,
  isTurnInFlight,
  resetMessageDispatcher,
} from '../../../../session/message-dispatcher.js';
import {
  getOrCreateProjector,
  disposeProjector,
  rekeyProjector,
  setSessionEventStore,
} from '../../../../session/session-state-projector.js';
import { onDurableSessionRekey } from '../../../../session/turn-identity/durable-rekey.js';

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
    origin: { kind: 'interactive' },
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
  // Waiting rows: the running turn's own row is kept out of line (spec `turns-survive-restarts` §4.3).
  expect(
    f.db
      .select()
      .from(sessionMessageQueue)
      .all()
      .filter((row) => row.state === 'waiting')
  ).toEqual([]);
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
