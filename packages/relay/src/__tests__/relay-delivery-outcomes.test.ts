/** Real Core/SQLite observations; only the adapter effect and explicit fault boundaries are controlled. */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { RelayCore } from '../relay-core.js';
import {
  noopLogger,
  type AdapterRegistryLike,
  type DeliveryResult,
  type RelayOptions,
} from '../types.js';
import type { DeliveryReceiptStore } from '../delivery-receipt-store.js';
import type { DeadLetterQueue } from '../dead-letter-queue.js';
import type { AdapterDelivery } from '../adapter-delivery.js';

const SUBJECT = 'relay.agent.example';
const LOCAL = { loginEnabled: false } as const;
const cores: RelayCore[] = [];
const dbs: Db[] = [];
const dirs: string[] = [];
const pendingBookkeeping: Promise<void>[] = [];
function db(): Db {
  const value = createDb(':memory:');
  runMigrations(value);
  dbs.push(value);
  return value;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(
  database = db(),
  delivery = deferred<DeliveryResult | null>(),
  turnCeiling?: RelayOptions['turnCeiling'],
  receiptNow?: () => number
) {
  const dir = mkdtempSync(join(tmpdir(), 'receipt-outcome-'));
  dirs.push(dir);
  const registry = {
    deliver: vi.fn(() => delivery.promise),
    setRelay() {},
    shutdown: async () => {},
  } satisfies AdapterRegistryLike;
  const core = new RelayCore({
    db: database,
    dataDir: dir,
    adapterRegistry: registry,
    logger: noopLogger,
    turnCeiling,
    receiptNow,
  });
  cores.push(core);
  const internals = core as unknown as {
    publishPipeline: {
      deps: {
        receiptStore: DeliveryReceiptStore;
        deadLetterQueue: DeadLetterQueue;
        adapterDelivery: AdapterDelivery;
      };
    };
  };
  // Observe completion without changing the real handler, to await all DLQ/notice bookkeeping.
  const adapter = internals.publishPipeline.deps.adapterDelivery as unknown as {
    finishDetached: (...args: unknown[]) => Promise<void>;
    finishDetachedRejection: (...args: unknown[]) => Promise<void>;
  };
  for (const method of ['finishDetached', 'finishDetachedRejection'] as const) {
    const original = adapter[method].bind(adapter);
    vi.spyOn(adapter, method).mockImplementation((...args) => {
      const result = original(...args);
      pendingBookkeeping.push(result);
      return result;
    });
  }
  const refundDeps = internals.publishPipeline.deps.adapterDelivery as unknown as {
    deps: { refundTurn: (subject: string) => void };
  };
  const refund = vi.spyOn(refundDeps.deps, 'refundTurn');
  return {
    core,
    registry,
    database,
    delivery,
    store: internals.publishPipeline.deps.receiptStore,
    dlq: internals.publishPipeline.deps.deadLetterQueue,
    refund,
  };
}
function options(callback: (id: string) => void = () => {}) {
  return {
    from: 'local-client',
    receiptContext: { ownerUserId: null, onReceiptCreated: callback },
  };
}
/** Promise reaction ordering, rather than time, makes the receipt CAS visible before later awaits. */
async function settleReaction(): Promise<void> {
  await Promise.resolve();
  await Promise.all(pendingBookkeeping.splice(0));
}
afterEach(async () => {
  await Promise.all(pendingBookkeeping.splice(0));
  for (const database of dbs) if (database.$client.inTransaction) database.$client.exec('ROLLBACK');
  for (const core of cores.splice(0)) await core.close();
  vi.restoreAllMocks();
  for (const database of dbs.splice(0)) database.$client.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it.each([
  [{ success: true }, 'delivered', undefined],
  [
    { success: false, code: 'at_capacity', error: 'private arbitrary detail' },
    'failed',
    'at_capacity',
  ],
  [{ success: false, code: 'chat_unavailable' }, 'failed', 'chat_unavailable'],
  [{ success: false, code: 'rate_limited' }, 'failed', 'rate_limited'],
  [{ success: false, error: 'at capacity secret prose' }, 'failed', 'adapter_failed'],
  [
    { success: false, code: 'private_invalid' } as unknown as DeliveryResult,
    'failed',
    'adapter_failed',
  ],
  [null, 'failed', 'adapter_unavailable'],
  [{ success: true, skipped: true }, 'failed', 'not_dispatched'],
] as const)('records actual detached outcome %j as %s/%s', async (result, state, code) => {
  const value = setup();
  const accepted = await value.core.publish(SUBJECT, 'payload', options());
  expect(accepted.receipt?.state).toBe('accepted');
  value.delivery.resolve(result);
  await settleReaction();
  const receipt = value.core.getDeliveryReceipt(accepted.messageId, LOCAL);
  expect(receipt?.state).toBe(state);
  expect(receipt?.failure?.code).toBe(code);
  expect(receipt?.settledAt).toBeTypeOf('string');
  expect(JSON.stringify(receipt)).not.toContain('secret');
  expect(JSON.stringify(receipt)).not.toContain('private arbitrary');
  expect(value.registry.deliver).toHaveBeenCalledTimes(1);
});

it('records rejected promise as unknown while preserving existing failure bookkeeping', async () => {
  const value = setup();
  const accepted = await value.core.publish(SUBJECT, 'payload', options());
  value.delivery.reject(new Error('private adapter detail'));
  await settleReaction();
  expect(value.core.getDeliveryReceipt(accepted.messageId, LOCAL)).toMatchObject({
    state: 'outcome_unknown',
    failure: { code: 'observation_lost' },
  });
  expect((await value.core.getDeadLetters()).map((row) => row.messageId)).toContain(
    accepted.messageId
  );
});

it('preserves the synchronous publisher rejection and exact locator with an unknown receipt', async () => {
  const value = setup();
  value.registry.deliver.mockImplementation(() => {
    throw new Error('sync effect failure');
  });
  let id = '';
  await expect(
    value.core.publish(
      SUBJECT,
      'payload',
      options((messageId) => {
        id = messageId;
      })
    )
  ).rejects.toThrow('sync effect failure');
  expect(value.core.getDeliveryReceipt(id, LOCAL)).toMatchObject({
    messageId: id,
    state: 'outcome_unknown',
    failure: { code: 'observation_lost' },
  });
  expect(value.registry.deliver).toHaveBeenCalledTimes(1);
});

it.each(['same-handle', 'two-handles'] as const)(
  'first Core deferred success settles delivered while %s sibling stays blocked',
  async (mode) => {
    let database: Db;
    let other: Db;
    if (mode === 'same-handle') {
      database = db();
      other = database;
    } else {
      const dir = mkdtempSync(join(tmpdir(), 'receipt-outcome-handles-'));
      dirs.push(dir);
      const file = join(dir, 'db.sqlite');
      database = createDb(file);
      runMigrations(database);
      other = createDb(file);
      dbs.push(database, other);
    }
    const first = setup(database);
    const second = setup(other);
    const accepted = await first.core.publish(SUBJECT, 'x', options());
    await expect(second.core.publish(SUBJECT, 'y', options())).rejects.toMatchObject({
      code: 'RELAY_RECEIPT_OBSERVER_BUSY',
    });
    expect(first.core.getDeliveryReceipt(accepted.messageId, LOCAL)?.state).toBe('accepted');
    first.delivery.resolve({ success: true });
    await settleReaction();
    expect(first.core.getDeliveryReceipt(accepted.messageId, LOCAL)?.state).toBe('delivered');
    expect(second.registry.deliver).not.toHaveBeenCalled();
    expect(first.registry.deliver).toHaveBeenCalledTimes(1);
  }
);

it('returns the fresh terminal snapshot when the actual registry promise resolves immediately', async () => {
  const value = setup();
  value.registry.deliver.mockResolvedValue({ success: false, code: 'at_capacity' });
  const result = await value.core.publish(SUBJECT, 'x', options());
  await settleReaction();
  expect(result.receipt).toMatchObject({
    messageId: result.messageId,
    state: 'failed',
    failure: { code: 'at_capacity' },
  });
  expect(result.receipt).toEqual(value.core.getDeliveryReceipt(result.messageId, LOCAL));
});

it.each(['receipt', 'audit'] as const)(
  'known success with %s storage failure produces zero failure DLQ/notices/refunds',
  async (fault) => {
    const value = setup(db(), deferred<DeliveryResult | null>(), {
      global: () => 1,
      perAgent: () => 1,
    });
    const notices = vi.fn(async () => {});
    const adapter = (
      value.core as unknown as { publishPipeline: { deps: { adapterDelivery: AdapterDelivery } } }
    ).publishPipeline.deps.adapterDelivery;
    adapter.setReplyFailureNotifier(notices);
    const chatNotices = vi.fn(async () => false);
    adapter.setChatFailureNotifier(chatNotices);
    const reject = vi.spyOn(value.dlq, 'reject');
    const accepted = await value.core.publish(SUBJECT, 'x', {
      ...options(),
      replyTo: 'relay.inbox.reply',
    });
    if (fault === 'receipt')
      value.database.$client
        .exec(`CREATE TRIGGER fail_terminal BEFORE UPDATE ON relay_delivery_receipts
    WHEN NEW.state='delivered' BEGIN SELECT RAISE(ABORT,'receipt sentinel'); END`);
    else
      value.database.$client.exec(`CREATE TRIGGER fail_audit BEFORE INSERT ON relay_index
    WHEN NEW.endpoint_hash LIKE 'adapter:%' BEGIN SELECT RAISE(ABORT,'audit sentinel'); END`);
    value.delivery.resolve({ success: true });
    await settleReaction();
    expect(value.core.getDeliveryReceipt(accepted.messageId, LOCAL)?.state).toBe(
      fault === 'receipt' ? 'outcome_unknown' : 'delivered'
    );
    expect(reject).not.toHaveBeenCalled();
    expect(notices).not.toHaveBeenCalled();
    expect(chatNotices).not.toHaveBeenCalled();
    expect(value.refund).not.toHaveBeenCalled();
    // The second real dispatch crosses the same one-turn ceiling: a fake refund would let it run.
    const refused = await value.core.publish(SUBJECT, 'second', options());
    expect(refused.receipt).toMatchObject({ state: 'failed', failure: { code: 'turn_ceiling' } });
    expect(value.registry.deliver).toHaveBeenCalledTimes(1);
  }
);

it('attempts exactly one unknown CAS after terminal storage failure and keeps accepted if both writes fail', async () => {
  const value = setup();
  const accepted = await value.core.publish(SUBJECT, 'x', options());
  value.database.$client
    .exec(`CREATE TRIGGER fail_all_terminal BEFORE UPDATE ON relay_delivery_receipts
    BEGIN SELECT RAISE(ABORT,'persistent storage sentinel'); END`);
  const writes = vi.spyOn(value.store, 'settle');
  value.delivery.resolve({ success: true });
  await settleReaction();
  expect(writes.mock.calls).toEqual([
    [accepted.messageId, { state: 'delivered' }],
    [accepted.messageId, { state: 'outcome_unknown' }],
  ]);
  expect(value.core.getDeliveryReceipt(accepted.messageId, LOCAL)?.state).toBe('accepted');
  value.database.$client.exec('DROP TRIGGER fail_all_terminal');
  await value.core.close();
  const next = setup(value.database);
  expect(next.core.getDeliveryReceipt(accepted.messageId, LOCAL)?.state).toBe('outcome_unknown');
  expect(next.registry.deliver).not.toHaveBeenCalled();
});

it('reports real storage unavailability distinctly from not-found without fabricating a state', async () => {
  const value = setup();
  const accepted = await value.core.publish(SUBJECT, 'x', options());
  value.database.$client.exec(
    'ALTER TABLE relay_delivery_receipts RENAME TO temporarily_unavailable_receipts'
  );
  expect(() => value.core.getDeliveryReceipt(accepted.messageId, LOCAL)).toThrow(
    expect.objectContaining({ code: 'RELAY_RECEIPT_STORAGE_UNAVAILABLE' })
  );
  value.delivery.resolve({ success: true });
  await settleReaction();
  value.database.$client.exec(
    'ALTER TABLE temporarily_unavailable_receipts RENAME TO relay_delivery_receipts'
  );
  expect(value.core.getDeliveryReceipt(accepted.messageId, LOCAL)?.state).toBe('accepted');
  await value.core.close();
  const successor = setup(value.database);
  expect(successor.core.getDeliveryReceipt(accepted.messageId, LOCAL)?.state).toBe(
    'outcome_unknown'
  );
  expect(successor.registry.deliver).not.toHaveBeenCalled();
});

it('rejects settlement during a later caller transaction without committing or rolling it back', async () => {
  const value = setup();
  const accepted = await value.core.publish(SUBJECT, 'x', options());
  value.database.$client.exec('BEGIN');
  value.delivery.resolve({ success: true });
  await settleReaction();
  expect(value.database.$client.inTransaction).toBe(true);
  expect(() => value.core.getDeliveryReceipt(accepted.messageId, LOCAL)).toThrow(
    expect.objectContaining({ code: 'RELAY_RECEIPT_TRANSACTION_ACTIVE' })
  );
  value.database.$client.exec('ROLLBACK');
  expect(value.core.getDeliveryReceipt(accepted.messageId, LOCAL)?.state).toBe('accepted');
  await value.core.close();
  const next = setup(value.database);
  expect(next.core.getDeliveryReceipt(accepted.messageId, LOCAL)?.state).toBe('outcome_unknown');
  expect(next.registry.deliver).not.toHaveBeenCalled();
});

it.each(['returns-false', 'throws'] as const)(
  'persists at_capacity before DLQ %s without losing its code',
  async (mode) => {
    const value = setup();
    const accepted = await value.core.publish(SUBJECT, 'x', options());
    const reject = vi.spyOn(value.dlq, 'reject').mockImplementation(async () => {
      expect(value.core.getDeliveryReceipt(accepted.messageId, LOCAL)).toMatchObject({
        state: 'failed',
        failure: { code: 'at_capacity' },
      });
      if (mode === 'throws') throw new Error('DLQ sentinel');
      return { ok: false, error: 'DLQ sentinel' };
    });
    value.delivery.resolve({ success: false, code: 'at_capacity' });
    await settleReaction();
    expect(reject).toHaveBeenCalledTimes(1);
    expect(value.refund).toHaveBeenCalledExactlyOnceWith(SUBJECT);
    expect(value.core.getDeliveryReceipt(accepted.messageId, LOCAL)?.failure?.code).toBe(
      'at_capacity'
    );
  }
);

it('late success after close cannot overwrite unknown or mutate a successor observation', async () => {
  const value = setup();
  const accepted = await value.core.publish(SUBJECT, 'x', options());
  await value.core.close();
  const next = setup(value.database);
  expect(next.core.getDeliveryReceipt(accepted.messageId, LOCAL)?.state).toBe('outcome_unknown');
  value.delivery.resolve({ success: true });
  await settleReaction();
  expect(next.core.getDeliveryReceipt(accepted.messageId, LOCAL)?.state).toBe('outcome_unknown');
  expect(next.registry.deliver).not.toHaveBeenCalled();
});

it('late actual success after physical receipt prune cannot recreate the expired locator', async () => {
  let now = 0;
  const value = setup(db(), deferred<DeliveryResult | null>(), undefined, () => now);
  const accepted = await value.core.publish(SUBJECT, 'x', options());
  now = 604800000;
  expect(value.store.pruneExpired()).toBe(1);
  value.delivery.resolve({ success: true });
  await settleReaction();
  expect(value.core.getDeliveryReceipt(accepted.messageId, LOCAL)).toBeNull();
  expect(
    value.database.$client.prepare('SELECT count(*) FROM relay_delivery_receipts').pluck().get()
  ).toBe(0);
  expect(value.registry.deliver).toHaveBeenCalledTimes(1);
});
