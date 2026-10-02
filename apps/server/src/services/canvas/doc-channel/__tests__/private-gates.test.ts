/** Real migrated grant/SQL gates inspect capacity without acquiring slots or changing accepted work. */
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  canvasDocBatches,
  canvasDocGrants,
  sessionMessageAcceptanceReceipts,
  sessionMessageQueue,
  eq,
  type Db,
} from '@dorkos/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { batchFixture, NOW, type BatchFixture } from './batch-fixtures.js';
import { createPrivateDocPumpGates } from '../delivery/private-gates.js';
import { RuntimeRegistry } from '../../../core/runtime-registry.js';
import {
  noteRuntimeTurnOpen,
  resetMessageDispatcher,
} from '../../../session/message-dispatcher.js';
import {
  disposeProjector,
  getOrCreateProjector,
  peekProjector,
} from '../../../session/session-state-projector.js';
const databases: Db[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  resetMessageDispatcher();
  disposeProjector('session-1');
  disposeProjector('internal-1');
  for (const db of databases.splice(0)) db.$client.close();
});
function fixture(turnsPerHour = 10) {
  const f = batchFixture(
    ':memory:',
    null,
    undefined,
    'boot-1',
    'claude-code',
    () => new Date(NOW),
    undefined,
    { turnsPerHour }
  );
  databases.push(f.db);
  f.input();
  const batch = f.store.getBatch(f.batchId())!;
  const runtime = new FakeAgentRuntime('claude-code');
  runtime.getInternalSessionId.mockReturnValue(undefined);
  const registry = new RuntimeRegistry();
  registry.setDb(f.db);
  registry.register(runtime);
  const gates = createPrivateDocPumpGates({
    grants: f.grants,
    runtimes: registry,
    now: () => new Date(NOW),
  });
  const snapshot = () => ({
    channel: f.store.getChannel(f.documentId),
    grant: f.store.getGrant(f.grantId),
    batches: f.db.select().from(canvasDocBatches).all(),
    receipts: f.db.select().from(sessionMessageAcceptanceReceipts).all(),
    queue: f.db.select().from(sessionMessageQueue).all(),
    input: f.store.getEvent(f.documentId, batch.inputEventIds[0]!),
  });
  return { f, batch, runtime, registry, gates, snapshot };
}
it('allows current idle capacity without creating a projector, acquiring a slot or allocating a receipt', () => {
  const { f, batch, runtime, gates, snapshot } = fixture();
  const before = snapshot();
  expect(peekProjector('session-1')).toBeUndefined();
  f.store.transaction((tx) => {
    expect(gates.capacity(batch, tx)).toEqual({ available: true });
    expect(gates.budget(batch, tx)).toEqual({ available: true });
  });
  expect(peekProjector('session-1')).toBeUndefined();
  expect(snapshot()).toEqual(before);
  expect(runtime.acquireLock).not.toHaveBeenCalled();
  expect(runtime.sendMessage).not.toHaveBeenCalled();
});
it('waits for an unregistered bound runtime without inferring a different runtime or changing work', () => {
  const { f, batch, snapshot } = fixture();
  const before = snapshot();
  const gates = createPrivateDocPumpGates({
    grants: f.grants,
    runtimes: new RuntimeRegistry(),
    now: () => new Date(NOW),
  });
  expect(f.store.transaction((tx) => gates.capacity(batch, tx))).toEqual({
    available: false,
    reason: 'runtime_unavailable',
    nextEligibleAt: '2026-10-01T12:01:00.000Z',
  });
  expect(snapshot()).toEqual(before);
});
it.each(['dispatcher', 'canonical_lock', 'internal_lock'] as const)(
  'observes actual %s busy capacity without taking another slot',
  (kind) => {
    const { f, batch, runtime, gates, snapshot } = fixture();
    const before = snapshot();
    if (kind === 'dispatcher') noteRuntimeTurnOpen('session-1');
    else {
      runtime.getInternalSessionId.mockReturnValue('internal-1');
      runtime.isLocked.mockImplementation(
        (id) => id === (kind === 'canonical_lock' ? 'session-1' : 'internal-1')
      );
    }
    expect(f.store.transaction((tx) => gates.capacity(batch, tx))).toMatchObject({
      available: false,
      reason: 'target_busy',
    });
    expect(snapshot()).toEqual(before);
    expect(runtime.acquireLock).not.toHaveBeenCalled();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  }
);
it.each(['session-1', 'internal-1'])(
  'observes pending runtime segment under %s without acquiring capacity',
  (id) => {
    const { f, batch, runtime, gates, snapshot } = fixture();
    const before = snapshot();
    runtime.getInternalSessionId.mockReturnValue('internal-1');
    runtime.isSegmentPending.mockImplementation((session) => session === id);
    expect(f.store.transaction((tx) => gates.capacity(batch, tx))).toMatchObject({
      available: false,
      reason: 'pending_segment',
    });
    expect(snapshot()).toEqual(before);
    expect(runtime.acquireLock).not.toHaveBeenCalled();
  }
);
it('observes an actual unresolved projector approval without fabricating a running turn', () => {
  const { f, batch, runtime, gates, snapshot } = fixture();
  const before = snapshot();
  const projector = getOrCreateProjector('session-1', '/agents/one');
  const approval = {
    type: 'approval_required' as const,
    id: 'gate-approval',
    startedAt: Date.now(),
    remainingMs: 600000,
    toolName: 'Bash',
    input: '{}',
    hasSuggestions: false,
  };
  projector.ingest(approval);
  expect(projector.hasPendingInteractions()).toBe(true);
  expect(projector.peekInProgressTurn()).toBeNull();
  expect(f.store.transaction((tx) => gates.capacity(batch, tx))).toMatchObject({
    available: false,
    reason: 'pending_interaction',
  });
  expect(snapshot()).toEqual(before);
  expect(runtime.acquireLock).not.toHaveBeenCalled();
});
function history(f: BatchFixture, at: string, routeId = 'route', started = true) {
  const original = f.store.getBatch(f.batchId())!;
  const batchId = randomUUID();
  const receiptId = randomUUID();
  f.db
    .insert(sessionMessageAcceptanceReceipts)
    .values({
      id: receiptId,
      sourceKind: 'document_event_batch',
      sourceId: batchId,
      sourceGeneration: original.generation,
      queueMessageId: randomUUID(),
      sessionId: 'session-1',
      agentId: 'agent-1',
      originRuntime: 'claude-code',
      originAgentPath: '/agents/one',
      originAuthorityDigest: 'historical-proof',
      state: started ? 'settled' : 'accepted',
      acceptedAt: at,
      turnStartedAt: started ? at : null,
      settledAt: at,
      settleOutcome: 'completed',
    })
    .run();
  f.db
    .insert(canvasDocBatches)
    .values({
      ...original,
      batchId,
      routeId,
      status: started ? 'turn_done' : 'accepted',
      admissionReceiptId: receiptId,
    })
    .run();
}
it('uses the approved lower SQL route ceiling, excludes the strict hour boundary and unrelated route, and releases at the exact deadline', () => {
  const { f, batch, runtime, gates, snapshot } = fixture(3);
  const at = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();
  history(f, at(3600000));
  history(f, at(10), 'other-route');
  for (let i = 0; i < 20; i++) history(f, at(3600001 + i));
  history(f, at(3000));
  history(f, at(2000));
  expect(f.store.transaction((tx) => gates.budget(batch, tx))).toEqual({ available: true });
  history(f, at(1000));
  const before = snapshot();
  expect(f.store.transaction((tx) => gates.budget(batch, tx))).toEqual({
    available: false,
    reason: 'route_turn_ceiling',
    nextEligibleAt: new Date(Date.parse(NOW) + 3597000).toISOString(),
  });
  const released = createPrivateDocPumpGates({
    grants: f.grants,
    runtimes: { get: () => runtime },
    now: () => new Date(Date.parse(NOW) + 3597000),
  });
  expect(f.store.transaction((tx) => released.budget(batch, tx))).toEqual({ available: true });
  expect(snapshot()).toEqual(before);
  expect(runtime.acquireLock).not.toHaveBeenCalled();
});
it('bounds the platform route ceiling at ten actual started receipts and excludes accepted-unstarted work', () => {
  const { f, batch, gates, snapshot } = fixture();
  for (let i = 1; i <= 9; i++) history(f, new Date(Date.parse(NOW) - i * 1000).toISOString());
  history(f, new Date(Date.parse(NOW) - 500).toISOString(), 'route', false);
  expect(f.store.transaction((tx) => gates.budget(batch, tx))).toEqual({ available: true });
  history(f, new Date(Date.parse(NOW) - 10000).toISOString());
  const before = snapshot();
  expect(f.store.transaction((tx) => gates.budget(batch, tx))).toEqual({
    available: false,
    reason: 'route_turn_ceiling',
    nextEligibleAt: new Date(Date.parse(NOW) + 3590000).toISOString(),
  });
  expect(snapshot()).toEqual(before);
});
it('propagates actual revoked grant authority for both gates instead of pretending it is a capacity wait', () => {
  const { f, batch, gates, snapshot } = fixture();
  f.grants.revoke(f.documentId, f.grantId, f.actor);
  const before = snapshot();
  for (const gate of [gates.capacity, gates.budget])
    expect(() => f.store.transaction((tx) => gate(batch, tx))).toThrow('GRANT_REVOKED');
  expect(snapshot()).toEqual(before);
});
it('refuses a corrupted persisted ceiling through exact grant evidence before any scheduling decision', () => {
  const { f, batch, gates, snapshot } = fixture();
  f.db
    .update(canvasDocGrants)
    .set({ limits: { turnsPerHour: 11, envelopeBytes: 16384, eventsPerMinute: 60 } })
    .where(eq(canvasDocGrants.grantId, f.grantId))
    .run();
  const before = snapshot();
  expect(() => f.store.transaction((tx) => gates.budget(batch, tx))).toThrow(
    'GRANT_EVIDENCE_MISMATCH'
  );
  expect(snapshot()).toEqual(before);
});
