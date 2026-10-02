import { afterEach, describe, expect, it } from 'vitest';
import {
  canvasDocBatches,
  canvasDocGrants,
  eq,
  sessionMessageAcceptanceReceipts,
  type Db,
} from '@dorkos/db';
import { batchFixture, NOW } from './batch-fixtures.js';
import { DOCUMENT_BUDGET_WAIT, type DocBeforeClaim } from '../delivery/final-budget.js';
const databases: Db[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.$client.close();
});
function fixture(gate?: DocBeforeClaim, limits?: { turnsPerHour: number }) {
  let clock = new Date(NOW);
  const f = batchFixture(
    ':memory:',
    null,
    undefined,
    'boot-1',
    'claude-code',
    () => clock,
    gate,
    limits
  );
  databases.push(f.db);
  f.input();
  return {
    ...f,
    advance: (at: string) => {
      clock = new Date(at);
    },
  };
}
const deadline = new Date(Date.parse(NOW) + 60_000).toISOString();
describe('fresh final document turn budget', () => {
  it('holds the original accepted identity without an attempt, then clears the wait on admission', async () => {
    let available = false;
    const f = fixture(() =>
      available
        ? { decision: 'admit' }
        : { decision: 'defer', reason: 'capacity', nextEligibleAt: deadline }
    );
    const accepted = f.admission.admit(f.batchId());
    const prepared = await f.admission.acceptance.prepare(accepted.receipt.id);
    expect(f.admission.acceptance.claim(accepted.receipt.id, prepared)).toEqual({
      deferred: true,
      receiptId: accepted.receipt.id,
      reason: 'capacity',
      nextEligibleAt: deadline,
    });
    expect(f.admission.acceptance.dispatchNotBefore(accepted.receipt.id)).toBe(deadline);
    const receipt = f.db.select().from(sessionMessageAcceptanceReceipts).get()!;
    expect(receipt.state).toBe('accepted');
    expect(receipt.dispatchAttemptId).toBeNull();
    expect(f.queue.get(receipt.queueMessageId)).toBeDefined();
    expect(f.store.getBatch(receipt.sourceId)).toMatchObject({
      status: 'accepted',
      generation: receipt.sourceGeneration,
      errorCode: DOCUMENT_BUDGET_WAIT,
      leaseUntil: deadline,
    });
    expect(
      f.store.listDeliveries(f.documentId, f.store.getBatch(receipt.sourceId)!.inputEventIds[0]!)[0]
        ?.status
    ).toBe('waiting');
    available = true;
    f.advance(deadline);
    const claimed = f.admission.acceptance.claim(receipt.id, prepared);
    expect(claimed.dispatchAttemptId).toEqual(expect.any(String));
    expect(f.store.getBatch(receipt.sourceId)).toMatchObject({
      status: 'dispatching',
      errorCode: null,
      leaseUntil: null,
    });
    expect(f.db.select().from(sessionMessageAcceptanceReceipts).all()).toHaveLength(1);
  });
  it('ignores a scheduler resume lease as dispatch authority', () => {
    const f = fixture();
    const accepted = f.admission.admit(f.batchId());
    f.db
      .update(canvasDocBatches)
      .set({ errorCode: 'document_resume_retry', leaseUntil: deadline })
      .run();
    expect(f.admission.acceptance.dispatchNotBefore(accepted.receipt.id)).toBeUndefined();
  });
  it('revalidates authority after a synchronous budget callback and rolls back its mutations', async () => {
    const f = fixture((_context, tx) => {
      tx.update(canvasDocGrants).set({ revokedAt: NOW }).run();
      return { decision: 'admit' };
    });
    const accepted = f.admission.admit(f.batchId());
    const prepared = await f.admission.acceptance.prepare(accepted.receipt.id);
    expect(() => f.admission.acceptance.claim(accepted.receipt.id, prepared)).toThrow();
    expect(
      f.db.select().from(canvasDocGrants).where(eq(canvasDocGrants.grantId, f.grantId)).get()
        ?.revokedAt
    ).toBeNull();
    expect(f.store.getBatch(accepted.receipt.sourceId)?.status).toBe('accepted');
  });
  it('rolls back a budget callback that changes the persisted receipt binding', async () => {
    const f = fixture((_context, tx) => {
      tx.update(sessionMessageAcceptanceReceipts).set({ sessionId: 'attacker' }).run();
      return { decision: 'admit' };
    });
    const accepted = f.admission.admit(f.batchId());
    const prepared = await f.admission.acceptance.prepare(accepted.receipt.id);
    expect(() => f.admission.acceptance.claim(accepted.receipt.id, prepared)).toThrow(
      'changed before dispatch'
    );
    expect(f.db.select().from(sessionMessageAcceptanceReceipts).get()).toMatchObject({
      state: 'accepted',
      sessionId: accepted.receipt.sessionId,
    });
    expect(f.store.getBatch(accepted.receipt.sourceId)?.status).toBe('accepted');
  });
  it('refuses invalid deferral and async ports without claiming or retaining writes', async () => {
    for (const gate of [
      () => ({ decision: 'defer', reason: 'capacity', nextEligibleAt: NOW }),
      async () => ({ decision: 'admit' }),
    ]) {
      const f = fixture(gate as DocBeforeClaim);
      const accepted = f.admission.admit(f.batchId());
      const prepared = await f.admission.acceptance.prepare(accepted.receipt.id);
      expect(() => f.admission.acceptance.claim(accepted.receipt.id, prepared)).toThrow();
      expect(f.store.getBatch(accepted.receipt.sourceId)).toMatchObject({
        status: 'accepted',
        leaseUntil: null,
      });
      expect(
        f.db.select().from(sessionMessageAcceptanceReceipts).get()?.dispatchAttemptId
      ).toBeNull();
    }
  });
  it('uses fresh observed starts after preparation and admits at the exact rolling-hour boundary', async () => {
    const f = fixture(undefined, { turnsPerHour: 1 });
    const first = f.admission.admit(f.batchId());
    const ready = await f.admission.acceptance.prepare(first.receipt.id);
    f.admission.acceptance.claim(first.receipt.id, ready);
    f.admission.acceptance.markTurnStarted(first.receipt.id, 1);
    f.admission.acceptance.settle(first.receipt.id, 'ok');
    f.input();
    const second = f.admission.admit(f.batchId());
    const prepared = await f.admission.acceptance.prepare(second.receipt.id);
    const boundary = new Date(Date.parse(NOW) + 3600_000).toISOString();
    expect(f.admission.acceptance.claim(second.receipt.id, prepared)).toMatchObject({
      deferred: true,
      nextEligibleAt: boundary,
    });
    f.advance(boundary);
    expect(f.admission.acceptance.claim(second.receipt.id, prepared).dispatchAttemptId).toEqual(
      expect.any(String)
    );
  });
});
