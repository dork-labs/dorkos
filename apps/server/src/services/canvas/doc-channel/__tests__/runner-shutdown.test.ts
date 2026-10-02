/** Host-lifetime suspension drains protected preparation without destroying durable accepted evidence. */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createDb,
  canvasDocChannels,
  sessionMessageAcceptanceReceipts,
  sessionMessageQueue,
  sessionStagedContext,
  eq,
  type Db,
} from '@dorkos/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { batchFixture, NOW, FROM, type BatchFixture } from './batch-fixtures.js';
import { DocBatchDeliveryPump } from '../delivery/pump.js';
import { DocDeliveryRunner } from '../delivery/runner.js';
import { createPrivateDocPumpGates } from '../delivery/private-gates.js';
import { DocChannelIngest } from '../ingest.js';
import { RuntimeRegistry } from '../../../core/runtime-registry.js';
import {
  adoptAcceptedPrivateMessages,
  suspendPrivateDispatches,
  noteRuntimeTurnOpen,
  noteRuntimeTurnClosed,
  resetMessageDispatcher,
} from '../../../session/message-dispatcher.js';
import { setPrivateSessionMessageAcceptanceService } from '../../../session/private-messages/acceptance.js';
import { setMessageQueueStore } from '../../../session/message-queue-store.js';
import {
  getOrCreateProjector,
  disposeProjector,
} from '../../../session/session-state-projector.js';
import {
  StagedContextStore,
  setStagedContextStore,
  holdStagedContext,
  resetStagedContextStore,
} from '../../../session/staged-context-store.js';
const dbs: Db[] = [];
const dirs: string[] = [];
const releases: (() => void)[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const stop of stops.splice(0)) await stop();
  await vi.advanceTimersByTimeAsync(1000);
  resetMessageDispatcher();
  disposeProjector('session-1');
  setPrivateSessionMessageAcceptanceService(undefined);
  setMessageQueueStore(undefined);
  setStagedContextStore(undefined);
  resetStagedContextStore();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const db of dbs.splice(0)) if (db.$client.open) db.$client.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function host(f: BatchFixture, runtime: FakeAgentRuntime) {
  const registry = new RuntimeRegistry();
  registry.setDb(f.db);
  registry.register(runtime);
  setMessageQueueStore(f.queue);
  setPrivateSessionMessageAcceptanceService(f.admission.acceptance);
  setStagedContextStore(new StagedContextStore(f.db));
  const lifetime = new AbortController();
  const errors: unknown[] = [];
  const pump = new DocBatchDeliveryPump({
    db: f.db,
    store: f.store,
    grants: f.grants,
    admission: f.admission,
    now: () => new Date(),
    ...createPrivateDocPumpGates({ grants: f.grants, runtimes: registry, now: () => new Date() }),
    markWaitingWarning: (id, generation, at, tx) =>
      f.store.markWaitingWarning(id, generation, at, tx),
    nudge: (sessionId, receiptIds) => {
      if (!runner.active) return undefined;
      void Promise.all([
        registry.resolveForSession(sessionId),
        registry.getSessionAgentPath(sessionId),
      ])
        .then(([runtime, cwd]) => {
          if (!runner.active || !cwd) return;
          adoptAcceptedPrivateMessages({
            sessionId,
            cwd,
            runtime,
            projector: getOrCreateProjector(sessionId, cwd),
            privateDispatchSignal: lifetime.signal,
            privateReceiptSelection: { sourceKind: 'document_event_batch', receiptIds },
          });
        })
        .catch((error: unknown) => errors.push(error));
      return undefined;
    },
  });
  const runner = new DocDeliveryRunner({
    pump,
    now: () => new Date(),
    onError: (error) => errors.push(error),
  });
  const stop = async () => {
    const draining = runner.stop();
    lifetime.abort();
    await suspendPrivateDispatches(lifetime.signal);
    await draining;
  };
  stops.push(stop);
  return { runner, stop, lifetime, errors, registry };
}
function runtime() {
  const fake = new FakeAgentRuntime('claude-code');
  fake.getInternalSessionId.mockReturnValue(undefined);
  fake.withScenarios([
    async function* () {
      yield { type: 'done' as const, data: {} };
    },
  ]);
  return fake;
}
function snapshot(f: BatchFixture, batchId: string) {
  return {
    receipts: f.db.select().from(sessionMessageAcceptanceReceipts).all(),
    queue: f.db.select().from(sessionMessageQueue).all(),
    staged: f.db.select().from(sessionStagedContext).all(),
    batch: f.store.getBatch(batchId),
    channel: f.store.getChannel(f.documentId),
  };
}
it('drains held adopted preparation before disposal, preserves accepted evidence and staged context, then a new boot dispatches once', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  const dir = mkdtempSync(join(tmpdir(), 'doc-host-stop-'));
  dirs.push(dir);
  const file = join(dir, 'state.db');
  const f = batchFixture(file, null, undefined, 'boot-1', 'claude-code', () => new Date());
  dbs.push(f.db);
  const fake = runtime();
  const first = host(f, fake);
  holdStagedContext('session-1', 'Keep staged shutdown context', 'staged-once');
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  let preparing = false;
  const original = f.admission.source.prepare.bind(f.admission.source);
  vi.spyOn(f.admission.source, 'prepare').mockImplementation(async (receipt) => {
    if (!preparing) {
      preparing = true;
      await held;
    }
    return original(receipt);
  });
  f.input();
  const batchId = f.batchId();
  first.runner.start();
  await vi.advanceTimersByTimeAsync(1200);
  expect(preparing).toBe(true);
  expect(fake.sendMessage).not.toHaveBeenCalled();
  const before = snapshot(f, batchId);
  expect(before.receipts).toHaveLength(1);
  expect(before.receipts[0]!).toMatchObject({ state: 'accepted', dispatchAttemptId: null });
  let stopped = false;
  const stopping = first.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(first.runner.active).toBe(false);
  expect(stopped).toBe(false);
  release();
  await stopping;
  expect(stopped).toBe(true);
  await vi.advanceTimersByTimeAsync(120000);
  expect(fake.sendMessage).not.toHaveBeenCalled();
  expect(snapshot(f, batchId)).toEqual(before);
  expect(first.errors).toEqual([]);
  resetMessageDispatcher();
  disposeProjector('session-1');
  setStagedContextStore(undefined);
  resetStagedContextStore();
  f.db.$client.close();
  const db = createDb(file);
  dbs.push(db);
  const reboot = batchFixture(
    file,
    null,
    { db, documentId: f.documentId, grantId: f.grantId },
    'boot-2',
    'claude-code',
    () => new Date()
  );
  expect(reboot.admission.initializeBoot()).toBe(0);
  const resumedRuntime = runtime();
  const resumed = host(reboot, resumedRuntime);
  expect(resumed.lifetime.signal.aborted).toBe(false);
  resumed.runner.start();
  await vi.advanceTimersByTimeAsync(1200);
  expect(resumedRuntime.sendMessage).toHaveBeenCalledTimes(1);
  const evidence = snapshot(reboot, batchId);
  expect(evidence.receipts).toEqual([
    expect.objectContaining({
      id: before.receipts[0]!.id,
      sourceId: batchId,
      sourceGeneration: before.batch!.generation,
      state: 'settled',
      settleOutcome: 'completed',
    }),
  ]);
  expect(evidence.batch).toMatchObject({
    generation: before.batch!.generation,
    admissionReceiptId: before.receipts[0]!.id,
    status: 'turn_done',
  });
  expect(evidence.queue).toEqual([]);
  expect(evidence.staged).toEqual([]);
  expect(
    JSON.stringify(resumedRuntime.sendMessage.mock.calls[0]![2]!.additionalContext).match(
      /Keep staged shutdown context/g
    )
  ).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(120000);
  expect(resumedRuntime.sendMessage).toHaveBeenCalledTimes(1);
  expect(resumed.errors).toEqual([]);
});
function otherReceipt(f: BatchFixture) {
  const doc = f.canvas.open(FROM, 'agent-1', {
    type: 'markdown',
    title: 'Unrelated lane',
    content: 'Other body',
  });
  f.db
    .update(canvasDocChannels)
    .set({ openerAgentId: 'agent-1' })
    .where(eq(canvasDocChannels.documentId, doc.id))
    .run();
  f.grants.configure(
    doc.id,
    {
      routes: [
        {
          id: 'route',
          on: 'task.*',
          to: 'agent:owner',
          turn: { mode: 'immediate', maxBatch: 100 },
        },
      ],
    },
    f.actor
  );
  f.grants.grant(
    { documentId: doc.id, routeId: 'route', expiresAt: '2026-10-02T00:00:00.000Z' },
    f.actor
  );
  const event = new DocChannelIngest(f.store, () => new Date()).accept(
    { v: 1, id: randomUUID(), type: 'task.changed', payload: { unrelated: true } },
    (tx) => ({
      documentId: doc.id,
      scope: FROM,
      documentLabel: doc.title,
      provenance: {},
      routes: f.grants.getCurrentRoutes(doc.id, 'task.changed', f.actor, tx),
    })
  );
  return f.admission.admit(event.deliveries[0]!.batchId!).receipt;
}
it('drops only the aborted host pending timer with no database work while an unrelated private lane remains dispatchable', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  const dir = mkdtempSync(join(tmpdir(), 'doc-host-queued-'));
  dirs.push(dir);
  const f = batchFixture(
    join(dir, 'state.db'),
    null,
    undefined,
    'boot-1',
    'claude-code',
    () => new Date()
  );
  dbs.push(f.db);
  const fake = runtime();
  const owned = host(f, fake);
  f.input();
  const ours = f.admission.admit(f.batchId()).receipt;
  const unrelated = otherReceipt(f);
  noteRuntimeTurnOpen('session-1');
  const opts = {
    sessionId: 'session-1',
    cwd: '/agents/one',
    runtime: owned.registry.get('claude-code'),
    projector: getOrCreateProjector('session-1', '/agents/one'),
  };
  expect(
    adoptAcceptedPrivateMessages({
      ...opts,
      privateDispatchSignal: owned.lifetime.signal,
      privateReceiptSelection: { sourceKind: 'document_event_batch', receiptIds: [ours.id] },
    })
  ).toBe(1);
  expect(
    adoptAcceptedPrivateMessages({
      ...opts,
      privateReceiptSelection: { sourceKind: 'document_event_batch', receiptIds: [unrelated.id] },
    })
  ).toBe(1);
  const before = snapshot(f, ours.sourceId);
  const timers = vi.getTimerCount();
  expect(timers).toBeGreaterThanOrEqual(2);
  const sql = vi.spyOn(f.db.$client, 'prepare');
  owned.lifetime.abort();
  await suspendPrivateDispatches(owned.lifetime.signal);
  expect(vi.getTimerCount()).toBe(timers - 1);
  expect(sql).not.toHaveBeenCalled();
  const after = snapshot(f, ours.sourceId);
  expect(after).toEqual(before);
  sql.mockClear();
  // Advancing short of the unrelated lane deadline cannot revive the stopped host timer.
  await vi.advanceTimersByTimeAsync(1000);
  expect(sql).not.toHaveBeenCalled();
  expect(fake.sendMessage).not.toHaveBeenCalled();
  noteRuntimeTurnClosed('session-1');
  await vi.advanceTimersByTimeAsync(1000);
  expect(fake.sendMessage).toHaveBeenCalledTimes(1);
  expect(f.db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: ours.id, state: 'accepted', dispatchAttemptId: null }),
      expect.objectContaining({ id: unrelated.id, state: 'settled', settleOutcome: 'completed' }),
    ])
  );
  expect(f.queue.get(ours.queueMessageId)).toBeDefined();
  expect(f.queue.get(unrelated.queueMessageId)).toBeUndefined();
});
