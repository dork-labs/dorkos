/** Original protected gates and durable SQLite pump; no replacement transport/readiness callbacks. */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { sessionMessageAcceptanceReceipts, sessionMessageQueue } from '@dorkos/db';
import { RuntimeRegistry } from '../../../core/runtime-registry.js';
import { createPrivateDocPumpGates } from '../delivery/private-gates.js';
import { DocBatchDeliveryPump } from '../delivery/pump.js';
import { nativeRelayFixture, NOW } from './relay-native-fixture.js';
const opened: ReturnType<typeof nativeRelayFixture>[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const f of opened.splice(0)) {
    f.native.requireClosed();
    f.db.$client.close();
  }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup(other: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'doc-cross-target-wait-'));
  directories.push(directory);
  let time = Date.parse(NOW);
  const now = () => new Date(time);
  const f = nativeRelayFixture(join(directory, 'db.sqlite'), null, 'wait-boot', 'claude-code', {
    clock: now,
    ...(other ? { targetAgentPath: '/agents/two' } : {}),
  });
  opened.push(f);
  const runtime = new FakeAgentRuntime('claude-code');
  runtime.getInternalSessionId.mockReturnValue(undefined);
  const runtimes = new RuntimeRegistry();
  runtimes.setDb(f.db);
  runtimes.register(runtime);
  const gates = createPrivateDocPumpGates({ grants: f.grants, runtimes, now });
  const nudge = vi.fn(() => undefined);
  const pump = new DocBatchDeliveryPump({
    db: f.db,
    store: f.store,
    grants: f.grants,
    admission: f.admission,
    now,
    ...gates,
    nudge,
    markWaitingWarning: () => false,
  });
  return {
    f,
    runtime,
    nudge,
    pump,
    gates,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
it('an approved other-agent route waits relay_disabled durably without slot, receipt or queue allocation', () => {
  const h = setup(true);
  h.f.input();
  const id = h.f.batchId();
  const original = h.f.store.getBatch(id)!;
  expect(h.f.store.getGrant(h.f.grantId)?.approvalId).not.toBeNull();
  h.advance(1001);
  expect(h.pump.run()).toMatchObject({ admitted: 0, waiting: 1 });
  expect(h.f.store.getBatch(id)).toMatchObject({
    scope: 'session:session-1',
    generation: original.generation,
    status: 'waiting',
    errorCode: 'relay_disabled',
    admissionReceiptId: null,
  });
  expect(h.f.db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual([]);
  expect(h.f.db.select().from(sessionMessageQueue).all()).toEqual([]);
  expect(h.runtime.acquireLock).not.toHaveBeenCalled();
  expect(h.runtime.sendMessage).not.toHaveBeenCalled();
  expect(h.nudge).not.toHaveBeenCalled();
  h.advance(2 * 60 * 60_000);
  expect(h.pump.run()).toMatchObject({ admitted: 0, waiting: 1 });
  expect(h.f.store.getBatch(id)).toMatchObject({
    generation: original.generation,
    status: 'waiting',
    admissionReceiptId: null,
  });
  expect(h.f.db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual([]);
});
it('the original owning-session route remains admissible while Relay is absent', () => {
  const h = setup(false);
  h.f.input();
  h.advance(1001);
  expect(h.pump.run()).toMatchObject({ admitted: 1, waiting: 0 });
  const receipt = h.f.db.select().from(sessionMessageAcceptanceReceipts).all();
  expect(receipt).toHaveLength(1);
  expect(receipt[0]).toMatchObject({
    sessionId: 'session-1',
    agentId: 'agent-1',
    state: 'accepted',
  });
  expect(h.nudge).toHaveBeenCalledExactlyOnceWith('session-1', [receipt[0]!.id]);
  expect(h.runtime.acquireLock).not.toHaveBeenCalled();
  expect(h.runtime.sendMessage).not.toHaveBeenCalled();
});

it('a genuine approved log route records its input without Relay, receipt, queue or runtime acquisition', () => {
  const directory = mkdtempSync(join(tmpdir(), 'doc-cross-target-log-'));
  directories.push(directory);
  const f = nativeRelayFixture(join(directory, 'db.sqlite'), null, 'log-boot', 'claude-code', {
    destination: 'log',
  });
  opened.push(f);
  const accepted = f.input({ checked: true });
  expect(accepted.deliveries).toHaveLength(1);
  expect(accepted.deliveries[0]).toMatchObject({
    status: 'routed',
    reason: 'no_turn',
    batchId: null,
  });
  expect(f.db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual([]);
  expect(f.db.select().from(sessionMessageQueue).all()).toEqual([]);
});

it('an unclaimed disabled cross-target generation expires without allocating a receipt or dispatching on later pump passes', () => {
  const h = setup(true);
  h.f.input();
  const id = h.f.batchId();
  const original = h.f.store.getBatch(id)!;
  h.advance(24 * 60 * 60_000 + 1);
  expect(h.pump.run()).toMatchObject({ expired: 1, admitted: 0 });
  expect(h.f.store.getBatch(id)).toMatchObject({
    generation: original.generation,
    status: 'expired',
    errorCode: 'manual_replay_required',
    admissionReceiptId: null,
  });
  expect(h.pump.run().admitted).toBe(0);
  expect(h.f.db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual([]);
  expect(h.f.db.select().from(sessionMessageQueue).all()).toEqual([]);
  expect(h.runtime.acquireLock).not.toHaveBeenCalled();
  expect(h.nudge).not.toHaveBeenCalled();
});
