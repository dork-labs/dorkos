/**
 * A page's events, and every other private source, start their turns with a
 * run that names where the words are, and a restart keeps their `in_doubt`
 * rule (spec `turns-survive-restarts` §4.7, §6.5, T11; DOR-5218).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { canvasDocDeliveries, eq, sessionMessageAcceptanceReceipts, type Db } from '@dorkos/db';
import { installRunRecord, uninstallRunRecord, type RunStore } from '../../../runs/index.js';
import { turnFacts } from '../../../session/turn-port/facts.js';
import {
  PrivateSessionMessageAcceptanceService,
  type PrivateSessionMessageSourceAdapter,
} from '../../../session/private-messages/acceptance.js';
import { batchFixture, type BatchFixture } from './batch-fixtures.js';

const databases: Db[] = [];
afterEach(() => {
  uninstallRunRecord();
  for (const db of databases.splice(0)) db.$client.close();
});

/** A boot of the run record over the fixture's file. */
function bootRuns(db: Db, epoch: string): RunStore {
  return installRunRecord(db, { epoch, ownerHolds: () => true });
}

/** One accepted, claimed page batch, with the run its acceptance wrote. */
async function claimedBatch() {
  const f = batchFixture();
  databases.push(f.db);
  const runs = bootRuns(f.db, '01DOCB00T1000000000000000A');
  f.input();
  const batchId = f.batchId();
  const accepted = f.admission.admit(batchId);
  const prepared = await f.admission.acceptance.prepare(accepted.receipt.id);
  f.admission.acceptance.claim(accepted.receipt.id, prepared);
  const run = runs.findByQueueMessage(accepted.receipt.queueMessageId)!;
  // The dispatcher's launch begins (transition 4).
  expect(turnFacts()!.dispatcher.launchBegins(run.id)).toEqual({ kind: 'starting' });
  return { f, batchId, receipt: accepted.receipt, runId: run.id };
}

/** The server comes back: a new run-record boot, then the private boot pass. */
function restart(f: BatchFixture): RunStore {
  const runs = bootRuns(f.db, '01DOCB00T2000000000000000B');
  batchFixture(
    ':memory:',
    null,
    { db: f.db, documentId: f.documentId, grantId: f.grantId },
    'boot-2'
  );
  return runs;
}

/** What a restart must leave of a batch whose outcome nobody can know. */
function expectInDoubt(f: BatchFixture, batchId: string, receiptId: string): void {
  expect(f.store.getBatch(batchId)?.status).toBe('in_doubt');
  const deliveries = f.db
    .select()
    .from(canvasDocDeliveries)
    .where(eq(canvasDocDeliveries.batchId, batchId))
    .all();
  expect(deliveries.map((delivery) => delivery.status)).toEqual(['in_doubt']);
  const receipt = f.db
    .select()
    .from(sessionMessageAcceptanceReceipts)
    .where(eq(sessionMessageAcceptanceReceipts.id, receiptId))
    .get();
  expect(receipt?.state).toBe('outcome_unknown');
  // Nothing is left for the queue to start again.
  expect(f.admission.acceptance.listAccepted('session-1')).toEqual([]);
  expect(f.queue.get(receipt!.queueMessageId)).toBeUndefined();
}

describe('private sources start their turns with their source named', () => {
  it('a page’s run names its batch, and another source’s run names its receipt', () => {
    const f = batchFixture();
    databases.push(f.db);
    const runs = bootRuns(f.db, '01DOCB00T1000000000000000A');
    f.input();
    const batchId = f.batchId();
    const page = f.admission.admit(batchId);
    expect(runs.findByQueueMessage(page.receipt.queueMessageId)).toMatchObject({
      status: 'queued',
      origin: { kind: 'extension-message' },
      sourceRef: `doc-batch:${batchId}`,
    });

    const handoffEnded: PrivateSessionMessageSourceAdapter = {
      kind: 'room_handoff_terminal',
      consume: (_tx, ref) => ({
        sourceKind: 'room_handoff_terminal',
        sourceId: (ref as { handoffId: string }).handoffId,
        sourceGeneration: ref.sourceGeneration,
        sessionId: 'session-1',
        agentId: 'agent-1',
        originRuntime: 'claude-code',
        originAgentPath: '/agents/one',
        originAuthorityDigest: 'digest',
        queuePlaceholder: '[Hand-off ended]',
      }),
      prepare: () => Promise.reject(new Error('not dispatched here')),
      revalidate: () => undefined,
    };
    const acceptance = new PrivateSessionMessageAcceptanceService(
      f.db,
      f.queue,
      [handoffEnded],
      'boot-1'
    );
    const handoff = acceptance.accept({
      kind: 'room_handoff_terminal',
      handoffId: 'handoff-1',
      sourceGeneration: '1',
    });
    expect(runs.findByQueueMessage(handoff.receipt.queueMessageId)).toMatchObject({
      status: 'queued',
      origin: { kind: 'resume' },
      sourceRef: `private-receipt:${handoff.receipt.id}`,
    });
  });
});

describe('doc events keep in_doubt through the port', () => {
  it('a claimed batch a restart cut off before its turn started: cancelled, never replayed', async () => {
    const { f, batchId, receipt, runId } = await claimedBatch();
    const runs = restart(f);
    expectInDoubt(f, batchId, receipt.id);
    expect(runs.get(runId)).toMatchObject({
      status: 'cancelled',
      sourceRef: `doc-batch:${batchId}`,
      endingDetail: { cancelledBecause: 'outcome_unknown', outcomeUnknown: true },
    });
  });

  it('a batch whose runtime had read its events when the server died: ended, never carried on', async () => {
    const { f, batchId, receipt, runId } = await claimedBatch();
    const facts = turnFacts()!;
    facts.report({
      kind: 'started',
      runId,
      sessionId: 'session-1',
      openedBy: 'caller',
      runtime: 'claude-code',
      runtimeTurnRef: 1,
    });
    f.admission.acceptance.markTurnStarted(receipt.id, 1);
    // The runtime's first event: the run is `running` and its row is gone.
    facts.report({ kind: 'delivered', runId });
    f.queue.remove(receipt.queueMessageId);

    const runs = restart(f);
    expectInDoubt(f, batchId, receipt.id);
    expect(runs.get(runId)).toMatchObject({
      status: 'ended',
      ending: 'process_died',
      sourceRef: `doc-batch:${batchId}`,
      endingDetail: { outcomeUnknown: true },
    });
  });
});
